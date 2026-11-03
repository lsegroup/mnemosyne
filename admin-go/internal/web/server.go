// SPDX-License-Identifier: Apache-2.0

// Package web is the Go admin: everything behind /mnemosyne/admin (sign-in, the admin page and its JSON API) and, in front of the
// Node server, the reverse proxy for everything else. Same cookies, same keys and same sealed files as the Node server, so a person
// signed in before the move stays signed in and no setting is lost.
package web

import (
	"bytes"
	"compress/gzip"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/lsegroup/mnemosyne/admin-go/internal/assets"
	"github.com/lsegroup/mnemosyne/admin-go/internal/audit"
	"github.com/lsegroup/mnemosyne/admin-go/internal/config"
	"github.com/lsegroup/mnemosyne/admin-go/internal/jobs"
	"github.com/lsegroup/mnemosyne/admin-go/internal/license"
	"github.com/lsegroup/mnemosyne/admin-go/internal/llm"
	"github.com/lsegroup/mnemosyne/admin-go/internal/secrets"
	"github.com/lsegroup/mnemosyne/admin-go/internal/store"
	"github.com/lsegroup/mnemosyne/admin-go/internal/usage"
)

const (
	adminCookie       = "mnemosyne_admin"
	adminOAuthCookie  = "mnemosyne_admin_oauth"
	sessionTTL        = 8 * 3600
	oauthTTL          = 10 * 60
	gitlabTimeout     = 10 * time.Second
	localAdminGrace   = 24 * 3600
	maxBody           = 2 << 20
	adminAPIMarker    = "mnemosyne-admin"
	lockoutMisses     = 5
	lockoutDuration   = time.Minute
	pinCheckTimeout   = 8 * time.Second
	pinCheckPort      = "443"
	defaultAuditLimit = audit.Page
)

// Server is the Go admin.
type Server struct {
	cfg        config.Config
	configured bool
	keys       secrets.Keys
	providers  *store.Providers
	settings   *store.Settings
	audit      *audit.Log
	usage      *usage.Log
	secure     bool
	localUser  string
	localHash  string
	canonical  *url.URL
	ownNames   map[string]bool
	proxy      http.Handler
	auto       *autoParts
	lic        *license.Manager
	seats      *store.Seats
	refusedMu  sync.Mutex
	refused    map[string]time.Time // when a person without a seat was last written to the audit trail
	mux        *http.ServeMux
	gitlab     *http.Client
	now        func() time.Time

	mu     sync.Mutex
	misses map[string]miss
}

type miss struct {
	n     int
	until time.Time
}

// New builds the server. Without a usable secret and public URL the portal stays "not configured": the sign-in page says so and the
// API refuses everybody, exactly like the Node server.
func New(cfg config.Config) (*Server, error) {
	s := &Server{cfg: cfg, configured: cfg.Configured(), gitlab: &http.Client{Timeout: gitlabTimeout}, now: time.Now, misses: map[string]miss{}}
	s.secure = strings.HasPrefix(cfg.PublicURL, "https://")
	if s.configured {
		keys, err := secrets.DeriveKeys(cfg.Secret)
		if err != nil {
			return nil, err
		}
		s.keys = keys
		s.providers = store.NewProviders(cfg.ProvidersFile, keys.Enc)
		s.settings = store.NewSettings(cfg.SettingsFile, keys.Enc)
		s.audit = audit.New(cfg.AuditFile)
		s.usage = usage.New(cfg.UsageFile)
		s.initLicense()
		// fixed addresses are in force from start-up on
		if hosts, err := s.providers.Hosts(); err == nil {
			llm.SetPins(hosts)
		} else {
			log.Printf("fixed addresses could not be loaded: %v", err)
		}
		s.localUser = strings.TrimSpace(cfg.LocalAdmin.User)
		if s.localUser == "" {
			s.localUser = "admin"
		}
		s.localHash = cfg.LocalAdmin.PasswordHash
		if s.localHash == "" && cfg.LocalAdmin.Password != "" {
			if s.localHash, err = secrets.HashPassword(cfg.LocalAdmin.Password); err != nil {
				return nil, err
			}
		}
	}
	if cfg.PublicURL != "" {
		if u, err := url.Parse(cfg.PublicURL); err == nil {
			s.canonical = u
		}
	}
	s.ownNames = map[string]bool{}
	names := append([]string{}, cfg.AliasHosts...)
	if s.canonical != nil {
		names = append(names, s.canonical.Hostname())
	}
	if cfg.GitLab.URL != "" {
		if u, err := url.Parse(cfg.GitLab.URL); err == nil {
			names = append(names, u.Hostname())
		}
	}
	for _, n := range names {
		if n != "" {
			s.ownNames[strings.ToLower(n)] = true
		}
	}
	if s.configured {
		s.startAuto()
	}
	target, err := url.Parse(cfg.Upstream)
	if err != nil {
		return nil, fmt.Errorf("upstream %q: %w", cfg.Upstream, err)
	}
	s.proxy = newProxy(target)
	s.routes()
	return s, nil
}

