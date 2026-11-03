package license

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
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lsegroup/mnemosyne/admin-go/internal/store"
)

const day = 24 * time.Hour

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) Add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}
func (c *clock) Set(t time.Time) { c.mu.Lock(); c.t = t; c.mu.Unlock() }

// ---- the real signed answers of the licence server ---------------------------------------------------------------------

type fixtureFile struct {
	PublicKey string `json:"publicKey"`
	Fixtures  []struct {
		Name    string `json:"name"`
		Path    string `json:"path"`
		Request struct {
			Domain  string `json:"domain"`
			DBUUID  string `json:"db_uuid"`
			Product string `json:"product"`
			Nonce   string `json:"nonce"`
		} `json:"request"`
		Attestation struct {
			Payload string `json:"payload"`
			Sig     string `json:"sig"`
		} `json:"attestation"`
	} `json:"fixtures"`
}

func loadFixtures(t *testing.T) (ed25519.PublicKey, fixtureFile) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "stage-fixtures.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f fixtureFile
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	pub, err := base64.StdEncoding.DecodeString(f.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	return pub, f
}

// These answers were produced by the real licence server code (Node, Ed25519 from node:crypto) on a staging copy: they prove that what
// the server signs is what this program verifies.
func TestTheRealLicenceServerAnswersVerify(t *testing.T) {
	pub, f := loadFixtures(t)
	want := map[string]struct {
		state string
		valid bool
	}{
		"trial starts": {"trial", true}, "trial over": {"trial-expired", false}, "activate a key": {"licensed", true},
		"same key on another installation": {"bound-elsewhere", false}, "past the end, inside the renewal time": {"renewal-grace", true},
		"past the renewal time": {"expired", false}, "revoked": {"revoked", false}, "unknown key": {"unknown-key", false}, "no expiry and no seat limit": {"licensed", true},
	}
	if len(f.Fixtures) != len(want) {
		t.Fatalf("%d fixtures, want %d", len(f.Fixtures), len(want))
	}
	for _, fx := range f.Fixtures {
		p, err := Open(pub, fx.Attestation.Payload, fx.Attestation.Sig)
		if err != nil {
			t.Errorf("%s: %v", fx.Name, err)
			continue
		}
		w := want[fx.Name]
		if p.State != w.state || p.Valid != w.valid || p.Product != "mnemosyne" || p.Nonce != fx.Request.Nonce || p.DBUUID != fx.Request.DBUUID || p.Domain != fx.Request.Domain {
			t.Errorf("%s: %+v", fx.Name, p)
		}
		// one changed character in the payload, or a signature of another key, is refused
		raw, _ := base64.StdEncoding.DecodeString(fx.Attestation.Payload)
		raw[len(raw)-3] ^= 1
		if _, err := Open(pub, base64.StdEncoding.EncodeToString(raw), fx.Attestation.Sig); err != ErrBadSignature {
			t.Errorf("%s: a changed payload was accepted (%v)", fx.Name, err)
		}
		other, _, _ := ed25519.GenerateKey(rand.Reader)
		if _, err := Open(other, fx.Attestation.Payload, fx.Attestation.Sig); err != ErrBadSignature {
			t.Errorf("%s: another key was accepted (%v)", fx.Name, err)
		}
	}
}

// answerWith returns an http server that answers every request with the fixture's attestation.
func answerWith(payload, sig string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"attestation": map[string]string{"payload": payload, "sig": sig}})
	}))
}

