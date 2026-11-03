package web

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lsegroup/mnemosyne/admin-go/internal/audit"
	"github.com/lsegroup/mnemosyne/admin-go/internal/config"
	"github.com/lsegroup/mnemosyne/admin-go/internal/license"
	"github.com/lsegroup/mnemosyne/admin-go/internal/secrets"
	"github.com/lsegroup/mnemosyne/admin-go/internal/store"
)

const testSecret = "a-test-secret-with-enough-length"

// harness is a Go admin in front of a fake Node server, with a fake GitLab and a fake LLM provider.
type harness struct {
	t        *testing.T
	srv      *Server
	ts       *httptest.Server
	base     string
	dir      string
	upstream *httptest.Server
	provider *httptest.Server

	mu        sync.Mutex
	seen      []*http.Request // what reached the Node server
	gitlab    *httptest.Server
	challenge string
	users     map[string]gitlabUser
	now       time.Time
}

type opts struct {
	env       map[string]string
	noSecret  bool
	localOnly bool
	// free leaves the harness without a licence (the free edition); by default it has one (25 seats)
	free bool
}

func newHarness(t *testing.T, o opts) *harness {
	t.Helper()
	h := &harness{t: t, dir: t.TempDir(), now: time.Now(), users: map[string]gitlabUser{
		"admin-code": {Username: "store", Name: "Example Admin", Email: "store@example.com", State: "active", IsAdmin: true},
		"dev-code":   {Username: "dev", Name: "Some Dev", Email: "dev@example.com", State: "active"},
	}}

	h.upstream = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		r2 := r.Clone(r.Context())
		r2.Body = io.NopCloser(strings.NewReader(string(body)))
		h.mu.Lock()
		h.seen = append(h.seen, r2)
		h.mu.Unlock()
		w.Header().Set("X-From", "node")
		_, _ = w.Write([]byte("node says " + r.Method + " " + r.URL.RequestURI() + " body=" + string(body)))
	}))
	t.Cleanup(h.upstream.Close)

	h.gitlab = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/oauth/token":
			_ = r.ParseForm()
			sum := sha256.Sum256([]byte(r.PostForm.Get("code_verifier")))
			code := r.PostForm.Get("code")
			h.mu.Lock()
			user, ok := h.users[code]
			challengeOK := base64.RawURLEncoding.EncodeToString(sum[:]) == h.challenge
			h.mu.Unlock()
			if r.PostForm.Get("client_secret") != "csecret" || !ok || !challengeOK {
				w.WriteHeader(400)
				_, _ = w.Write([]byte(`{"error":"invalid_grant"}`))
				return
			}
			_ = user
			_, _ = w.Write([]byte(`{"access_token":"` + code + `","refresh_token":"` + code + `"}`))
		case "/api/v4/user":
			tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
			h.mu.Lock()
			user, ok := h.users[tok]
			h.mu.Unlock()
			if !ok {
				w.WriteHeader(401)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"username": user.Username, "name": user.Name, "email": user.Email, "state": user.State, "is_admin": user.IsAdmin})
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(h.gitlab.Close)

	h.provider = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			w.WriteHeader(404)
			return
		}
		if r.Header.Get("Authorization") != "Bearer sk-test-key-1234567890" {
			w.WriteHeader(401)
			return
		}
		_, _ = w.Write([]byte(`{"data":[{"id":"zeta-1"},{"id":"alpha-2"},{"id":"models/beta-3"},{"id":"alpha-2"}]}`))
	}))
	t.Cleanup(h.provider.Close)

	h.ts = httptest.NewUnstartedServer(nil)
	origin := "http://" + h.ts.Listener.Addr().String()
	env := map[string]string{
		"MNEMOSYNE_REPO":                 h.dir,
		"MNEMOSYNE_PUBLIC_URL":           origin,
		"MNEMOSYNE_UPSTREAM":             h.upstream.URL,
		"MNEMOSYNE_GITLAB_URL":           h.gitlab.URL,
		"MNEMOSYNE_GITLAB_CLIENT_ID":     "cid",
		"MNEMOSYNE_GITLAB_CLIENT_SECRET": "csecret",
		"MNEMOSYNE_ALIAS_HOSTS":          "Old-Name.example.test",
	}
	if !o.noSecret {
		env["MNEMOSYNE_SECRET"] = testSecret
	}
	if o.localOnly {
		delete(env, "MNEMOSYNE_GITLAB_URL")
		delete(env, "MNEMOSYNE_GITLAB_CLIENT_ID")
		delete(env, "MNEMOSYNE_GITLAB_CLIENT_SECRET")
	}
	for k, v := range o.env {
		env[k] = v
	}
	cfg, err := config.Load(func(k string) string { return env[k] }, h.dir)
	if err != nil {
		t.Fatal(err)
	}
	h.srv, err = New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if h.srv.configured && !o.free {
		h.licence(t) // the harness is the licensed edition unless a test asks for the free one
	}
	h.srv.now = func() time.Time { return h.now }
	h.ts.Config.Handler = h.srv
	h.ts.Start()
	t.Cleanup(h.ts.Close)
	h.base = h.ts.URL + cfg.BasePath
	return h
}