// StartAuto lets the scheduler look at the clock; without a configured portal there is no scheduler.
func (s *Server) StartAuto() {
	if s.auto != nil {
		s.auto.runner.Start()
	}
}

// ServeHTTP implements http.Handler.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.mux.ServeHTTP(w, r) }

func newProxy(target *url.URL) http.Handler {
	return &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			pr.Out.Host = pr.In.Host
			// The Node server trusts the LAST X-Forwarded-For entry (added by the gateway in front of us), so it is passed on unchanged.
			// Only a call that came straight to us, with no gateway in between, gets its own address as that entry.
			xff := pr.In.Header.Values("X-Forwarded-For")
			if len(xff) == 0 {
				xff = []string{audit.ClientIP(pr.In)}
			}
			pr.Out.Header["X-Forwarded-For"] = xff
			for _, h := range []string{"X-Forwarded-Host", "X-Forwarded-Proto"} {
				if v := pr.In.Header.Values(h); len(v) > 0 {
					pr.Out.Header[h] = v
				}
			}
		},
		FlushInterval: -1, // MCP answers are event streams: pass every chunk on at once
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			log.Printf("upstream: %v", err)
			http.Error(w, "Mnemosyne is not reachable right now.", http.StatusBadGateway)
		},
	}
}

func (s *Server) routes() {
	m := http.NewServeMux()
	admin := s.cfg.BasePath + "/admin"
	api := admin + "/api"
	m.Handle("/", s.gate(s.proxy))

	m.HandleFunc("GET "+admin, s.adminPage)
	m.HandleFunc("GET "+admin+"/{$}", s.adminPage)
	m.HandleFunc("GET "+admin+"/auth/login", s.ssoLogin)
	m.HandleFunc("GET "+admin+"/auth/callback", s.ssoCallback)
	m.HandleFunc("POST "+admin+"/auth/local", s.localLogin)
	m.HandleFunc("POST "+admin+"/auth/logout", s.logout)

	m.HandleFunc("GET "+api+"/providers", s.apiHandler(s.listProviders))
	m.HandleFunc("POST "+api+"/providers", s.apiHandler(s.saveProvider))
	m.HandleFunc("DELETE "+api+"/providers/{id}", s.apiHandler(s.deleteProvider))
	m.HandleFunc("POST "+api+"/providers/{id}/models", s.apiHandler(s.fetchModels))
	m.HandleFunc("GET "+api+"/llm/jobs", s.apiHandler(s.getJobs))
	m.HandleFunc("PUT "+api+"/llm/jobs/{role}", s.apiHandler(s.putJob))
	m.HandleFunc("GET "+api+"/llm/hosts", s.apiHandler(s.getHosts))
	m.HandleFunc("PUT "+api+"/llm/hosts", s.apiHandler(s.putHosts))
	m.HandleFunc("POST "+api+"/llm/hosts/check", s.apiHandler(s.checkHost))
	m.HandleFunc("PUT "+api+"/llm/assignments", s.apiHandler(s.putAssignments))
	m.HandleFunc("GET "+api+"/settings", s.apiHandler(s.getSettings))
	m.HandleFunc("PUT "+api+"/settings", s.apiHandler(s.putSettings))
	m.HandleFunc("GET "+api+"/audit", s.apiHandler(s.getAudit))
	m.HandleFunc("GET "+api+"/usage", s.apiHandler(s.getUsage))
	m.HandleFunc("GET "+api+"/auto", s.apiHandler(s.getAuto))
	m.HandleFunc("GET "+api+"/auto/status", s.apiHandler(s.getAutoStatus))
	m.HandleFunc("POST "+api+"/auto/estimate", s.apiHandler(s.estimateAuto))
	m.HandleFunc("PUT "+api+"/auto", s.apiHandler(s.saveAuto))
	m.HandleFunc("PUT "+api+"/auto/switch", s.apiHandler(s.switchAuto))
	m.HandleFunc("GET "+api+"/license", s.apiHandler(s.getLicense))
	m.HandleFunc("POST "+api+"/license/activate", s.apiHandler(s.activateLicense))
	m.HandleFunc("POST "+api+"/license/check", s.apiHandler(s.checkLicense))
	s.mux = m
}

