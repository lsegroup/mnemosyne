// SPDX-License-Identifier: Apache-2.0

package web

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
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

// licenceServer is a licence server that signs its answers: it says "trial" to a ping and "licensed, 25 seats" to the key goodKey.
type licenceServer struct {
	srv     *httptest.Server
	pub     ed25519.PublicKey
	goodKey string
	// trialOver: the licence server says the 30 days are over
	trialOver bool
	mu        sync.Mutex
	requests  []map[string]any
}

func newLicenceServer(t *testing.T, now func() time.Time) *licenceServer {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	ls := &licenceServer{pub: pub, goodKey: "LSE-GOODKEY-123456"}
	ls.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		_ = json.NewDecoder(r.Body).Decode(&req)
		ls.mu.Lock()
		ls.requests = append(ls.requests, req)
		ls.mu.Unlock()
		p := map[string]any{"v": 1, "product": req["product"], "domain": req["domain"], "db_uuid": req["db_uuid"], "nonce": req["nonce"], "issued": now().Unix(), "expires": now().Add(7 * 24 * time.Hour).Unix()}
		switch {
		case r.URL.Path == "/ping" && ls.trialOver:
			p["state"], p["valid"], p["message"] = "trial-expired", false, "The 30-day trial has ended. A licence key is needed."
		case r.URL.Path == "/ping":
			p["state"], p["valid"], p["trial_ends"] = "trial", true, now().Add(30*24*time.Hour).Unix()
		case req["key"] == ls.goodKey:
			p["state"], p["valid"], p["org"], p["seats"], p["license_expires"] = "licensed", true, "Acme Corp", 25, now().Add(365*24*time.Hour).Unix()
		default:
			p["state"], p["valid"], p["message"] = "unknown-key", false, "Invalid license key."
		}
		raw, _ := json.Marshal(p)
		_ = json.NewEncoder(w).Encode(map[string]any{"valid": p["valid"], "attestation": map[string]string{"payload": base64.StdEncoding.EncodeToString(raw), "sig": base64.StdEncoding.EncodeToString(ed25519.Sign(priv, raw))}})
	}))
	t.Cleanup(ls.srv.Close)
	return ls
}

func (ls *licenceServer) last() map[string]any {
	ls.mu.Lock()
	defer ls.mu.Unlock()
	return ls.requests[len(ls.requests)-1]
}

// licenceRig is a harness whose front door uses a licence manager that talks to the signing licence server above.
type licenceRig struct {
	*harness
	ls  *licenceServer
	m   *license.Manager
	now time.Time
	mu  sync.Mutex
}

