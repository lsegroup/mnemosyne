package web

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"gitlab.globalclouddata.org/gcd-group/mnemosyne-admin/internal/license"
	"gitlab.globalclouddata.org/gcd-group/mnemosyne-admin/internal/secrets"
	"gitlab.globalclouddata.org/gcd-group/mnemosyne-admin/internal/store"
)

// licenceServer is a licence server that signs its answers: it says "trial" to a ping and "licensed, 25 seats" to the key goodKey.
type licenceServer struct {
	srv      *httptest.Server
	pub      ed25519.PublicKey
	goodKey  string
	mu       sync.Mutex
	requests []map[string]any
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
	h := newHarness(t, withLocal(nil))
	r := &licenceRig{harness: h, now: time.Now()}
	clock := func() time.Time { r.mu.Lock(); defer r.mu.Unlock(); return r.now }
	r.ls = newLicenceServer(t, clock)
	m, err := license.New(license.Options{
		Store: store.NewLicense(filepath.Join(h.dir, "lic.enc"), h.srv.keys.Enc), Server: r.ls.srv.URL, PublicKey: r.ls.pub, Domain: "127.0.0.1",
		Version: "test", Now: clock, SeatsUsed: func() int { return 3 },
	})
	if err != nil {
		t.Fatal(err)
	}
	r.m = m
	h.srv.SetLicense(m)
	return r
}

func (r *licenceRig) advance(d time.Duration) { r.mu.Lock(); r.now = r.now.Add(d); r.mu.Unlock() }

func TestWhenTheLicenceSaysNoOnlyHealthAndTheAdminAreOpen(t *testing.T) {
	r := newLicenceRig(t)
	// the licence server is not asked at all (no loop is started): after the first minutes there is nothing that allows the work
	r.advance(11 * time.Minute)

	page := r.do(call{path: "/p/alpha", headers: map[string]string{"Accept": "text/html"}})
	eq(t, page.status, 402, "a page")
	has(t, page.body, "Mnemosyne is locked")
	has(t, page.body, "trial could not be confirmed")
	has(t, page.body, "/mnemosyne/admin/#license")
	has(t, page.header.Get("Content-Type"), "text/html")

	mcp := r.do(call{method: "POST", path: "/mcp", body: `{"jsonrpc":"2.0"}`})
	eq(t, mcp.status, 402, "MCP")
	j := mcp.json(t)
	eq(t, j["error"], "licence_required", "error code")
	has(t, j["message"].(string), "trial could not be confirmed")
	rest := r.do(call{path: "/search?q=x"})
	eq(t, rest.status, 402, "REST")

	r.mu.Lock()
	reached := len(r.seen)
	r.mu.Unlock()
	eq(t, reached, 0, "nothing reached the Node server")

	health := r.do(call{path: "/health"})
	eq(t, health.status, 200, "health stays open")
	has(t, health.body, "node says GET /mnemosyne/health")
	eq(t, r.do(call{path: "/admin/"}).status, 200, "the admin sign-in")
	eq(t, r.srv.licensed(), false, "the Auto scheduler sees a locked installation")
}