// ---- small helpers --------------------------------------------------------------------------------------------------

func (s *Server) adminBase() string { return s.cfg.BasePath + "/admin" }

func (s *Server) here(path string) string { return s.cfg.PublicURL + s.cfg.BasePath + path }

func noStore(w http.ResponseWriter) { w.Header().Set("Cache-Control", "no-store") }

func randomB64(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// pageHeaders is the policy of every page: no external resources, scripts only with the per-response nonce.
func pageHeaders(w http.ResponseWriter, nonce string) {
	noStore(w)
	script := "'none'"
	if nonce != "" {
		script = "'nonce-" + nonce + "'"
	}
	h := w.Header()
	h.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; script-src "+script+"; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "same-origin")
	h.Set("Content-Type", "text/html; charset=utf-8")
}

// send writes a text body, gzip-compressed when the client accepts it and the body is large (the pages are large and the visitors are
// far away: every round trip costs time).
func send(w http.ResponseWriter, r *http.Request, status int, body []byte) {
	if len(body) > 1024 && strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") && w.Header().Get("Content-Encoding") == "" {
		var buf bytes.Buffer
		zw := gzip.NewWriter(&buf)
		_, _ = zw.Write(body)
		_ = zw.Close()
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Add("Vary", "Accept-Encoding")
		body = buf.Bytes()
	}
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func sendJSON(w http.ResponseWriter, r *http.Request, status int, v any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		status, buf = http.StatusInternalServerError, *bytes.NewBufferString(`{"error":"internal error"}` + "\n")
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	send(w, r, status, buf.Bytes())
}

func (s *Server) setCookie(w http.ResponseWriter, name, value string, maxAge int, path string) {
	c := name + "=" + url.PathEscape(value) + "; Path=" + path + "; Max-Age=" + fmt.Sprint(maxAge) + "; HttpOnly; SameSite=Lax"
	if s.secure {
		c += "; Secure"
	}
	w.Header().Add("Set-Cookie", c)
}

func (s *Server) clearCookie(w http.ResponseWriter, name, path string) {
	s.setCookie(w, name, "", 0, path)
}

// session returns the verified session in a cookie.
func (s *Server) session(r *http.Request, cookie string) (secrets.Session, bool) {
	var sess secrets.Session
	if !s.configured {
		return sess, false
	}
	c, err := r.Cookie(cookie)
	if err != nil {
		return sess, false
	}
	v, err := url.PathUnescape(c.Value)
	if err != nil {
		return sess, false
	}
	return sess, secrets.VerifyToken(s.keys.Sign, v, s.now(), &sess)
}

func (s *Server) originOK(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(s.cfg.PublicURL)
	return err == nil && origin == u.Scheme+"://"+u.Host
}