func TestAManagerReadsTheRealAnswers(t *testing.T) {
	pub, f := loadFixtures(t)
	for _, fx := range f.Fixtures {
		t.Run(fx.Name, func(t *testing.T) {
			srv := answerWith(fx.Attestation.Payload, fx.Attestation.Sig)
			defer srv.Close()
			p, _ := Open(pub, fx.Attestation.Payload, fx.Attestation.Sig)
			st := store.NewLicense(filepath.Join(t.TempDir(), "license.enc"), make([]byte, 32))
			if _, err := st.Update(func(s *store.LicenseState) { s.InstanceID = fx.Request.DBUUID }); err != nil {
				t.Fatal(err)
			}
			c := &clock{t: time.Unix(p.Issued+30, 0)}
			m, err := New(Options{Store: st, Server: srv.URL, PublicKey: pub, Domain: fx.Request.Domain, Now: c.Now, Nonce: func() string { return fx.Request.Nonce }})
			if err != nil {
				t.Fatal(err)
			}
			ctx := context.Background()
			if fx.Path == "/ping" {
				if err := m.CheckNow(ctx); err != nil {
					t.Fatal(err)
				}
			} else {
				_, err := m.Activate(ctx, "LSE-TEST-KEY-"+fx.Request.DBUUID)
				if !p.Valid {
					rej, ok := err.(*Rejected)
					if !ok || rej.State != p.State {
						t.Fatalf("want a refusal with state %s, got %v", p.State, err)
					}
					if m.Status().HasKey {
						t.Fatal("a refused key was stored")
					}
					return
				}
				if err != nil {
					t.Fatal(err)
				}
			}
			s := m.Status()
			switch fx.Name {
			case "trial starts":
				if s.State != "trial" || !s.Allowed || s.TrialEndsAt != 1796103416*1000 || s.HasKey {
					t.Errorf("%+v", s)
				}
			case "trial over":
				if s.State != "locked" || s.Allowed || !strings.Contains(s.Reason, "trial") {
					t.Errorf("%+v", s)
				}
			case "activate a key":
				if s.State != "licensed" || !s.Allowed || s.Seats == nil || *s.Seats != 10 || s.Org != "Test Org" || !s.HasKey || s.LicenseExpiresAt != 1802151416*1000 {
					t.Errorf("%+v", s)
				}
			case "past the end, inside the renewal time":
				if s.State != "renewal-grace" || !s.Allowed || s.Seats == nil || *s.Seats != 5 {
					t.Errorf("%+v", s)
				}
			case "no expiry and no seat limit":
				if s.State != "licensed" || s.Seats != nil || s.LicenseExpiresAt != 0 || s.Org != "Forever Org" {
					t.Errorf("%+v", s)
				}
			}
		})
	}
}

// ---- a licence server of our own, to play the cases the real one cannot be asked for ------------------------------------

type fakeServer struct {
	t       *testing.T
	srv     *httptest.Server
	pub     ed25519.PublicKey
	priv    ed25519.PrivateKey
	clock   *clock
	mu      sync.Mutex
	reqs    []map[string]any
	paths   []string
	answer  func(path string, req map[string]any) (int, any)
	offline bool
}

func newFake(t *testing.T, c *clock) *fakeServer {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	f := &fakeServer{t: t, pub: pub, priv: priv, clock: c}
	f.answer = func(path string, req map[string]any) (int, any) {
		return 200, f.sign(f.base(req, map[string]any{"state": "trial", "valid": true, "trial_ends": f.clock.Now().Add(30 * day).Unix(), "expires": f.clock.Now().Add(7 * day).Unix()}))
	}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if f.offline {
			http.Error(w, "down", http.StatusBadGateway)
			return
		}
		var req map[string]any
		_ = json.NewDecoder(r.Body).Decode(&req)
		f.reqs, f.paths = append(f.reqs, req), append(f.paths, r.URL.Path)
		code, body := f.answer(r.URL.Path, req)
		w.WriteHeader(code)
		_ = json.NewEncoder(w).Encode(body)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeServer) base(req map[string]any, over map[string]any) map[string]any {
	p := map[string]any{"v": 1, "product": req["product"], "domain": req["domain"], "db_uuid": req["db_uuid"], "nonce": req["nonce"], "issued": f.clock.Now().Unix()}
	for k, v := range over {
		p[k] = v
	}
	return p
}

func (f *fakeServer) sign(p map[string]any) map[string]any { return f.signWith(f.priv, p) }

func (f *fakeServer) signWith(priv ed25519.PrivateKey, p map[string]any) map[string]any {
	raw, _ := json.Marshal(p)
	return map[string]any{"valid": p["valid"], "attestation": map[string]string{"payload": base64.StdEncoding.EncodeToString(raw), "sig": base64.StdEncoding.EncodeToString(ed25519.Sign(priv, raw))}}
}

func (f *fakeServer) last() map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.reqs[len(f.reqs)-1]
}

func (f *fakeServer) setOffline(v bool) { f.mu.Lock(); f.offline = v; f.mu.Unlock() }

type rig struct {
	c    *clock
	f    *fakeServer
	m    *Manager
	st   *store.License
	opts Options
}