func newLicenceRig(t *testing.T) *licenceRig {
	o := withLocal(nil)
	o.free = true // the rig brings its own licence manager
	h := newHarness(t, o)
	r := &licenceRig{harness: h, now: time.Now()}
	clock := func() time.Time { r.mu.Lock(); defer r.mu.Unlock(); return r.now }
	r.ls = newLicenceServer(t, clock)
	m, err := license.New(license.Options{
		Store: store.NewLicense(filepath.Join(h.dir, "lic.enc"), h.srv.keys.Enc), Server: r.ls.srv.URL, PublicKey: r.ls.pub, Domain: "127.0.0.1",
		Version: "test", Now: clock, SeatsUsed: h.srv.seats.Count, FreeWithoutKey: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	r.m = m
	h.srv.SetLicense(m)
	return r
}

func (r *licenceRig) advance(d time.Duration) { r.mu.Lock(); r.now = r.now.Add(d); r.mu.Unlock() }

// person is a signed-in member of the documentation portal: the cookie the Node server writes.
func (h *harness) person(t *testing.T, user string) map[string]string {
	t.Helper()
	token, err := secrets.SignToken(h.srv.keys.Sign, secrets.Session{U: user, N: user, E: user + "@example.com", Exp: time.Now().Add(time.Hour).Unix()})
	if err != nil {
		t.Fatal(err)
	}
	return map[string]string{"Cookie": sessionCookie + "=" + token, "Accept": "text/html"}
}

// ---- the free edition: four people ------------------------------------------------------------------------------------------

func TestTheFreeEditionHasFourSeatsAndRefusesTheFifthPerson(t *testing.T) {
	r := newLicenceRig(t)
	for _, u := range []string{"alice", "bob", "carol", "dave"} {
		got := r.do(call{path: "/p/alpha", headers: r.person(t, u)})
		eq(t, got.status, 200, u+" has a seat")
	}
	eq(t, r.srv.seats.Count(), 4, "four seats taken")

	// the fifth person is refused (and signed out of the portal); the page says why
	page := r.do(call{path: "/p/alpha", headers: r.person(t, "frank")})
	eq(t, page.status, 402, "the fifth person")
	has(t, page.body, "All 4 seats of this installation are taken")
	has(t, page.body, "free for up to 4 people")
	has(t, page.header.Get("Set-Cookie"), sessionCookie+"=")
	has(t, page.header.Get("Set-Cookie"), "Max-Age=0")
	api := r.do(call{method: "POST", path: "/mcp", body: "{}", headers: map[string]string{"Cookie": r.person(t, "frank")["Cookie"]}})
	eq(t, api.status, 402, "MCP of that person")
	eq(t, api.json(t)["error"], "seats_exhausted", "error code")
	eq(t, r.srv.seats.Count(), 4, "no fifth seat")

	// the four keep working, anonymous requests and the health answer are never touched
	eq(t, r.do(call{path: "/p/alpha", headers: r.person(t, "alice")}).status, 200, "alice still works")
	eq(t, r.do(call{path: "/login"}).status, 200, "the sign-in page")
	eq(t, r.do(call{path: "/health"}).status, 200, "health")
	eq(t, r.do(call{path: "/admin/"}).status, 200, "the admin area")

	// one audit entry for the refused person, however often they try
	for i := 0; i < 3; i++ {
		r.do(call{path: "/p/alpha", headers: r.person(t, "frank")})
	}
	cookie, _ := r.localCookie("Admin", "correct horse")
	trail := r.api(cookie, "GET", "/audit", "").body
	eq(t, strings.Count(trail, "Sign-in refused: all 4 seats are taken"), 1, "one audit entry")

	// a seat can be freed
	r.srv.seats.Release("bob")
	eq(t, r.do(call{path: "/p/alpha", headers: r.person(t, "frank")}).status, 200, "frank takes bob's seat")
}

func TestALicenceLiftsTheLimitToItsSeats(t *testing.T) {
	r := newLicenceRig(t)
	cookie, _ := r.localCookie("Admin", "correct horse")
	for _, u := range []string{"a", "b", "c", "d"} {
		r.do(call{path: "/p/alpha", headers: r.person(t, u)})
	}
	eq(t, r.do(call{path: "/p/alpha", headers: r.person(t, "e")}).status, 402, "refused without a licence")

	st := r.api(cookie, "GET", "/license", "").json(t)
	eq(t, st["edition"], "free", "edition")
	eq(t, st["seatLimit"], any(float64(4)), "limit")
	eq(t, st["seatsUsed"], any(float64(4)), "seats used")
	eq(t, st["hasKey"], false, "no key")
	eq(t, len(r.ls.requests), 0, "the licence server is not asked without a key")

	bad := r.api(cookie, "POST", "/license/activate", `{"key":"LSE-WRONGKEY-123456"}`)
	eq(t, bad.status, 400, "wrong key")
	eq(t, bad.json(t)["error"], "Invalid license key.", "the licence server's words")
	eq(t, r.api(cookie, "POST", "/license/activate", `{"key":"x"}`).status, 400, "not a key")
	eq(t, r.do(call{path: "/p/alpha", headers: r.person(t, "e")}).status, 402, "still refused")

	good := r.api(cookie, "POST", "/license/activate", `{"key":"LSE-GOODKEY-123456"}`)
	eq(t, good.status, 200, "good key: "+good.body)
	g := good.json(t)
	eq(t, g["edition"], "licensed", "edition")
	eq(t, g["org"], "Acme Corp", "organisation")
	eq(t, g["seatLimit"], any(float64(25)), "the seats of the licence")
	eq(t, g["keyHint"], "…3456", "only the end of the key is shown")
	if strings.Contains(good.body, "GOODKEY") {
		t.Error("the key itself must never be sent back")
	}
	asked := r.ls.last()
	eq(t, asked["seats_used"], any(float64(4)), "the seats in use are reported with every contact")
	eq(t, asked["product"], "mnemosyne", "product")

	eq(t, r.do(call{path: "/p/alpha", headers: r.person(t, "e")}).status, 200, "the fifth person works now")
	chk := r.api(cookie, "POST", "/license/check", "")
	eq(t, chk.status, 200, "check")
	eq(t, chk.json(t)["edition"], "licensed", "edition after the check")
	trail := r.api(cookie, "GET", "/audit", "").body
	has(t, trail, "Licence key …3456 activated")
	has(t, trail, "Licence key refused: Invalid license key.")
}

func TestALicenceThatRunsOutFallsBackToTheFreeEditionAndNeverLocks(t *testing.T) {
	r := newLicenceRig(t)
	cookie, _ := r.localCookie("Admin", "correct horse")
	r.api(cookie, "POST", "/license/activate", `{"key":"LSE-GOODKEY-123456"}`)
	eq(t, r.srv.edition().Licensed, true, "licensed")
	// the last answer of the licence server runs out (7 days) and the server cannot be reached
	r.ls.srv.Close()
	r.advance(8 * 24 * time.Hour)
	eq(t, r.srv.edition().Licensed, false, "the free edition again")
	eq(t, r.do(call{path: "/p/alpha", headers: r.person(t, "alice")}).status, 200, "the portal still works for the first four")
	st := r.api(cookie, "GET", "/license", "").json(t)
	eq(t, st["edition"], "free", "edition")
	eq(t, st["hasKey"], true, "the key is still there")
}

// ---- the free edition: audit and SSO ------------------------------------------------------------------------------------------

func TestTheFreeEditionShowsTheLastTenAuditRecordsOnly(t *testing.T) {
	r := newLicenceRig(t)
	cookie, _ := r.localCookie("Admin", "correct horse")
	for i := 0; i < 25; i++ {
		r.srv.audit.Write(audit.Input{Event: "update", EntityType: "test", EntityName: "n" + strings.Repeat("x", i%3), User: "t", Description: "record " + strconv.Itoa(i)})
	}
	free := r.api(cookie, "GET", "/audit?offset=10&limit=100&q=record", "").json(t)
	eq(t, free["limited"], any(true), "limited")
	eq(t, len(free["events"].([]any)), 10, "ten records, whatever is asked")
	eq(t, free["freeLimit"], any(float64(10)), "the limit")
	page := r.do(call{path: "/admin/", cookie: cookie}).body
	has(t, page, `id="auditFree"`)
	has(t, page, "Free edition: the last 10 records.")

	r.api(cookie, "POST", "/license/activate", `{"key":"LSE-GOODKEY-123456"}`)
	full := r.api(cookie, "GET", "/audit?offset=10&limit=20&q=record", "").json(t)
	eq(t, full["limited"], any(false), "not limited")
	eq(t, len(full["events"].([]any)), 15, "the paged search works: 25 records matched, the page starts at the 11th")
}

func TestTheFreeEditionHasNoGitLabSignInForTheAdminAreaAndNoSSOSetup(t *testing.T) {
	r := newLicenceRig(t)
	cookie, _ := r.localCookie("Admin", "correct horse")

	// the built-in account works; the GitLab button is not offered and the GitLab sign-in leads nowhere
	login := r.do(call{path: "/admin/"}).body
	has(t, login, "Sign in</button>")
	lacks(t, login, "Sign in with GitLab")
	eq(t, r.do(call{path: "/admin/auth/login"}).status, 302, "no GitLab redirect")
	eq(t, r.do(call{path: "/admin/auth/login"}).header.Get("Location"), "/mnemosyne/admin/", "back to the sign-in")

	// the SSO set-up is refused and the tab says so
	put := r.api(cookie, "PUT", "/settings", `{"gitlabUrl":"https://gl.example.org","clientId":"x","clientSecret":"a-long-secret-value-0123456789"}`)
	eq(t, put.status, 402, "set-up needs a licence")
	has(t, put.body, "needs a licence")
	page := r.do(call{path: "/admin/", cookie: cookie}).body
	has(t, page, `id="ssoFree"`)

	// with a licence both work
	r.api(cookie, "POST", "/license/activate", `{"key":"LSE-GOODKEY-123456"}`)
	has(t, r.do(call{path: "/admin/"}).body, "Sign in with GitLab")
	eq(t, r.do(call{path: "/admin/auth/login"}).status, 302, "the GitLab redirect")
	has(t, r.do(call{path: "/admin/auth/login"}).header.Get("Location"), "/oauth/authorize")
	eq(t, r.api(cookie, "PUT", "/settings", `{"gitlabUrl":"https://gl.example.org","clientId":"x","clientSecret":"a-long-secret-value-0123456789"}`).status, 200, "set-up works")
}

// ---- the rest of the licence handling ---------------------------------------------------------------------------------------

func TestTheLicenceAPIIsForAdministratorsOnly(t *testing.T) {
	r := newLicenceRig(t)
	for _, c := range []struct{ method, path string }{{"GET", "/license"}, {"POST", "/license/activate"}, {"POST", "/license/check"}} {
		got := r.api("", c.method, c.path, `{"key":"LSE-GOODKEY-123456"}`)
		eq(t, got.status, 401, c.method+" "+c.path)
	}
	eq(t, r.m.Status().HasKey, false, "nothing was activated")
	// from another site, even with a valid cookie, a state-changing call is refused
	cookie, _ := r.localCookie("Admin", "correct horse")
	cross := r.do(call{method: "POST", path: "/admin/api/license/activate", cookie: cookie, body: `{"key":"LSE-GOODKEY-123456"}`, headers: map[string]string{"Origin": "https://evil.example"}})
	eq(t, cross.status, 403, "cross-site")
	eq(t, r.m.Status().HasKey, false, "nothing was activated")
}

func TestAnUnreachableLicenceServerIsReportedNotHidden(t *testing.T) {
	r := newLicenceRig(t)
	r.ls.srv.Close()
	cookie, _ := r.localCookie("Admin", "correct horse")
	got := r.api(cookie, "POST", "/license/activate", `{"key":"LSE-GOODKEY-123456"}`)
	eq(t, got.status, 502, "status")
	has(t, got.json(t)["error"].(string), "licence server could not be reached")
	// without a key a check has nothing to ask
	chk := r.api(cookie, "POST", "/license/check", "")
	eq(t, chk.status, 200, "a check reports instead of failing")
}

func TestAnUnconfiguredInstallationServesNothingButHealthAndTheAdmin(t *testing.T) {
	h := newHarness(t, opts{noSecret: true})
	eq(t, h.do(call{path: "/p/alpha"}).status, 402, "page")
	r := h.do(call{method: "POST", path: "/mcp", body: "{}"})
	eq(t, r.status, 402, "mcp")
	has(t, r.json(t)["message"].(string), "MNEMOSYNE_SECRET")
	eq(t, h.do(call{path: "/health"}).status, 200, "health")
}

func TestTheLicensedDomainIsTheHostOfThePublicURLUnlessOneIsSet(t *testing.T) {
	// the host of MNEMOSYNE_PUBLIC_URL (the harness serves on 127.0.0.1), not the name of the machine
	o := withLocal(nil)
	o.free = true // the harness would bring its own licence manager
	h := newHarness(t, o)
	eq(t, h.srv.lic.Status().Domain, "127.0.0.1", "domain from the public URL")

	// MNEMOSYNE_LICENSE_DOMAIN wins, however it is written
	for _, written := range []string{"lumanet.info", " Lumanet.INFO ", "https://lumanet.info:40000/x"} {
		o := withLocal(map[string]string{"MNEMOSYNE_LICENSE_DOMAIN": written})
		o.free = true
		h := newHarness(t, o)
		eq(t, h.srv.lic.Status().Domain, "lumanet.info", "domain set as "+written)
	}
}

// The seat register must have a file of its own, or the four seats would be forgotten at every restart.
func TestTheSeatRegisterIsKeptInAFileNextToTheOtherData(t *testing.T) {
	dir := t.TempDir()
	cfg, err := config.Load(func(k string) string { return "" }, dir)
	if err != nil {
		t.Fatal(err)
	}
	eq(t, cfg.SeatsFile, filepath.Join(dir, ".mnemosyne", "seats.enc"), "default place: next to the other sealed files")
	cfg, _ = config.Load(func(k string) string {
		if k == "MNEMOSYNE_SEATS_FILE" {
			return filepath.Join(dir, "other.enc")
		}
		return ""
	}, dir)
	eq(t, cfg.SeatsFile, filepath.Join(dir, "other.enc"), "set in the environment")

	// and a running server really writes it
	r := newLicenceRig(t)
	r.do(call{path: "/p/alpha", headers: r.person(t, "alice")})
	if _, err := os.Stat(r.srv.cfg.SeatsFile); err != nil {
		t.Errorf("the register was not written: %v", err)
	}
}

// Company policy: everything runs for the first 30 days without a licence. The licence server grants the trial; afterwards it is the free edition.
func TestTheFirstThirtyDaysAreATrialWithEverythingUnlocked(t *testing.T) {
	r := newLicenceRig(t)
	cookie, _ := r.localCookie("Admin", "correct horse")
	eq(t, r.srv.edition().Licensed, false, "before the first contact: the free edition, not a lock")

	// the first contact (the program does it at start): no key, the licence server answers with the trial
	if err := r.m.CheckNow(context.Background()); err != nil {
		t.Fatal(err)
	}
	asked := r.ls.last()
	if _, has := asked["key"]; has {
		t.Error("no key is sent in a trial ping")
	}
	eq(t, asked["product"], "mnemosyne", "product")

	st := r.api(cookie, "GET", "/license", "").json(t)
	eq(t, st["state"], "trial", "state")
	eq(t, st["edition"], "licensed", "a trial unlocks everything")
	eq(t, st["trial"], any(true), "it is the trial")
	eq(t, st["seatLimit"], nil, "no seat limit")
	if st["trialEndsAt"].(float64) == 0 {
		t.Error("the end of the trial is shown")
	}
	eq(t, st["hasKey"], false, "no key")
	eq(t, st["localAdmin"], true, "the harness has a built-in admin")

	// more than four people, the whole audit history, GitLab sign-in for the admin
	for _, u := range []string{"a", "b", "c", "d", "e", "f"} {
		eq(t, r.do(call{path: "/p/alpha", headers: r.person(t, u)}).status, 200, u+" has a seat in the trial")
	}
	for i := 0; i < 15; i++ {
		r.srv.audit.Write(audit.Input{Event: "update", EntityType: "test", EntityName: "n", User: "t", Description: "record " + strconv.Itoa(i)})
	}
	full := r.api(cookie, "GET", "/audit?offset=5&limit=20&q=record", "").json(t)
	eq(t, full["limited"], any(false), "the whole history")
	has(t, r.do(call{path: "/admin/"}).body, "Sign in with GitLab")
	u := r.api(cookie, "GET", "/users", "").json(t)
	eq(t, u["trial"], any(true), "the Users tab knows it is the trial")
	page := r.do(call{path: "/admin/", cookie: cookie}).body
	has(t, page, "30-day trial - ")
	has(t, page, "left (everything unlocked, no seat limit)") // days left are counted in the page from the end of the trial
	has(t, page, "reverts to the free edition and keeps running")
	has(t, page, "No built-in admin account is set up")
}

func TestWhenTheTrialEndsTheFreeEditionApplies(t *testing.T) {
	r := newLicenceRig(t)
	cookie, _ := r.localCookie("Admin", "correct horse")
	if err := r.m.CheckNow(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, u := range []string{"a", "b", "c", "d", "e", "f"} {
		r.do(call{path: "/p/alpha", headers: r.person(t, u)})
	}
	eq(t, r.srv.seats.Count(), 6, "six seats during the trial")

	// the 30 days are over: the licence server says so at the next contact
	r.ls.mu.Lock()
	r.ls.trialOver = true
	r.ls.mu.Unlock()
	r.advance(12 * time.Hour)
	_ = r.m.CheckNow(context.Background())
	eq(t, r.srv.edition().Licensed, false, "the free edition")
	st := r.api(cookie, "GET", "/license", "").json(t)
	eq(t, st["edition"], "free", "edition")
	eq(t, st["trial"], any(false), "no trial")

	// nothing locks: the six who hold seats keep working, nobody new gets one, the audit page is limited again
	eq(t, r.do(call{path: "/p/alpha", headers: r.person(t, "a")}).status, 200, "a seat holder still works")
	eq(t, r.do(call{path: "/p/alpha", headers: r.person(t, "g")}).status, 402, "no new seat above the free limit")
	eq(t, r.do(call{path: "/health"}).status, 200, "health")
	lim := r.api(cookie, "GET", "/audit", "").json(t)
	eq(t, lim["limited"], any(true), "limited again")
	lacks(t, r.do(call{path: "/admin/"}).body, "Sign in with GitLab")

	// a licence key still unlocks it for good
	good := r.api(cookie, "POST", "/license/activate", `{"key":"LSE-GOODKEY-123456"}`)
	eq(t, good.status, 200, "activate: "+good.body)
	eq(t, r.api(cookie, "GET", "/license", "").json(t)["edition"], any("licensed"), "licensed")
	eq(t, r.do(call{path: "/p/alpha", headers: r.person(t, "g")}).status, 200, "the seventh person works now")
}