func (s *Server) rec(r *http.Request, in audit.Input) {
	if s.audit == nil {
		return
	}
	if in.IP == "" {
		in.IP = audit.ClientIP(r)
	}
	s.audit.Write(in)
}

// effective is the SSO setup and the state of the built-in account: values saved in the admin page win over the environment.
type effective struct {
	gitlab      store.GitLabSettings
	sso         bool
	ssoLiveAt   int64
	localActive bool
}

func (s *Server) effective() effective {
	var st store.Portal
	if s.settings != nil {
		st, _ = s.settings.Get()
	}
	pick := func(saved, env string) string {
		if saved != "" {
			return saved
		}
		return env
	}
	g := store.GitLabSettings{URL: s.cfg.GitLab.URL, ClientID: s.cfg.GitLab.ClientID, ClientSecret: s.cfg.GitLab.ClientSecret}
	if st.GitLab != nil {
		g = store.GitLabSettings{URL: pick(st.GitLab.URL, g.URL), ClientID: pick(st.GitLab.ClientID, g.ClientID), ClientSecret: pick(st.GitLab.ClientSecret, g.ClientSecret)}
	}
	// The built-in account is a bootstrap: 24 h after GitLab SSO is proven live (first admin sign-in through it) it stops working.
	// MNEMOSYNE_LOCAL_ADMIN_FORCE=1 is the recovery switch if GitLab is down or SSO was misconfigured.
	localEnabled := s.configured && s.localHash != ""
	withinGrace := st.SSOLiveAt == 0 || s.now().Unix() < st.SSOLiveAt+localAdminGrace
	return effective{
		gitlab:      g,
		sso:         g.URL != "" && g.ClientID != "" && g.ClientSecret != "",
		ssoLiveAt:   st.SSOLiveAt,
		localActive: localEnabled && (s.cfg.LocalAdminForce || withinGrace),
	}
}

// adminSession is the signed-in administrator; a session of the built-in account counts only while that account is still active.
func (s *Server) adminSession(r *http.Request) (secrets.Session, bool) {
	sess, ok := s.session(r, adminCookie)
	if !ok || (sess.L && !s.effective().localActive) {
		return secrets.Session{}, false
	}
	return sess, true
}

// canonicalRedirect sends a browser page opened under another name of this server (an alias, or the GitLab host) once to the same
// path under the public URL: the sign-in cookie belongs to the host name that was typed, while GitLab sends the browser back to the
// public URL. The Host header is never copied into the redirect.
func (s *Server) canonicalRedirect(w http.ResponseWriter, r *http.Request) bool {
	if s.canonical == nil || r.Method != http.MethodGet {
		return false
	}
	typed := strings.ToLower(r.Header.Get("X-Forwarded-Host"))
	if typed == "" {
		typed = strings.ToLower(r.Host)
	}
	typed = strings.Split(typed, ":")[0]
	if typed == "" || typed == strings.ToLower(s.canonical.Hostname()) || !s.ownNames[typed] {
		return false
	}
	http.Redirect(w, r, s.canonical.Scheme+"://"+s.canonical.Host+r.URL.RequestURI(), http.StatusFound)
	return true
}

// ---- pages ----------------------------------------------------------------------------------------------------------

var errorTexts = map[string]string{
	"state":     "The sign-in attempt expired or was tampered with. Please try again.",
	"denied":    "GitLab sign-in was cancelled or refused.",
	"gitlab":    "GitLab could not be reached or rejected the sign-in. Please try again.",
	"local":     "Wrong user name or password.",
	"throttled": "Too many attempts. Please wait a minute and try again.",
	"nosso":     "GitLab sign-in is not set up yet.",
	"noadmin":   "Only GitLab administrators may open the admin area.",
}

func footer() string {
	return fmt.Sprintf(`<div class="site-foot">%d &copy; LSE Group Corporation <span aria-hidden="true">|</span>Version %s</div>`, time.Now().Year(), html.EscapeString(assets.Version().Shown))
}