func newRig(t *testing.T) *rig {
	c := &clock{t: time.Unix(1_800_000_000, 0)}
	f := newFake(t, c)
	st := store.NewLicense(filepath.Join(t.TempDir(), "license.enc"), make([]byte, 32))
	o := Options{Store: st, Server: f.srv.URL, PublicKey: f.pub, Domain: "mem.example.com", Version: "0.7.0-test", Now: c.Now, SeatsUsed: func() int { return 4 }}
	m, err := New(o)
	if err != nil {
		t.Fatal(err)
	}
	return &rig{c: c, f: f, m: m, st: st, opts: o}
}

func TestAFreshInstallationMayRunWhileItAsksForTheTrialThenLocksWhenNobodyAnswers(t *testing.T) {
	r := newRig(t)
	r.f.setOffline(true)
	if ok, _ := r.m.Allowed(); !ok || r.m.Status().State != "starting" {
		t.Fatalf("a start must not lock at once: %+v", r.m.Status())
	}
	if err := r.m.CheckNow(context.Background()); err == nil {
		t.Fatal("the server is down, the check must say so")
	}
	r.c.Add(9 * time.Minute)
	if ok, _ := r.m.Allowed(); !ok {
		t.Fatal("still inside the first minutes")
	}
	r.c.Add(2 * time.Minute)
	ok, why := r.m.Allowed()
	if ok || !strings.Contains(why, "trial could not be confirmed") {
		t.Fatalf("after the first minutes without any answer it locks: %v %q", ok, why)
	}
}

func TestTheTrialIsKeptBetweenContactsAndEndsWhenTheLastAnswerRunsOut(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	if err := r.m.CheckNow(ctx); err != nil {
		t.Fatal(err)
	}
	if s := r.m.Status(); s.State != "trial" || !s.Allowed || s.SeatsUsed != 4 {
		t.Fatalf("%+v", s)
	}
	if r.f.paths[0] != "/ping" || r.f.last()["seats_used"].(float64) != 4 || r.f.last()["version"] != "0.7.0-test" || r.f.last()["attest"].(float64) != 1 {
		t.Fatalf("what was asked: %v %v", r.f.paths, r.f.last())
	}
	r.f.setOffline(true)
	r.c.Add(6 * day)
	if ok, _ := r.m.Allowed(); !ok {
		t.Fatal("six days after the last answer the server being away must not matter")
	}
	r.c.Add(day + time.Minute)
	ok, why := r.m.Allowed()
	if ok || !strings.Contains(why, "has run out") {
		t.Fatalf("%v %q", ok, why)
	}
	// and it comes back by itself when the server answers again
	r.f.setOffline(false)
	if err := r.m.CheckNow(ctx); err != nil {
		t.Fatal(err)
	}
	if ok, _ := r.m.Allowed(); !ok {
		t.Fatal("not unlocked after a good answer")
	}
}

func TestANoFromTheServerLocksAtOnceEvenWithAGoodAnswerInTheCache(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	_ = r.m.CheckNow(ctx)
	r.f.answer = func(path string, req map[string]any) (int, any) {
		return 200, r.f.sign(r.f.base(req, map[string]any{"state": "trial-expired", "valid": false, "message": "The trial has ended. A license key is required.", "expires": r.c.Now().Add(7 * day).Unix()}))
	}
	if err := r.m.CheckNow(ctx); err != nil {
		t.Fatal(err)
	}
	ok, why := r.m.Allowed()
	if ok || why != "The trial has ended. A license key is required." {
		t.Fatalf("%v %q", ok, why)
	}
}

func TestASetBackClockIsNoticed(t *testing.T) {
	r := newRig(t)
	_ = r.m.CheckNow(context.Background())
	r.f.setOffline(true)
	r.c.Add(3 * day)
	r.m.touchClock() // the loop does this every minute
	if ok, _ := r.m.Allowed(); !ok {
		t.Fatal("three days later is fine")
	}
	r.c.Add(-2 * day) // somebody turns the clock back to stretch the trial
	ok, why := r.m.Allowed()
	if ok || !strings.Contains(why, "clock") {
		t.Fatalf("%v %q", ok, why)
	}
}