func TestAnAdministratorActivatesAKeyAndTheFrontDoorOpens(t *testing.T) {
	r := newLicenceRig(t)
	r.advance(11 * time.Minute)
	cookie, _ := r.localCookie("Admin", "correct horse")

	st := r.api(cookie, "GET", "/license", "")
	eq(t, st.status, 200, "status")
	j := st.json(t)
	eq(t, j["state"], "locked", "state")
	eq(t, j["allowed"], false, "allowed")
	eq(t, j["domain"], "127.0.0.1", "domain")
	eq(t, j["hasKey"], false, "no key yet")

	bad := r.api(cookie, "POST", "/license/activate", `{"key":"LSE-WRONGKEY-123456"}`)
	eq(t, bad.status, 400, "wrong key")
	eq(t, bad.json(t)["error"], "Invalid license key.", "the licence server's words")
	eq(t, r.api(cookie, "POST", "/license/activate", `{"key":"x"}`).status, 400, "not a key")
	eq(t, r.do(call{path: "/p/alpha", headers: map[string]string{"Accept": "text/html"}}).status, 402, "still locked")

	good := r.api(cookie, "POST", "/license/activate", `{"key":"LSE-GOODKEY-123456"}`)
	eq(t, good.status, 200, "good key: "+good.body)
	g := good.json(t)
	eq(t, g["state"], "licensed", "state")
	eq(t, g["org"], "Acme Corp", "organisation")
	eq(t, g["seats"], any(float64(25)), "seats licensed")
	eq(t, g["seatsUsed"], any(float64(3)), "seats used")
	eq(t, g["keyHint"], "…3456", "only the end of the key is shown")
	if strings.Contains(good.body, "GOODKEY") {
		t.Error("the key itself must never be sent back")
	}
	r.ls.mu.Lock()
	asked := r.ls.requests[len(r.ls.requests)-1]
	r.ls.mu.Unlock()
	eq(t, asked["seats_used"], any(float64(3)), "the seats in use are reported with every contact")
	eq(t, asked["product"], "mnemosyne", "product")

	open := r.do(call{path: "/p/alpha"})
	eq(t, open.status, 200, "open again")
	has(t, open.body, "node says GET /mnemosyne/p/alpha")
	eq(t, r.srv.licensed(), true, "Auto may run again")

	// a manual check asks the server again; the audit trail names the person
	chk := r.api(cookie, "POST", "/license/check", "")
	eq(t, chk.status, 200, "check")
	eq(t, chk.json(t)["state"], "licensed", "state after the check")
	trail := r.api(cookie, "GET", "/audit", "")
	has(t, trail.body, "license_activate")
	has(t, trail.body, "Licence key …3456 activated")
	has(t, trail.body, "Licence key refused: Invalid license key.")
}

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
	chk := r.api(cookie, "POST", "/license/check", "")
	eq(t, chk.status, 200, "a check reports instead of failing")
	has(t, chk.json(t)["lastError"].(string), "could not be reached")
}

func TestAnUnconfiguredInstallationServesNothingButHealthAndTheAdmin(t *testing.T) {
	h := newHarness(t, opts{noSecret: true})
	eq(t, h.do(call{path: "/p/alpha"}).status, 402, "page")
	r := h.do(call{method: "POST", path: "/mcp", body: "{}"})
	eq(t, r.status, 402, "mcp")
	has(t, r.json(t)["message"].(string), "MNEMOSYNE_SECRET")
	eq(t, h.do(call{path: "/health"}).status, 200, "health")
	eq(t, h.srv.licensed(), false, "locked")
}

func TestSeatsAreThePeopleWhoSignedInLastYearOrHoldAnActiveToken(t *testing.T) {
	h := newHarness(t, opts{})
	enc := h.srv.keys.Enc
	now := time.Now()
	ms := func(d time.Duration) int64 { return now.Add(d).UnixMilli() }
	write := func(path string, v any) {
		raw, _ := json.Marshal(v)
		sealed, err := secrets.Seal(enc, string(raw))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(sealed), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	day := 24 * time.Hour
	members, tokens := filepath.Join(h.dir, "m.enc"), filepath.Join(h.dir, "t.enc")
	write(members, map[string]any{
		"Alice": map[string]any{"at": ms(-3 * day), "admin": false},
		"bob":   map[string]any{"at": ms(-400 * day), "admin": false}, // last seen more than a year ago
		"carol": map[string]any{"at": ms(-30 * day), "admin": true},
	})
	write(tokens, []map[string]any{
		{"user": "carol", "expiresAt": ms(10 * day)},                      // already a seat through the sign-in: one seat
		{"user": "Dave", "expiresAt": ms(5 * day)},                        // only an MCP person
		{"user": "erin", "expiresAt": ms(5 * day), "revokedAt": ms(-day)}, // revoked
		{"user": "frank", "expiresAt": ms(-day)},                          // expired
	})
	got := seatsUsed(store.NewMembers(members, enc), store.NewTokens(tokens, enc), now)
	eq(t, got, 3, "alice, carol and dave")
	eq(t, seatsUsed(store.NewMembers(filepath.Join(h.dir, "none.enc"), enc), store.NewTokens(filepath.Join(h.dir, "none2.enc"), enc), now), 0, "no files, no seats")
}