func (s *Server) loginPage(w http.ResponseWriter, r *http.Request, errKey string) {
	eff := s.adminEffective()
	base := html.EscapeString(s.cfg.BasePath)
	var action string
	if s.configured && (eff.sso || eff.localActive) {
		sso, local := "", ""
		if eff.sso {
			cls := " primary"
			if eff.localActive {
				cls = ""
			}
			sso = fmt.Sprintf(`<a class="btn%s" href="%s/admin/auth/login">Sign in with GitLab</a>`, cls, base)
		}
		if eff.localActive {
			local = fmt.Sprintf(`<form class="local" method="post" action="%s/admin/auth/local">
        <input name="username" autocomplete="username" placeholder="Admin user name" required maxlength="100">
        <input name="password" type="password" autocomplete="current-password" placeholder="Password" required maxlength="200">
        <button class="btn primary" type="submit">Sign in</button></form>`, base)
		}
		if eff.sso && eff.localActive {
			action = local + `<div class="or">or GitLab admin</div>` + sso
		} else {
			action = local + sso
		}
	} else if s.configured && !s.edition().Licensed {
		action = `<div class="notice">The free edition signs administrators in with the built-in account: set MNEMOSYNE_LOCAL_ADMIN_USER and MNEMOSYNE_LOCAL_ADMIN_PASSWORD on this server. Signing in to the admin area with GitLab needs a licence.</div>`
	} else {
		action = `<div class="notice">Sign-in is not configured on this server yet.</div>`
	}
	errHTML := ""
	if msg, ok := errorTexts[errKey]; ok {
		errHTML = `<div class="notice error">` + html.EscapeString(msg) + `</div>`
	}
	page := strings.NewReplacer("@@BASE@@", base, "@@ERROR@@", errHTML, "@@ACTION@@", action, "@@FOOTER@@", footer()).Replace(assets.LoginHTML)
	pageHeaders(w, "")
	send(w, r, http.StatusOK, []byte(page))
}

func initials(name string) string {
	var out []rune
	for _, word := range strings.Fields(name) {
		if len(out) == 2 {
			break
		}
		r := []rune(word)
		out = append(out, []rune(strings.ToUpper(string(r[0])))...)
	}
	if len(out) == 0 {
		return "?"
	}
	return string(out)
}

// userMenu is the signed-in person in the header: a card with a link to their profile (a details element, no script).
func userMenu(base, name, username, role string, profile bool) string {
	n, u, ini := html.EscapeString(name), html.EscapeString(username), html.EscapeString(initials(name))
	action := `<p class="uc-note">This built-in account has no GitLab profile, so it cannot hold an MCP token.</p>`
	if profile {
		action = `<a class="btn primary" href="` + base + `/profile">Profile</a>`
	}
	return `<details class="usermenu">
    <summary title="Your account"><span class="avatar" aria-hidden="true">` + ini + `</span><span class="uname">` + n + ` <span>@` + u + `</span></span></summary>
    <div class="usercard">
      <div class="uc-head"><span class="avatar big" aria-hidden="true">` + ini + `</span><div><strong>` + n + `</strong><span class="at">@` + u + `</span></div></div>
      <span class="upill">` + html.EscapeString(role) + `</span>
      ` + action + `
    </div>
  </details>`
}

func (s *Server) adminPage(w http.ResponseWriter, r *http.Request) {
	if s.canonicalRedirect(w, r) {
		return
	}
	sess, ok := s.adminSession(r)
	if !ok {
		s.loginPage(w, r, r.URL.Query().Get("error"))
		return
	}
	nonce := base64.StdEncoding.EncodeToString(randBytes(16))
	base := html.EscapeString(s.cfg.BasePath)
	role := "GitLab administrator"
	if sess.L {
		role = "Built-in admin account"
	}
	redirects := "<code>" + html.EscapeString(s.here("/auth/callback")) + "</code><br><code>" + html.EscapeString(s.here("/admin/auth/callback")) + "</code>"
	page := strings.NewReplacer(
		"@@USERMENU@@", userMenu(base, sess.N, sess.U, role, !sess.L),
		"@@REDIRECTS@@", redirects,
		"@@FOOTER@@", footer(),
		"@@NONCE@@", html.EscapeString(nonce),
		"@@BASE@@", base,
	).Replace(assets.AdminHTML)
	pageHeaders(w, nonce)
	send(w, r, http.StatusOK, []byte(page))
}