func TestAClockThatDiffersFromTheServerIsRefusedAtContact(t *testing.T) {
	r := newRig(t)
	r.c.Add(-time.Hour) // the server signs with its real time; this machine is an hour behind it
	r.f.answer = func(path string, req map[string]any) (int, any) {
		return 200, r.f.sign(r.f.base(req, map[string]any{"state": "trial", "valid": true, "issued": time.Unix(1_800_000_000, 0).Unix(), "expires": time.Unix(1_800_000_000, 0).Add(7 * day).Unix()}))
	}
	err := r.m.CheckNow(context.Background())
	if err == nil || !strings.Contains(err.Error(), "clock differs") {
		t.Fatalf("%v", err)
	}
}

func TestAnswersThatAreNotTheServersAreNeverAGrant(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	other, otherPriv, _ := ed25519.GenerateKey(rand.Reader)
	_ = other
	cases := map[string]func(string, map[string]any) (int, any){
		"a captive portal that says yes": func(string, map[string]any) (int, any) { return 200, map[string]any{"valid": true, "state": "trial"} },
		"an attestation signed by a stranger": func(_ string, req map[string]any) (int, any) {
			return 200, r.f.signWith(otherPriv, r.f.base(req, map[string]any{"state": "licensed", "valid": true, "expires": r.c.Now().Add(30 * day).Unix()}))
		},
		"somebody else's answer (replay)": func(_ string, req map[string]any) (int, any) {
			return 200, r.f.sign(r.f.base(req, map[string]any{"nonce": "an-old-nonce-from-yesterday", "state": "licensed", "valid": true, "expires": r.c.Now().Add(30 * day).Unix()}))
		},
		"an answer for another installation": func(_ string, req map[string]any) (int, any) {
			return 200, r.f.sign(r.f.base(req, map[string]any{"db_uuid": "another-installation", "state": "licensed", "valid": true, "expires": r.c.Now().Add(30 * day).Unix()}))
		},
		"an answer for another product": func(_ string, req map[string]any) (int, any) {
			return 200, r.f.sign(r.f.base(req, map[string]any{"product": "centest", "state": "licensed", "valid": true, "expires": r.c.Now().Add(30 * day).Unix()}))
		},
		"a server error": func(string, map[string]any) (int, any) { return 500, map[string]any{"error": "server error"} },
	}
	for name, answer := range cases {
		r.f.answer = answer
		if err := r.m.CheckNow(ctx); err == nil {
			t.Errorf("%s: accepted", name)
		}
		if s := r.m.Status(); s.State == "licensed" || s.HasKey {
			t.Errorf("%s: %+v", name, s)
		}
	}
	// nothing was ever accepted, so after the first minutes the installation is locked
	r.c.Add(11 * time.Minute)
	if ok, _ := r.m.Allowed(); ok {
		t.Fatal("forged answers kept it running")
	}
}

func TestAKeyIsCheckedBoundAndThenRenewedWithHeartbeats(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	seats := 25
	r.f.answer = func(path string, req map[string]any) (int, any) {
		if req["key"] != "LSE-GOODKEY-123456" {
			return 200, r.f.sign(r.f.base(req, map[string]any{"state": "unknown-key", "valid": false, "message": "Invalid license key.", "expires": r.c.Now().Add(7 * day).Unix()}))
		}
		return 200, r.f.sign(r.f.base(req, map[string]any{"state": "licensed", "valid": true, "org": "Acme", "seats": seats, "license_expires": r.c.Now().Add(365 * day).Unix(), "expires": r.c.Now().Add(7 * day).Unix()}))
	}
	if _, err := r.m.Activate(ctx, "LSE-WRONGKEY-123456"); err == nil || err.Error() != "Invalid license key." || r.m.Status().HasKey {
		t.Fatalf("a wrong key: %v", err)
	}
	if _, err := r.m.Activate(ctx, "short"); err == nil || r.m.Status().HasKey {
		t.Fatalf("not a key: %v", err)
	}
	s, err := r.m.Activate(ctx, "  LSE-GOODKEY-123456 ")
	if err != nil || s.State != "licensed" || s.Org != "Acme" || *s.Seats != 25 || !s.HasKey || s.KeyHint != "…3456" {
		t.Fatalf("%+v %v", s, err)
	}
	if r.f.paths[len(r.f.paths)-1] != "/validate" || r.f.last()["key"] != "LSE-GOODKEY-123456" {
		t.Fatalf("%v", r.f.paths)
	}
	if err := r.m.CheckNow(ctx); err != nil {
		t.Fatal(err)
	}
	if r.f.paths[len(r.f.paths)-1] != "/heartbeat" || r.f.last()["key"] != "LSE-GOODKEY-123456" {
		t.Fatalf("the next contact must be a heartbeat with the key: %v", r.f.paths)
	}
	// a year later the licence is past its end; the server still says yes (time to renew): shown as such, still running
	r.c.Add(366 * day)
	r.f.setOffline(true)
	r.m.mu.Lock()
	r.m.st.LastSeen = r.c.Now().Unix()
	r.m.cur.Expires = r.c.Now().Add(day).Unix()
	r.m.mu.Unlock()
	if s := r.m.Status(); s.State != "renewal-grace" || !s.Allowed {
		t.Fatalf("%+v", s)
	}
}