type reply struct {
	status  int
	header  http.Header
	body    string
	cookies string
}

func (r reply) json(t *testing.T) map[string]any {
	t.Helper()
	out := map[string]any{}
	if err := json.Unmarshal([]byte(r.body), &out); err != nil {
		t.Fatalf("not JSON (%d): %s", r.status, r.body)
	}
	return out
}

type call struct {
	method  string
	path    string
	cookie  string
	body    string
	headers map[string]string
}

func (h *harness) do(c call) reply {
	h.t.Helper()
	method := c.method
	if method == "" {
		method = http.MethodGet
	}
	req, _ := http.NewRequest(method, h.base+c.path, strings.NewReader(c.body))
	if c.cookie != "" {
		req.Header.Set("Cookie", c.cookie)
	}
	for k, v := range c.headers {
		req.Header.Set(k, v)
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	var cookies []string
	for _, c := range res.Header.Values("Set-Cookie") {
		if kv := strings.SplitN(c, ";", 2)[0]; !strings.HasSuffix(kv, "=") {
			cookies = append(cookies, kv)
		}
	}
	return reply{status: res.StatusCode, header: res.Header, body: string(raw), cookies: strings.Join(cookies, "; ")}
}

// api is a state-changing admin API call from our own page.
func (h *harness) api(cookie, method, path, body string) reply {
	return h.do(call{method: method, path: "/admin/api" + path, cookie: cookie, body: body, headers: map[string]string{
		"X-Requested-With": "mnemosyne-admin", "Content-Type": "application/json", "Origin": strings.TrimSuffix(h.base, h.srv.cfg.BasePath),
	}})
}

// adminCookie signs in through GitLab and returns the session cookie.
func (h *harness) ssoCookie(code string) (string, reply) {
	h.t.Helper()
	login := h.do(call{path: "/admin/auth/login"})
	if login.status != 302 {
		h.t.Fatalf("login: %d %s", login.status, login.body)
	}
	loc, _ := url.Parse(login.header.Get("Location"))
	state := loc.Query().Get("state")
	h.mu.Lock()
	h.challenge = loc.Query().Get("code_challenge")
	h.mu.Unlock()
	cb := h.do(call{path: "/admin/auth/callback?code=" + code + "&state=" + state, cookie: login.cookies})
	return cb.cookies, cb
}

// localCookie signs in with the built-in account.
func (h *harness) localCookie(user, password string) (string, reply) {
	form := url.Values{"username": {user}, "password": {password}}.Encode()
	r := h.do(call{method: "POST", path: "/admin/auth/local", body: form, headers: map[string]string{"Content-Type": "application/x-www-form-urlencoded"}})
	return r.cookies, r
}

func withLocal(extra map[string]string) opts {
	hash, _ := secrets.HashPassword("correct horse")
	env := map[string]string{"MNEMOSYNE_LOCAL_ADMIN_USER": "Admin", "MNEMOSYNE_LOCAL_ADMIN_PASSWORD_HASH": hash}
	for k, v := range extra {
		env[k] = v
	}
	return opts{env: env}
}

func has(t *testing.T, s, want string) {
	t.Helper()
	if !strings.Contains(s, want) {
		t.Errorf("expected %q in:\n%.600s", want, s)
	}
}

func lacks(t *testing.T, s, bad string) {
	t.Helper()
	if strings.Contains(s, bad) {
		t.Errorf("did not expect %q in:\n%.600s", bad, s)
	}
}

func eq[T comparable](t *testing.T, got, want T, what string) {
	t.Helper()
	if got != want {
		t.Errorf("%s: got %v, want %v", what, got, want)
	}
}

// ---- the proxy ------------------------------------------------------------------------------------------------------

func TestEverythingElseGoesToTheNodeServer(t *testing.T) {
	h := newHarness(t, opts{})
	r := h.do(call{path: "/p/alpha?x=1"})
	eq(t, r.status, 200, "status")
	has(t, r.body, "node says GET /mnemosyne/p/alpha?x=1")
	eq(t, r.header.Get("X-From"), "node", "answered by Node")

	r = h.do(call{method: "POST", path: "/mcp", body: `{"jsonrpc":"2.0"}`, headers: map[string]string{"X-Forwarded-For": "203.0.113.7", "Authorization": "Bearer mnm_x"}})
	has(t, r.body, `node says POST /mnemosyne/mcp body={"jsonrpc":"2.0"}`)
	h.mu.Lock()
	defer h.mu.Unlock()
	last := h.seen[len(h.seen)-1]
	eq(t, last.Header.Get("X-Forwarded-For"), "203.0.113.7", "the gateway's X-Forwarded-For is passed on unchanged")
	eq(t, last.Header.Get("Authorization"), "Bearer mnm_x", "the token reaches Node")
	eq(t, last.Host, strings.TrimPrefix(h.ts.URL, "http://"), "the Host header is kept")
	first := h.seen[0]
	if first.Header.Get("X-Forwarded-For") == "" {
		t.Error("a call without a gateway gets its own address as X-Forwarded-For")
	}
}

func TestAnUnreachableNodeServerIsABadGateway(t *testing.T) {
	h := newHarness(t, opts{})
	h.upstream.Close()
	r := h.do(call{path: "/health"})
	eq(t, r.status, 502, "status")
}

// ---- sign-in --------------------------------------------------------------------------------------------------------

func TestAnonymousVisitorsGetTheSignInPage(t *testing.T) {
	h := newHarness(t, withLocal(nil))
	r := h.do(call{path: "/admin/"})
	eq(t, r.status, 200, "status")
	has(t, r.body, "Administration")
	has(t, r.body, `action="/mnemosyne/admin/auth/local"`)
	has(t, r.body, "or GitLab admin")
	has(t, r.body, `href="/mnemosyne/admin/auth/login"`)
	has(t, r.body, "LSE Group Corporation")
	lacks(t, r.body, "@@")
	has(t, r.header.Get("Content-Security-Policy"), "script-src 'none'")
	eq(t, r.header.Get("Cache-Control"), "no-store", "cache")

	r = h.do(call{path: "/admin?error=noadmin"})
	has(t, r.body, "Only GitLab administrators may open the admin area.")
	r = h.do(call{path: "/admin?error=<script>"})
	lacks(t, r.body, "<script>alert")
	lacks(t, r.body, `class="notice error"`)
}

func TestWithoutASecretNothingCanSignIn(t *testing.T) {
	h := newHarness(t, opts{noSecret: true})
	r := h.do(call{path: "/admin/"})
	has(t, r.body, "Sign-in is not configured on this server yet.")
	r = h.api("", "GET", "/providers", "")
	eq(t, r.status, 401, "status")
	r = h.do(call{path: "/admin/auth/login"})
	eq(t, r.status, 302, "login redirects back")
	eq(t, r.header.Get("Location"), "/mnemosyne/admin/", "where")
}

func TestTheBuiltInAccountSignsInAndOut(t *testing.T) {
	h := newHarness(t, withLocal(nil))

	_, wrong := h.localCookie("Admin", "nope")
	eq(t, wrong.status, 302, "wrong password status")
	eq(t, wrong.header.Get("Location"), "/mnemosyne/admin/?error=local", "wrong password goes back")
	_, wrongUser := h.localCookie("nobody", "correct horse")
	eq(t, wrongUser.header.Get("Location"), "/mnemosyne/admin/?error=local", "a wrong user name costs the same")

	cookie, ok := h.localCookie("admin", "correct horse") // the user name is not case sensitive
	eq(t, ok.status, 303, "success status")
	has(t, cookie, "mnemosyne_admin=")
	has(t, strings.Join(ok.header.Values("Set-Cookie"), "\n"), "Path=/mnemosyne/admin;")
	has(t, strings.Join(ok.header.Values("Set-Cookie"), "\n"), "HttpOnly; SameSite=Lax")

	page := h.do(call{path: "/admin/", cookie: cookie})
	eq(t, page.status, 200, "admin page")
	has(t, page.body, "Built-in admin account")
	has(t, page.body, "cannot hold an MCP token")
	lacks(t, page.body, "/profile")
	lacks(t, page.body, "@@")
	has(t, page.header.Get("Content-Security-Policy"), "script-src 'nonce-")
	has(t, page.body, "LSE Group Corporation")
	has(t, page.body, "<code>"+h.srv.cfg.PublicURL+"/mnemosyne/auth/callback</code>")

	out := h.do(call{method: "POST", path: "/admin/auth/logout", cookie: cookie})
	eq(t, out.status, 303, "logout")
	has(t, strings.Join(out.header.Values("Set-Cookie"), "\n"), "mnemosyne_admin=; Path=/mnemosyne/admin; Max-Age=0")
}

func TestTooManyWrongPasswordsLockTheAddressOutForAMinute(t *testing.T) {
	h := newHarness(t, withLocal(nil))
	for i := 0; i < 5; i++ {
		h.localCookie("Admin", "wrong")
	}
	_, r := h.localCookie("Admin", "correct horse")
	eq(t, r.header.Get("Location"), "/mnemosyne/admin/?error=throttled", "locked out even with the right password")
	h.now = h.now.Add(61 * time.Second)
	_, r = h.localCookie("Admin", "correct horse")
	eq(t, r.status, 303, "a minute later it works again")
}

func TestGitLabAdministratorsSignInWithPKCE(t *testing.T) {
	h := newHarness(t, withLocal(nil))
	cookie, cb := h.ssoCookie("admin-code")
	eq(t, cb.status, 302, "callback status")
	eq(t, cb.header.Get("Location"), "/mnemosyne/admin/", "callback destination")
	page := h.do(call{path: "/admin/", cookie: cookie})
	has(t, page.body, "Example Admin")
	has(t, page.body, "@store")
	has(t, page.body, "GitLab administrator")
	has(t, page.body, `href="/mnemosyne/profile">Profile</a>`)
	has(t, page.body, `<span class="avatar" aria-hidden="true">EA</span>`)

	// the session is what the Node server writes and reads
	c, _ := h.do(call{path: "/admin/", cookie: cookie}), 0
	_ = c
	var sess secrets.Session
	raw := strings.TrimPrefix(cookie, "mnemosyne_admin=")
	if !secrets.VerifyToken(h.srv.keys.Sign, raw, h.now, &sess) {
		t.Fatal("the session cookie does not verify")
	}
	eq(t, sess.U, "store", "username")
	eq(t, sess.N, "Example Admin", "name")
	eq(t, sess.E, "store@example.com", "e-mail")
	eq(t, sess.L, false, "not a local session")
	eq(t, sess.Exp, h.now.Unix()+8*3600, "lives eight hours")
}

func TestOnlyGitLabAdministratorsGetIn(t *testing.T) {
	h := newHarness(t, opts{})
	_, cb := h.ssoCookie("dev-code")
	eq(t, cb.header.Get("Location"), "/mnemosyne/admin/?error=noadmin", "a plain member")
	_, cb = h.ssoCookie("nobody-code")
	eq(t, cb.header.Get("Location"), "/mnemosyne/admin/?error=gitlab", "an unknown code")

	// a callback with a wrong state, or without the cookie of this attempt
	login := h.do(call{path: "/admin/auth/login"})
	cb = h.do(call{path: "/admin/auth/callback?code=admin-code&state=wrong", cookie: login.cookies})
	eq(t, cb.header.Get("Location"), "/mnemosyne/admin/?error=state", "bad state")
	cb = h.do(call{path: "/admin/auth/callback?code=admin-code&state=x"})
	eq(t, cb.header.Get("Location"), "/mnemosyne/admin/?error=state", "no cookie")

	events, _, _ := h.srv.audit.List("", 0, 0)
	if len(events) < 3 {
		t.Fatalf("expected the refusals in the audit trail, got %d events", len(events))
	}
	eq(t, events[len(events)-1].Event, "login_failed", "oldest event")
}

func TestTheBuiltInAccountStopsADayAfterSSOIsProvenLive(t *testing.T) {
	h := newHarness(t, withLocal(nil))
	before, _ := h.localCookie("Admin", "correct horse")
	eq(t, h.do(call{path: "/admin/", cookie: before}).status, 200, "before")
	has(t, h.do(call{path: "/admin/"}).body, "or GitLab admin")

	h.ssoCookie("admin-code") // the first GitLab admin sign-in proves SSO works
	st, _ := h.srv.settings.Get()
	eq(t, st.SSOLiveAt, h.now.Unix(), "ssoLiveAt")

	h.now = h.now.Add(23 * time.Hour)
	within, ok := h.localCookie("Admin", "correct horse")
	eq(t, ok.status, 303, "the built-in account still signs in within the day")
	eq(t, h.api(within, "GET", "/providers", "").status, 200, "and works")

	h.now = h.now.Add(2 * time.Hour) // 25 hours after SSO went live; the session from 23 hours is still young
	eq(t, h.api(within, "GET", "/providers", "").status, 401, "a session of the built-in account dies with the account")
	_, refused := h.localCookie("Admin", "correct horse")
	eq(t, refused.header.Get("Location"), "/mnemosyne/admin/?error=local", "no new sign-in")
	page := h.do(call{path: "/admin/", cookie: within})
	lacks(t, page.body, "Sign in</button>")
	lacks(t, page.body, "or GitLab admin")
	has(t, page.body, "Sign in with GitLab")
}

func TestTheRecoverySwitchKeepsTheBuiltInAccountAlive(t *testing.T) {
	h := newHarness(t, withLocal(map[string]string{"MNEMOSYNE_LOCAL_ADMIN_FORCE": "1"}))
	h.ssoCookie("admin-code")
	h.now = h.now.Add(48 * time.Hour)
	local, ok := h.localCookie("Admin", "correct horse")
	eq(t, ok.status, 303, "forced sign-in")
	eq(t, h.api(local, "GET", "/providers", "").status, 200, "forced")
}

func TestAPagesOpenedUnderAnotherNameOfTheServerIsMovedToThePublicName(t *testing.T) {
	h := newHarness(t, opts{})
	r := h.do(call{path: "/admin/?x=1", headers: map[string]string{"X-Forwarded-Host": "old-name.example.test:40000"}})
	eq(t, r.status, 302, "status")
	eq(t, r.header.Get("Location"), h.srv.cfg.PublicURL+"/mnemosyne/admin/?x=1", "location")
	r = h.do(call{path: "/admin/", headers: map[string]string{"X-Forwarded-Host": "evil.example.com"}})
	eq(t, r.status, 200, "a stranger's host name is never copied into a redirect")
}

// ---- the admin API --------------------------------------------------------------------------------------------------

func TestTheAdminAPIIsClosedToStrangersAndToCrossSiteCalls(t *testing.T) {
	h := newHarness(t, withLocal(nil))
	eq(t, h.api("", "GET", "/providers", "").status, 401, "anonymous")
	eq(t, h.api("mnemosyne_admin=garbage", "GET", "/audit", "").status, 401, "garbage cookie")
	cookie, _ := h.localCookie("Admin", "correct horse")

	r := h.do(call{method: "POST", path: "/admin/api/providers", cookie: cookie, body: `{}`})
	eq(t, r.status, 403, "no same-origin marker")
	r = h.do(call{method: "POST", path: "/admin/api/providers", cookie: cookie, body: `{}`, headers: map[string]string{"X-Requested-With": "mnemosyne-admin", "Origin": "https://evil.example"}})
	eq(t, r.status, 403, "foreign origin")
	events, _, _ := h.srv.audit.List("cross-site", 0, 0)
	if len(events) != 2 {
		t.Errorf("both refusals are audited, got %d", len(events))
	}
	eq(t, h.do(call{path: "/admin/api/providers", cookie: cookie}).status, 200, "a GET needs no marker")
}

func TestProvidersModelsAndJobsFollowTheAdminFlow(t *testing.T) {
	h := newHarness(t, withLocal(nil))
	cookie, _ := h.localCookie("Admin", "correct horse")
	api := func(method, path, body string) reply { return h.api(cookie, method, path, body) }

	// validation
	for body, want := range map[string]string{
		`{"kind":"openai-compatible","baseUrl":"` + h.provider.URL + `/v1","apiKey":"k"}`:            "name is required",
		`{"label":"P","kind":"mystery","baseUrl":"` + h.provider.URL + `/v1","apiKey":"k"}`:          "API format must be openai-compatible or anthropic-messages",
		`{"label":"P","kind":"openai-compatible","baseUrl":"ftp://x","apiKey":"k"}`:                  "base URL must be http(s)",
		`{"label":"P","kind":"openai-compatible","baseUrl":"nonsense","apiKey":"k"}`:                 "base URL is not a valid URL",
		`{"label":"P","kind":"openai-compatible","baseUrl":"` + h.provider.URL + `/v1","apiKey":""}`: "API key is required",
	} {
		r := api("POST", "/providers", body)
		eq(t, r.status, 400, "status for "+want)
		eq(t, r.json(t)["error"], any(want), "message")
	}

	// connect, never show the key
	r := api("POST", "/providers", `{"label":"Fake LLM","kind":"openai-compatible","baseUrl":"`+h.provider.URL+`/v1/","apiKey":"sk-test-key-1234567890"}`)
	eq(t, r.status, 200, "create")
	made := r.json(t)
	id := made["id"].(string)
	eq(t, made["hasKey"], any(true), "hasKey")
	eq(t, made["keyHint"], any("••••7890"), "keyHint")
	eq(t, made["baseUrl"], any(h.provider.URL+"/v1"), "trailing slash removed")
	lacks(t, r.body, "sk-test-key")
	list := api("GET", "/providers", "")
	lacks(t, list.body, "sk-test-key")
	has(t, list.body, `"assignments":{}`)

	// the model list: the provider's own list call
	r = api("POST", "/providers/"+id+"/models", "")
	eq(t, r.status, 200, "models")
	eq(t, strings.Join(toStrings(r.json(t)["models"]), ","), "alpha-2,beta-3,zeta-1", "sorted, unique, prefix removed")
	r = api("POST", "/providers/nope/models", "")
	eq(t, r.json(t)["error"], any("unknown provider id"), "unknown provider")

	// a job: one model from the list, its limits and prompts
	r = api("PUT", "/llm/jobs/text", `{"model":{"providerId":"`+id+`","model":"mystery"},"maxTokens":1000}`)
	eq(t, r.json(t)["error"], any("text: model is not one of the models this provider reported"), "model not reported")
	r = api("PUT", "/llm/jobs/text", `{"model":{"providerId":"`+id+`","model":"alpha-2"},"maxTokens":"1,000","reasoningEffort":"low","temperature":0.2}`)
	eq(t, r.status, 400, "a decimal comma is not a thousands separator")
	r = api("PUT", "/llm/jobs/text", `{"model":{"providerId":"`+id+`","model":"alpha-2"},"maxTokens":12345,"reasoningEffort":"low","temperature":0.2,"userPrompt":"Write {{notes}} and {{unknown}}"}`)
	has(t, r.json(t)["error"].(string), "Unknown placeholder {{unknown}}")
	r = api("PUT", "/llm/jobs/text", `{"model":{"providerId":"`+id+`","model":"alpha-2"},"maxTokens":12345,"reasoningEffort":"ludicrous"}`)
	has(t, r.json(t)["error"].(string), "Reasoning effort must be one of minimal, low, medium, high")
	r = api("PUT", "/llm/jobs/text", `{"model":{"providerId":"`+id+`","model":"alpha-2"},"maxTokens":12345,"reasoningEffort":"low","temperature":0.2,"timeoutMinutes":7}`)
	eq(t, r.status, 200, "job saved")
	text := r.json(t)["jobs"].(map[string]any)["text"].(map[string]any)
	eq(t, text["effective"].(map[string]any)["maxTokens"], any(float64(12345)), "effective maxTokens")
	eq(t, text["effective"].(map[string]any)["reasoningEffort"], any("low"), "effective reasoning effort")
	eq(t, text["settings"].(map[string]any)["timeoutMinutes"], any(float64(7)), "stored timeout")
	eq(t, text["assignment"].(map[string]any)["model"], any("alpha-2"), "assignment")
	if !strings.HasPrefix(r.body, `{"jobs":{"text":`) || strings.Index(r.body, `"image":`) > strings.Index(r.body, `"pdf":`) {
		t.Errorf("the jobs come as text, image, pdf: %.200s", r.body)
	}
	def := text["def"].(map[string]any)
	eq(t, def["title"], any("Text"), "definition title")
	has(t, def["defaults"].(map[string]any)["userPrompt"].(string), "{{notes}}")

	// a value equal to the default is not stored, a blank prompt means the default
	r = api("PUT", "/llm/jobs/text", `{"model":{"providerId":"`+id+`","model":"alpha-2"},"maxTokens":50000,"userPrompt":"  "}`)
	eq(t, r.status, 200, "defaults")
	stored := api("GET", "/providers", "").json(t)["jobs"].(map[string]any)
	eq(t, len(stored), 0, "nothing stored for defaults")

	// models per job
	r = api("PUT", "/llm/assignments", `{"text":{"providerId":"`+id+`","model":"zeta-1"},"image":{"providerId":"`+id+`","model":"nope"}}`)
	eq(t, r.status, 400, "assignment with an unreported model")
	r = api("PUT", "/llm/assignments", `{"text":{"providerId":"`+id+`","model":"zeta-1"}}`)
	eq(t, r.status, 200, "assignments")
	eq(t, r.json(t)["text"].(map[string]any)["model"], any("zeta-1"), "chosen")

	// a changed endpoint forgets the models and the choices made from them
	r = api("POST", "/providers", `{"id":"`+id+`","label":"Fake LLM","kind":"openai-compatible","baseUrl":"`+h.provider.URL+`/v2"}`)
	eq(t, r.status, 200, "update")
	eq(t, len(r.json(t)["models"].([]any)), 0, "models forgotten")
	eq(t, len(api("GET", "/providers", "").json(t)["assignments"].(map[string]any)), 0, "choices dropped")

	// remove
	eq(t, api("DELETE", "/providers/"+id, "").status, 200, "delete")
	eq(t, len(api("GET", "/providers", "").json(t)["providers"].([]any)), 0, "gone")

	// every change is in the audit trail, never the key
	audit := api("GET", "/audit", "")
	lacks(t, audit.body, "sk-test-key")
	has(t, audit.body, "LLM provider connected")
	has(t, audit.body, "Fetched 3 models from the provider")
	has(t, audit.body, "AI job “Text”: model, limits and prompts saved")
	has(t, audit.body, `+ apiKey: \"••••\" (new key stored)`)
}

func toStrings(v any) []string {
	var out []string
	for _, x := range v.([]any) {
		out = append(out, x.(string))
	}
	return out
}

func TestAProviderThatRefusesTheKeyIsReportedAndAudited(t *testing.T) {
	h := newHarness(t, withLocal(nil))
	cookie, _ := h.localCookie("Admin", "correct horse")
	r := h.api(cookie, "POST", "/providers", `{"label":"Bad key","kind":"openai-compatible","baseUrl":"`+h.provider.URL+`/v1","apiKey":"wrong-key"}`)
	id := r.json(t)["id"].(string)
	r = h.api(cookie, "POST", "/providers/"+id+"/models", "")
	eq(t, r.status, 400, "status")
	eq(t, r.json(t)["error"], any("The provider rejected the API key (HTTP 401)."), "message")
	has(t, h.api(cookie, "GET", "/audit?q=fetch_failed", "").body, "The provider rejected the API key")

	r = h.api(cookie, "POST", "/providers", `{"label":"Nowhere","kind":"openai-compatible","baseUrl":"http://127.0.0.1:1/v1","apiKey":"k"}`)
	id = r.json(t)["id"].(string)
	r = h.api(cookie, "POST", "/providers/"+id+"/models", "")
	eq(t, r.json(t)["error"], any("Could not reach the provider (check the base URL and network)."), "unreachable")
}

func TestFixedAddresses(t *testing.T) {
	h := newHarness(t, withLocal(nil))
	cookie, _ := h.localCookie("Admin", "correct horse")
	api := func(method, path, body string) reply { return h.api(cookie, method, path, body) }

	for body, want := range map[string]string{
		`{"hosts":"x"}`:                                                                                "hosts must be a list",
		`{"hosts":[{"host":"","ip":"1.2.3.4"}]}`:                                                       "row 1: the host name is empty",
		`{"hosts":[{"host":"http://x.com","ip":"1.2.3.4"}]}`:                                           `row 1: "http://x.com" is not a host name (letters, digits, dots and dashes only; no http://, no port, no path)`,
		`{"hosts":[{"host":"1.2.3.4","ip":"1.2.3.4"}]}`:                                                `row 1: "1.2.3.4" is already an IP address; put the host name there`,
		`{"hosts":[{"host":"a.example.com","ip":""}]}`:                                                 "row 1: the IP address for a.example.com is empty",
		`{"hosts":[{"host":"a.example.com","ip":"nope"}]}`:                                             `row 1: "nope" is not an IPv4 or IPv6 address`,
		`{"hosts":[{"host":"a.example.com","ip":"0.0.0.0"}]}`:                                          "row 1: 0.0.0.0 cannot be connected to",
		`{"hosts":[{"host":"a.example.com","ip":"1.2.3.4"},{"host":"A.Example.com.","ip":"1.2.3.5"}]}`: "row 2: a.example.com is listed twice",
	} {
		r := api("PUT", "/llm/hosts", body)
		eq(t, r.status, 400, "status for "+want)
		eq(t, r.json(t)["error"], any(want), "message")
	}
	r := api("PUT", "/llm/hosts", `{"hosts":[{"host":" API.Example.com. ","ip":"203.0.113.9"}]}`)
	eq(t, r.status, 200, "saved")
	hosts := r.json(t)["hosts"].([]any)
	eq(t, hosts[0].(map[string]any)["host"], any("api.example.com"), "normalised")
	has(t, api("GET", "/audit", "").body, "Fixed addresses saved: api.example.com → 203.0.113.9")

	// a check of an address nobody answers on reports a failure in plain words and sends no request
	r = api("POST", "/llm/hosts/check", `{"host":"api.example.com","ip":"127.0.0.1"}`)
	eq(t, r.status, 200, "check")
	eq(t, r.json(t)["ok"], any(false), "no certificate on 127.0.0.1:443")
	r = api("PUT", "/llm/hosts", `{"hosts":[]}`)
	has(t, api("GET", "/audit", "").body, "Fixed addresses removed: DNS is asked as usual")
	if h.srv.providers == nil {
		t.Fatal("providers store")
	}
}

func TestSSOSettingsNeverShowTheSecretAndKeepItWhenLeftEmpty(t *testing.T) {
	h := newHarness(t, withLocal(nil))
	cookie, _ := h.localCookie("Admin", "correct horse")
	got := h.api(cookie, "GET", "/settings", "").json(t)
	eq(t, got["gitlabUrl"], any(h.gitlab.URL), "from the environment")
	eq(t, got["hasSecret"], any(true), "hasSecret")
	eq(t, got["secretHint"], any("••••"), "a short secret is only dots")
	eq(t, got["ssoActive"], any(true), "ssoActive")
	eq(t, got["localUser"], any("Admin"), "localUser")
	uris := toStrings(got["redirectUris"])
	eq(t, uris[0], h.srv.cfg.PublicURL+"/mnemosyne/auth/callback", "public callback")
	eq(t, uris[1], h.srv.cfg.PublicURL+"/mnemosyne/admin/auth/callback", "admin callback")

	r := h.api(cookie, "PUT", "/settings", `{"gitlabUrl":"nonsense","clientId":"x"}`)
	eq(t, r.json(t)["error"], any("GitLab URL is not a valid URL"), "invalid url")
	r = h.api(cookie, "PUT", "/settings", `{"gitlabUrl":"ftp://x","clientId":"x"}`)
	eq(t, r.json(t)["error"], any("GitLab URL must be http(s)"), "scheme")

	r = h.api(cookie, "PUT", "/settings", `{"gitlabUrl":"https://gitlab.example.com/","clientId":"app-id","clientSecret":"a-long-secret-value-0123456789"}`)
	eq(t, r.status, 200, "saved")
	got = h.api(cookie, "GET", "/settings", "").json(t)
	eq(t, got["gitlabUrl"], any("https://gitlab.example.com"), "saved url wins, no trailing slash")
	eq(t, got["clientId"], any("app-id"), "saved id")
	eq(t, got["secretHint"], any("••••6789"), "hint")
	lacks(t, h.api(cookie, "GET", "/settings", "").body, "a-long-secret-value")

	h.api(cookie, "PUT", "/settings", `{"gitlabUrl":"https://gitlab.example.com","clientId":"app-id","clientSecret":""}`)
	st, _ := h.srv.settings.Get()
	eq(t, st.GitLab.ClientSecret, "a-long-secret-value-0123456789", "an empty secret keeps the stored one")
	a := h.api(cookie, "GET", "/audit?q=sso", "").body
	has(t, a, "GitLab SSO settings saved (active)")
	lacks(t, a, "a-long-secret-value")
}

func TestTheAuditTrailListsNewestFirstAndSearches(t *testing.T) {
	h := newHarness(t, withLocal(nil))
	cookie, _ := h.localCookie("Admin", "correct horse")
	for i := 0; i < 3; i++ {
		h.srv.audit.Write(audit.Input{Event: "update", EntityType: "demo", EntityName: "item " + string(rune('A'+i)), User: "someone", Description: "touched"})
	}
	all := h.api(cookie, "GET", "/audit", "").json(t)
	events := all["events"].([]any)
	eq(t, events[0].(map[string]any)["entityName"], any("item C"), "newest first")
	eq(t, all["total"], any(float64(4)), "three demo events and the login")
	hit := h.api(cookie, "GET", "/audit?q=ITEM%20b", "").json(t)
	eq(t, hit["total"], any(float64(1)), "case-insensitive search")
	page := h.api(cookie, "GET", "/audit?offset=1&limit=2", "").json(t)
	eq(t, len(page["events"].([]any)), 2, "paging")
	eq(t, h.api(cookie, "GET", "/audit?q=zzz-nothing", "").json(t)["total"], any(float64(0)), "no hit")
	has(t, h.api(cookie, "GET", "/audit?q=zzz-nothing", "").body, `"events":[]`)
}

func TestAnAdminAPIPathTheAdminDoesNotKnowGoesToTheNodeServer(t *testing.T) {
	h := newHarness(t, withLocal(nil))
	cookie, _ := h.localCookie("Admin", "correct horse")
	r := h.api(cookie, "GET", "/something-new", "")
	has(t, r.body, "node says GET /mnemosyne/admin/api/something-new")
	h.mu.Lock()
	defer h.mu.Unlock()
	last := h.seen[len(h.seen)-1]
	has(t, last.Header.Get("Cookie"), "mnemosyne_admin=")
}

// ---- the sealed files are shared with the Node server -----------------------------------------------------------------

func TestTheFilesTheAdminWritesAreSealedLikeTheNodeServersAndSurviveARestart(t *testing.T) {
	h := newHarness(t, withLocal(nil))
	cookie, _ := h.localCookie("Admin", "correct horse")
	h.api(cookie, "POST", "/providers", `{"label":"Fake","kind":"anthropic-messages","baseUrl":"https://api.example.com","apiKey":"sk-secret-value-0123456789"}`)
	h.api(cookie, "PUT", "/settings", `{"gitlabUrl":"https://gitlab.example.com","clientId":"id","clientSecret":"gl-secret-value"}`)
	for _, f := range []string{h.srv.cfg.ProvidersFile, h.srv.cfg.SettingsFile} {
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(string(raw), "v1.") || strings.Contains(string(raw), "sk-secret") || strings.Contains(string(raw), "gl-secret") {
			t.Errorf("%s is not sealed: %.60s", filepath.Base(f), raw)
		}
		if _, err := secrets.Open(h.srv.keys.Enc, strings.TrimSpace(string(raw))); err != nil {
			t.Errorf("%s does not open: %v", filepath.Base(f), err)
		}
	}
	// a second Go admin on the same files (a restart) sees everything
	again, err := New(h.srv.cfg)
	if err != nil {
		t.Fatal(err)
	}
	list, err := again.providers.List()
	if err != nil || len(list.Providers) != 1 || list.Providers[0].KeyHint != "••••6789" {
		t.Fatalf("after a restart: %+v, %v", list, err)
	}
}

// licence gives the harness a licensed edition: a licence key confirmed by a licence server that signs its answers.
func (h *harness) licence(t *testing.T) {
	t.Helper()
	ls := newLicenceServer(t, time.Now)
	m, err := license.New(license.Options{
		Store: store.NewLicense(filepath.Join(h.dir, "lic-harness.enc"), h.srv.keys.Enc), Server: ls.srv.URL, PublicKey: ls.pub, Domain: "127.0.0.1",
		Version: "test", SeatsUsed: h.srv.seats.Count, FreeWithoutKey: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.Activate(context.Background(), ls.goodKey); err != nil {
		t.Fatal(err)
	}
	h.srv.SetLicense(m)
}