func randBytes(n int) []byte {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return b
}

// ---- sign-in --------------------------------------------------------------------------------------------------------

type oauthState struct {
	State    string `json:"state"`
	Verifier string `json:"verifier"`
	Exp      int64  `json:"exp"`
}

func (s *Server) failSSO(w http.ResponseWriter, r *http.Request, key, user string) {
	if user == "" {
		user = "anonymous"
	}
	s.rec(r, audit.Input{Event: "login_failed", EntityType: "admin_sso", User: user, Description: "GitLab sign-in refused (" + key + ")"})
	s.clearCookie(w, adminOAuthCookie, s.adminBase()+"/auth")
	http.Redirect(w, r, s.adminBase()+"/?error="+key, http.StatusFound)
}

func (s *Server) ssoLogin(w http.ResponseWriter, r *http.Request) {
	if s.canonicalRedirect(w, r) {
		return
	}
	eff := s.adminEffective()
	if !s.configured || !eff.sso {
		http.Redirect(w, r, s.adminBase()+"/", http.StatusFound)
		return
	}
	state, verifier := randomB64(16), randomB64(32)
	sum := sha256.Sum256([]byte(verifier))
	token, err := secrets.SignToken(s.keys.Sign, oauthState{State: state, Verifier: verifier, Exp: s.now().Unix() + oauthTTL})
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	s.setCookie(w, adminOAuthCookie, token, oauthTTL, s.adminBase()+"/auth")
	q := url.Values{
		"client_id":             {eff.gitlab.ClientID},
		"redirect_uri":          {s.here("/admin/auth/callback")},
		"response_type":         {"code"},
		"state":                 {state},
		"scope":                 {"read_user"},
		"code_challenge":        {base64.RawURLEncoding.EncodeToString(sum[:])},
		"code_challenge_method": {"S256"},
	}
	noStore(w)
	http.Redirect(w, r, eff.gitlab.URL+"/oauth/authorize?"+q.Encode(), http.StatusFound)
}

type gitlabUser struct {
	Username string `json:"username"`
	Name     string `json:"name"`
	Email    string `json:"email"`
	State    string `json:"state"`
	IsAdmin  bool   `json:"is_admin"`
}

func (s *Server) ssoCallback(w http.ResponseWriter, r *http.Request) {
	if s.canonicalRedirect(w, r) {
		return
	}
	if !s.configured {
		http.Redirect(w, r, s.adminBase()+"/", http.StatusFound)
		return
	}
	eff := s.adminEffective()
	if !eff.sso {
		s.failSSO(w, r, "nosso", "")
		return
	}
	var pending oauthState
	if c, err := r.Cookie(adminOAuthCookie); err != nil {
		s.failSSO(w, r, "state", "")
		return
	} else if v, err := url.PathUnescape(c.Value); err != nil || !secrets.VerifyToken(s.keys.Sign, v, s.now(), &pending) {
		s.failSSO(w, r, "state", "")
		return
	}
	q := r.URL.Query()
	if q.Get("state") == "" || q.Get("state") != pending.State {
		s.failSSO(w, r, "state", "")
		return
	}
	code := q.Get("code")
	if code == "" {
		s.failSSO(w, r, "denied", "")
		return
	}
	user, err := s.exchange(eff, code, pending.Verifier)
	if err != nil {
		s.failSSO(w, r, "gitlab", "")
		return
	}
	if user.State != "" && user.State != "active" {
		s.failSSO(w, r, "denied", "")
		return
	}
	// Admin rights come from GitLab itself: only a GitLab instance administrator gets in.
	if !user.IsAdmin {
		s.failSSO(w, r, "noadmin", user.Username)
		return
	}
	// The first successful GitLab admin sign-in proves SSO works: it starts the 24 h life of the built-in account.
	if eff.ssoLiveAt == 0 {
		_, _ = s.settings.Update(func(p *store.Portal) error {
			if p.SSOLiveAt == 0 {
				p.SSOLiveAt = s.now().Unix()
			}
			return nil
		})
	}
	name := user.Name
	if name == "" {
		name = user.Username
	}
	s.rec(r, audit.Input{Event: "login", EntityType: "admin_sso", EntityName: name, User: user.Username, Description: "Signed in with GitLab (admin, GitLab administrator)"})
	token, err := secrets.SignToken(s.keys.Sign, secrets.Session{U: user.Username, N: name, E: user.Email, Exp: s.now().Unix() + sessionTTL})
	if err != nil {
		s.failSSO(w, r, "gitlab", "")
		return
	}
	s.setCookie(w, adminCookie, token, sessionTTL, s.adminBase())
	s.clearCookie(w, adminOAuthCookie, s.adminBase()+"/auth")
	noStore(w)
	http.Redirect(w, r, s.adminBase()+"/", http.StatusFound)
}