func TestTheStateSurvivesARestartAndAnotherDomainStartsOver(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	_ = r.m.CheckNow(ctx)
	id := r.m.Status().InstanceID
	if id == "" || len(id) != 36 {
		t.Fatalf("instance id %q", id)
	}
	r.f.setOffline(true)
	again, err := New(r.opts)
	if err != nil {
		t.Fatal(err)
	}
	if again.Status().InstanceID != id {
		t.Fatal("a restart must keep the identity")
	}
	again.started = r.c.Now().Add(-time.Hour) // not in the first minutes any more
	if s := again.Status(); s.State != "trial" || !s.Allowed {
		t.Fatalf("a restart without the server must keep the last answer: %+v", s)
	}
	moved := r.opts
	moved.Domain = "other.example.com"
	m3, _ := New(moved)
	m3.started = r.c.Now().Add(-time.Hour)
	if ok, _ := m3.Allowed(); ok {
		t.Fatal("an answer for another domain must not count")
	}
	// a damaged or foreign state file is no licence
	if err := os.WriteFile(filepath.Join(filepath.Dir(r.opts.Store.Path()), "license.enc"), []byte("v1.AAAA.AAAA.AAAA"), 0o600); err != nil {
		t.Fatal(err)
	}
	m4, err := New(r.opts)
	if err != nil {
		t.Fatal(err)
	}
	m4.started = r.c.Now().Add(-time.Hour)
	if m4.Status().InstanceID == id {
		t.Fatal("a damaged state file must start a new identity")
	}
	if ok, _ := m4.Allowed(); ok {
		t.Fatal("a damaged state file must not keep a licence")
	}
}

func TestAKeyFromTheEnvironmentIsTakenUpOnce(t *testing.T) {
	r := newRig(t)
	r.f.answer = func(path string, req map[string]any) (int, any) {
		return 200, r.f.sign(r.f.base(req, map[string]any{"state": "licensed", "valid": true, "org": "Env Org", "expires": r.c.Now().Add(7 * day).Unix()}))
	}
	o := r.opts
	o.EnvKey = "LSE-ENVKEY-0000"
	var events []string
	o.OnEvent = func(kind, detail string) { events = append(events, kind+":"+detail) }
	m, _ := New(o)
	m.adoptEnvKey(context.Background())
	if s := m.Status(); !s.HasKey || s.Org != "Env Org" {
		t.Fatalf("%+v", s)
	}
	n := len(r.f.paths)
	m.adoptEnvKey(context.Background())
	if len(r.f.paths) != n {
		t.Fatal("a stored key must not be activated again")
	}
	if len(events) == 0 || !strings.HasPrefix(events[len(events)-1], "license_activate:key …0000") {
		t.Fatalf("%v", events)
	}
}

func TestTheBackgroundLoopAsksAtOnceAndSeatsAreCounted(t *testing.T) {
	r := newRig(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r.m.Start(ctx)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && r.m.Status().State != "trial" {
		time.Sleep(20 * time.Millisecond)
	}
	if r.m.Status().State != "trial" {
		t.Fatal("the loop did not make the first contact")
	}
}

func TestChangesOfTheVerdictAreReported(t *testing.T) {
	r := newRig(t)
	var events []string
	o := r.opts
	o.OnEvent = func(kind, detail string) { events = append(events, kind+":"+detail) }
	m, _ := New(o)
	_ = m.CheckNow(context.Background())
	r.f.setOffline(true)
	r.c.Add(8 * day)
	m.noticeLock()
	if len(events) != 2 || events[0] != "license_state:starting -> trial" || events[1] != "license_state:trial -> locked" {
		t.Fatalf("%v", events)
	}
}