// exchange trades the authorization code for the person: token exchange (PKCE), then the user lookup.
func (s *Server) exchange(eff effective, code, verifier string) (gitlabUser, error) {
	var u gitlabUser
	form := url.Values{
		"client_id":     {eff.gitlab.ClientID},
		"client_secret": {eff.gitlab.ClientSecret},
		"code":          {code},
		"grant_type":    {"authorization_code"},
		"redirect_uri":  {s.here("/admin/auth/callback")},
		"code_verifier": {verifier},
	}
	req, _ := http.NewRequest(http.MethodPost, eff.gitlab.URL+"/oauth/token", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	res, err := s.gitlab.Do(req)
	if err != nil {
		return u, err
	}
	defer res.Body.Close()
	var tok struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, maxBody)).Decode(&tok); err != nil || res.StatusCode != http.StatusOK || tok.AccessToken == "" {
		return u, fmt.Errorf("token exchange failed (%d)", res.StatusCode)
	}
	ureq, _ := http.NewRequest(http.MethodGet, eff.gitlab.URL+"/api/v4/user", nil)
	ureq.Header.Set("Authorization", "Bearer "+tok.AccessToken)
	ureq.Header.Set("Accept", "application/json")
	ures, err := s.gitlab.Do(ureq)
	if err != nil {
		return u, err
	}
	defer ures.Body.Close()
	if err := json.NewDecoder(io.LimitReader(ures.Body, maxBody)).Decode(&u); err != nil || ures.StatusCode != http.StatusOK || u.Username == "" {
		return u, fmt.Errorf("user lookup failed (%d)", ures.StatusCode)
	}
	return u, nil
}

func (s *Server) localLogin(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	_ = r.ParseForm()
	attempted := strings.TrimSpace(r.PostForm.Get("username"))
	if jobs.JSLen(attempted) > 100 {
		attempted = jobs.JSSlice(attempted, 100)
	}
	back := func(key, why string) {
		who := attempted
		if who == "" {
			who = "anonymous"
		}
		s.rec(r, audit.Input{Event: "login_failed", EntityType: "admin_local", User: who, Description: why})
		http.Redirect(w, r, s.adminBase()+"/?error="+key, http.StatusFound)
	}
	if !s.configured || s.localHash == "" || !s.originOK(r) || !s.effective().localActive {
		back("local", "Local admin sign-in refused (disabled, or request from another origin)")
		return
	}
	ip := audit.ClientIP(r)
	now := s.now()
	s.mu.Lock()
	m, seen := s.misses[ip]
	s.mu.Unlock()
	if seen && m.n >= lockoutMisses && m.until.After(now) {
		back("throttled", "Locked out: too many wrong passwords from this address")
		return
	}
	password := r.PostForm.Get("password")
	if jobs.JSLen(password) > 200 {
		password = jobs.JSSlice(password, 200)
	}
	// Always run the hash check so a wrong user name costs the same as a wrong password.
	ok := secrets.VerifyPassword(password, s.localHash)
	if !(ok && strings.EqualFold(attempted, s.localUser)) {
		n := 1
		if seen && m.until.After(now) {
			n = m.n + 1
		}
		s.mu.Lock()
		s.misses[ip] = miss{n: n, until: now.Add(lockoutDuration)}
		s.mu.Unlock()
		back("local", "Wrong user name or password")
		return
	}
	s.mu.Lock()
	delete(s.misses, ip)
	s.mu.Unlock()
	s.rec(r, audit.Input{Event: "login", EntityType: "admin_local", EntityName: "Local administrator", User: s.localUser, Description: "Signed in with the built-in local admin account"})
	token, err := secrets.SignToken(s.keys.Sign, secrets.Session{U: s.localUser, N: "Local administrator", L: true, Exp: now.Unix() + sessionTTL})
	if err != nil {
		back("local", "Could not sign the session")
		return
	}
	s.setCookie(w, adminCookie, token, sessionTTL, s.adminBase())
	http.Redirect(w, r, s.adminBase()+"/", http.StatusSeeOther)
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if sess, ok := s.session(r, adminCookie); ok {
		s.rec(r, audit.Input{Event: "logout", EntityType: "admin_session", User: sess.U, Description: "Signed out of admin"})
	}
	s.clearCookie(w, adminCookie, s.adminBase())
	noStore(w)
	http.Redirect(w, r, s.adminBase()+"/", http.StatusSeeOther)
}

// ---- the admin API --------------------------------------------------------------------------------------------------

// httpError is an API answer with its own status (the others are 400 for bad input, 500 for the rest).
type httpError struct {
	status int
	msg    string
}

func (e *httpError) Error() string { return e.msg }

type apiFunc func(w http.ResponseWriter, r *http.Request, who string) (any, error)

// apiHandler wraps an API call: it needs a signed-in administrator, and a state-changing call must come from our own page (SameSite=Lax
// already blocks cross-site cookies; the custom header and the Origin check are defence in depth).
func (s *Server) apiHandler(fn apiFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		noStore(w)
		if s.canonicalRedirect(w, r) {
			return
		}
		sess, ok := s.adminSession(r)
		if !ok {
			sendJSON(w, r, http.StatusUnauthorized, map[string]string{"error": "not signed in"})
			return
		}
		if r.Method != http.MethodGet && (r.Header.Get("X-Requested-With") != adminAPIMarker || !s.originOK(r)) {
			s.rec(r, audit.Input{Event: "denied", EntityType: "admin_api", User: sess.U, Description: "Cross-site request refused: " + r.Method + " " + strings.TrimPrefix(r.URL.Path, s.adminBase()+"/api")})
			sendJSON(w, r, http.StatusForbidden, map[string]string{"error": "cross-site request refused"})
			return
		}
		out, err := fn(w, r, sess.U)
		var ve *jobs.ValidationError
		var he *httpError
		switch {
		case err == nil:
			sendJSON(w, r, http.StatusOK, out)
		case errors.As(err, &he):
			sendJSON(w, r, he.status, map[string]string{"error": he.msg})
		case errors.As(err, &ve):
			sendJSON(w, r, http.StatusBadRequest, map[string]string{"error": ve.Msg})
		default:
			log.Printf("admin api %s %s: %v", r.Method, r.URL.Path, err)
			sendJSON(w, r, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		}
	}
}

// body decodes the JSON object the page sent (an empty body is an empty object).
func body(r *http.Request) (map[string]any, error) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
	if err != nil || len(raw) > maxBody {
		return nil, jobs.Invalid("the request is too large")
	}
	out := map[string]any{}
	if len(bytes.TrimSpace(raw)) == 0 {
		return out, nil
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, jobs.Invalid("the request is not valid JSON")
	}
	return out, nil
}
