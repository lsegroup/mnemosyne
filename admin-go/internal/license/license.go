// SPDX-License-Identifier: Apache-2.0

// Package license is the licence of this installation. It works like the other LSE products: 30 days free from the first start, then a
// licence key is needed. It asks the licence server, which answers with a SIGNED attestation (Ed25519). Only the public key is in this
// program, so a copy of it cannot invent an answer; the answer names this installation and the request it belongs to, so it cannot be
// replayed for another one. Between two contacts the last attestation is used, until it expires.
//
// What the verdict means for the rest of the program: Allowed() is the single question the front door asks.
package license

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/lsegroup/mnemosyne/admin-go/internal/store"
)

const (
	// Product is the product slug on the licence server.
	Product = "mnemosyne"
	// DefaultServer is the licence server (the same one that licenses the other LSE products).
	DefaultServer = "https://license.globalclouddata.org/License-Server"

	checkEvery     = 12 * time.Hour
	retryEvery     = 30 * time.Minute
	startGrace     = 10 * time.Minute // right after a start nothing is locked while the first contact is made
	clockTolerance = 15 * time.Minute
	callTimeout    = 15 * time.Second
	maxAnswer      = 1 << 20
	persistClock   = 10 * time.Minute
)

// ErrBadSignature: the answer is not signed by the licence server (or damaged).
var ErrBadSignature = errors.New("the answer is not signed by the licence server")

// Rejected is an answer of the licence server that says no (wrong key, bound to another installation, expired ...).
type Rejected struct{ Message, State string }

func (r *Rejected) Error() string { return r.Message }

// Payload is the signed content of an attestation.
type Payload struct {
	V              int    `json:"v"`
	Product        string `json:"product"`
	Domain         string `json:"domain"`
	DBUUID         string `json:"db_uuid"`
	Nonce          string `json:"nonce"`
	Issued         int64  `json:"issued"`
	State          string `json:"state"`
	Valid          bool   `json:"valid"`
	Message        string `json:"message"`
	TrialEnds      int64  `json:"trial_ends"`
	Org            string `json:"org"`
	Seats          *int   `json:"seats"`
	LicenseExpires *int64 `json:"license_expires"`
	Expires        int64  `json:"expires"`
}

// Open checks the signature and reads the payload.
func Open(pub ed25519.PublicKey, payload, sig string) (Payload, error) {
	var p Payload
	raw, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		return p, ErrBadSignature
	}
	sg, err := base64.StdEncoding.DecodeString(sig)
	if err != nil || len(sg) != ed25519.SignatureSize || len(pub) != ed25519.PublicKeySize || !ed25519.Verify(pub, raw, sg) {
		return p, ErrBadSignature
	}
	if err := json.Unmarshal(raw, &p); err != nil || p.V != 1 {
		return p, ErrBadSignature
	}
	return p, nil
}

// Options are what a Manager needs; Now, Client and Nonce exist so tests can replace them.
type Options struct {
	Store     *store.License
	Server    string
	PublicKey ed25519.PublicKey
	// Domain is the host name of the public URL: a licence key is bound to it and to the installation id.
	Domain  string
	Version string
	// SeatsUsed counts the people using this installation; it is reported to the licence server with every contact.
	SeatsUsed func() int
	// EnvKey is a key from the environment, taken up when no key is stored yet.
	EnvKey string
	// FreeWithoutKey: an installation that nobody has given a verdict yet is the free edition, not a locked one. Without a key the licence server is
	// asked for the 30-day trial (once at the first start, then every 12 hours while the trial lasts); it answers "trial" (everything is
	// unlocked for 30 days) or "trial-expired" (the free edition). A licence server that cannot be reached leaves the free edition in force.
	FreeWithoutKey bool
	// OnEvent is told about changes worth an audit entry (kind: license_state, license_activate).
	OnEvent func(kind, detail string)

	Now    func() time.Time
	Client *http.Client
	Nonce  func() string
}

// Manager asks the licence server, keeps the last attestation and answers "may this installation run".
type Manager struct {
	o       Options
	started time.Time
	checkMu sync.Mutex // one conversation with the licence server at a time
	wake    chan struct{}

	mu        sync.RWMutex
	st        store.LicenseState
	cur       *Payload // the verified attestation in st; nil when there is none for this installation
	lastErr   string
	lastTry   time.Time
	lastState string
	clockSave time.Time
}

// New loads (or creates) the state. A state file that cannot be read starts a new identity: nothing is lost that was not already lost.
func New(o Options) (*Manager, error) {
	if len(o.PublicKey) != ed25519.PublicKeySize {
		return nil, errors.New("license: no public key")
	}
	if o.Store == nil {
		return nil, errors.New("license: no state file")
	}
	if o.Server == "" {
		o.Server = DefaultServer
	}
	o.Server = strings.TrimRight(o.Server, "/")
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Client == nil {
		o.Client = &http.Client{Timeout: callTimeout, Transport: &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13}}}
	}
	if o.Nonce == nil {
		o.Nonce = func() string { return randomToken(18) }
	}
	if o.SeatsUsed == nil {
		o.SeatsUsed = func() int { return 0 }
	}
	m := &Manager{o: o, started: o.Now(), wake: make(chan struct{}, 1)}
	st, err := o.Store.Load()
	if err != nil {
		log.Printf("licence state could not be read, starting with a new identity: %v", err)
		st = store.LicenseState{}
	}
	if st.InstanceID == "" {
		st.InstanceID, st.CreatedAt = newUUID(), o.Now().Unix()
		st, err = o.Store.Update(func(s *store.LicenseState) { *s = st })
		if err != nil {
			log.Printf("licence state could not be saved: %v", err)
		}
	}
	m.st = st
	m.adopt()
	m.lastState = m.verdict(o.Now()).state
	return m, nil
}

// adopt verifies the stored attestation again and keeps it only when it was signed for this very installation.
func (m *Manager) adopt() {
	m.cur = nil
	if m.st.Payload == "" {
		return
	}
	p, err := Open(m.o.PublicKey, m.st.Payload, m.st.Sig)
	if err != nil || p.Product != Product || !strings.EqualFold(p.Domain, m.o.Domain) || p.DBUUID != m.st.InstanceID {
		return
	}
	m.cur = &p
}

type verdict struct {
	allowed bool
	state   string
	reason  string
}

func (m *Manager) verdict(now time.Time) verdict {
	p, unix := m.cur, now.Unix()
	switch {
	case p == nil && m.o.FreeWithoutKey && m.st.Key == "":
		return verdict{true, "free", ""}
	case p == nil:
		if now.Sub(m.started) < startGrace {
			return verdict{true, "starting", ""}
		}
		why := "The licence server could not be reached, so the trial could not be confirmed."
		if m.lastErr != "" {
			why += " (" + m.lastErr + ")"
		}
		return verdict{false, "locked", why}
	case !p.Valid:
		why := p.Message
		if why == "" {
			why = "No valid licence."
		}
		return verdict{false, "locked", why}
	case unix < m.st.LastSeen-int64(clockTolerance/time.Second) || unix < p.Issued-int64(clockTolerance/time.Second):
		return verdict{false, "locked", "The system clock was set back. Set the correct time and the licence is checked again."}
	case unix >= p.Expires:
		why := "The last confirmation of the licence server has run out and the server cannot be reached."
		if m.lastErr != "" {
			why += " (" + m.lastErr + ")"
		}
		return verdict{false, "locked", why}
	}
	state := p.State
	if state == "licensed" && p.LicenseExpires != nil && unix > *p.LicenseExpires {
		state = "renewal-grace"
	}
	return verdict{true, state, ""}
}

// Allowed is the question of the front door: may this installation serve requests now?
func (m *Manager) Allowed() (bool, string) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	v := m.verdict(m.o.Now())
	return v.allowed, v.reason
}

// Status is what the admin page shows. Times are milliseconds since 1970 (like the rest of the admin API), 0 = none.
type Status struct {
	Product          string `json:"product"`
	State            string `json:"state"` // free | starting | trial | licensed | renewal-grace | locked
	Allowed          bool   `json:"allowed"`
	Reason           string `json:"reason,omitempty"`
	Org              string `json:"org,omitempty"`
	Seats            *int   `json:"seats"`
	SeatsUsed        int    `json:"seatsUsed"`
	TrialEndsAt      int64  `json:"trialEndsAt"`
	LicenseExpiresAt int64  `json:"licenseExpiresAt"`
	CheckedAt        int64  `json:"checkedAt"`
	HasKey           bool   `json:"hasKey"`
	KeyHint          string `json:"keyHint,omitempty"`
	InstanceID       string `json:"instanceId"`
	Domain           string `json:"domain"`
	Server           string `json:"server"`
	Version          string `json:"version"`
	LastError        string `json:"lastError,omitempty"`
}

// Status describes the licence now.
func (m *Manager) Status() Status {
	used := m.o.SeatsUsed()
	m.mu.RLock()
	defer m.mu.RUnlock()
	v := m.verdict(m.o.Now())
	s := Status{
		Product: Product, State: v.state, Allowed: v.allowed, Reason: v.reason, SeatsUsed: used, HasKey: m.st.Key != "",
		InstanceID: m.st.InstanceID, Domain: m.o.Domain, Server: m.o.Server, Version: m.o.Version, LastError: m.lastErr,
	}
	if k := m.st.Key; len(k) > 4 {
		s.KeyHint = "…" + k[len(k)-4:]
	}
	if m.st.ReceivedAt > 0 {
		s.CheckedAt = m.st.ReceivedAt * 1000
	}
	if p := m.cur; p != nil {
		s.Org, s.Seats = p.Org, p.Seats
		if p.TrialEnds > 0 {
			s.TrialEndsAt = p.TrialEnds * 1000
		}
		if p.LicenseExpires != nil {
			s.LicenseExpiresAt = *p.LicenseExpires * 1000
		}
	}
	return s
}

// signed is a signed answer as it came over the wire; it is kept as received, so it can be verified again after a restart.
type signed struct{ payload, sig string }

// call asks the licence server (path /ping, /validate or /heartbeat) and returns the verified, matching answer.
func (m *Manager) call(ctx context.Context, path, key string) (Payload, signed, error) {
	m.mu.RLock()
	id := m.st.InstanceID
	m.mu.RUnlock()
	nonce := m.o.Nonce()
	req := map[string]any{"domain": m.o.Domain, "db_uuid": id, "product": Product, "attest": 1, "nonce": nonce, "version": m.o.Version, "seats_used": m.o.SeatsUsed()}
	if key != "" {
		req["key"] = key
	}
	body, _ := json.Marshal(req)
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	hr, err := http.NewRequestWithContext(ctx, http.MethodPost, m.o.Server+path, bytes.NewReader(body))
	if err != nil {
		return Payload{}, signed{}, err
	}
	hr.Header.Set("Content-Type", "application/json")
	resp, err := m.o.Client.Do(hr)
	if err != nil {
		return Payload{}, signed{}, fmt.Errorf("the licence server could not be reached: %s", shortErr(err))
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, maxAnswer))
	if resp.StatusCode != http.StatusOK {
		return Payload{}, signed{}, fmt.Errorf("the licence server answered HTTP %d", resp.StatusCode)
	}
	var out struct {
		Attestation *struct {
			Payload string `json:"payload"`
			Sig     string `json:"sig"`
		} `json:"attestation"`
	}
	if json.Unmarshal(raw, &out) != nil || out.Attestation == nil {
		return Payload{}, signed{}, errors.New("the answer carried no signed attestation")
	}
	p, err := Open(m.o.PublicKey, out.Attestation.Payload, out.Attestation.Sig)
	if err != nil {
		return Payload{}, signed{}, err
	}
	if p.Product != Product || !strings.EqualFold(p.Domain, m.o.Domain) || p.DBUUID != id || p.Nonce != nonce {
		return Payload{}, signed{}, errors.New("the answer does not belong to this request")
	}
	if skew := m.o.Now().Sub(time.Unix(p.Issued, 0)); skew > clockTolerance || skew < -clockTolerance {
		return Payload{}, signed{}, fmt.Errorf("the system clock differs from the licence server by %d minutes", int(skew.Abs().Minutes()))
	}
	p.Message = strings.TrimSpace(p.Message)
	return p, signed{out.Attestation.Payload, out.Attestation.Sig}, nil
}

func shortErr(err error) string {
	s := err.Error()
	if i := strings.LastIndex(s, ": "); i >= 0 && i+2 < len(s) && len(s) > 120 {
		s = s[i+2:]
	}
	return s
}

// accept keeps a verified answer (valid or not) as the current one.
func (m *Manager) accept(p Payload, raw signed, key *string) {
	now := m.o.Now()
	m.mu.Lock()
	st, err := m.o.Store.Update(func(s *store.LicenseState) {
		s.Payload, s.Sig, s.ReceivedAt = raw.payload, raw.sig, now.Unix()
		if p.Issued > s.LastSeen {
			s.LastSeen = p.Issued
		}
		if now.Unix() > s.LastSeen {
			s.LastSeen = now.Unix()
		}
		if key != nil {
			s.Key = *key
		}
	})
	if err != nil {
		log.Printf("licence state could not be saved: %v", err)
	}
	m.st, m.cur, m.lastErr, m.clockSave = st, &p, "", now
	was, now2 := m.lastState, m.verdict(now).state
	m.lastState = now2
	m.mu.Unlock()
	if was != now2 && m.o.OnEvent != nil {
		m.o.OnEvent("license_state", fmt.Sprintf("%s -> %s", was, now2))
	}
}

// CheckNow asks the licence server (ping without a key, heartbeat with one) and keeps the answer. An error means the server could not
// be asked or its answer cannot be trusted: the last attestation then stays in force until it runs out.
func (m *Manager) CheckNow(ctx context.Context) error {
	m.checkMu.Lock()
	defer m.checkMu.Unlock()
	m.mu.RLock()
	key := m.st.Key
	m.mu.RUnlock()
	path := "/ping"
	if key != "" {
		path = "/heartbeat"
	}
	p, raw, err := m.call(ctx, path, key)
	m.mu.Lock()
	m.lastTry = m.o.Now()
	if err != nil {
		m.lastErr = err.Error()
		m.mu.Unlock()
		return err
	}
	m.mu.Unlock()
	m.accept(p, raw, nil)
	return nil
}

var keyShape = regexp.MustCompile(`^[A-Za-z0-9-]{8,64}$`)

// Activate checks a licence key with the licence server (which binds it to this installation) and, when it is good, keeps it.
func (m *Manager) Activate(ctx context.Context, key string) (Status, error) {
	key = strings.TrimSpace(key)
	if !keyShape.MatchString(key) {
		return m.Status(), &Rejected{Message: "That is not a licence key.", State: "format"}
	}
	m.checkMu.Lock()
	p, raw, err := m.call(ctx, "/validate", key)
	if err != nil {
		m.checkMu.Unlock()
		return m.Status(), err
	}
	if !p.Valid {
		m.checkMu.Unlock()
		msg := p.Message
		if msg == "" {
			msg = "The licence server refused this key."
		}
		return m.Status(), &Rejected{Message: msg, State: p.State}
	}
	m.accept(p, raw, &key)
	m.checkMu.Unlock()
	return m.Status(), nil
}

// Wake asks the background loop to contact the licence server soon.
func (m *Manager) Wake() {
	select {
	case m.wake <- struct{}{}:
	default:
	}
}

// Start runs the background loop: a first contact at once, then every 12 hours (every 30 minutes while the server cannot be reached).
func (m *Manager) Start(ctx context.Context) {
	go func() {
		m.adoptEnvKey(ctx)
		next := time.Now()
		tick := time.NewTicker(time.Minute)
		defer tick.Stop()
		for {
			m.touchClock()
			m.noticeLock()
			if !time.Now().Before(next) {
				if err := m.CheckNow(ctx); err != nil {
					log.Printf("licence check: %v", err)
					next = time.Now().Add(retryEvery)
				} else {
					next = time.Now().Add(checkEvery)
				}
			}
			select {
			case <-ctx.Done():
				return
			case <-m.wake:
				next = time.Now()
			case <-tick.C:
			}
		}
	}()
}

func (m *Manager) adoptEnvKey(ctx context.Context) {
	m.mu.RLock()
	have := m.st.Key != ""
	m.mu.RUnlock()
	if have || m.o.EnvKey == "" {
		return
	}
	if _, err := m.Activate(ctx, m.o.EnvKey); err != nil {
		log.Printf("licence key from the environment: %v", err)
		return
	}
	if m.o.OnEvent != nil {
		m.o.OnEvent("license_activate", "key …"+m.o.EnvKey[len(m.o.EnvKey)-4:]+" taken from the environment")
	}
}

// touchClock remembers the latest time seen, so a clock set back later is noticed. It is written out now and then, not every minute.
func (m *Manager) touchClock() {
	now := m.o.Now()
	m.mu.Lock()
	defer m.mu.Unlock()
	if now.Unix() > m.st.LastSeen {
		m.st.LastSeen = now.Unix()
	}
	if now.Sub(m.clockSave) < persistClock {
		return
	}
	m.clockSave = now
	last := m.st.LastSeen
	if _, err := m.o.Store.Update(func(s *store.LicenseState) {
		if last > s.LastSeen {
			s.LastSeen = last
		}
	}); err != nil {
		log.Printf("licence state could not be saved: %v", err)
	}
}

// noticeLock writes an audit entry when the verdict changes without a contact (an attestation that ran out).
func (m *Manager) noticeLock() {
	m.mu.Lock()
	now := m.verdict(m.o.Now()).state
	was := m.lastState
	m.lastState = now
	m.mu.Unlock()
	if was != now && m.o.OnEvent != nil {
		m.o.OnEvent("license_state", fmt.Sprintf("%s -> %s", was, now))
	}
}

func randomToken(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func newUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6], b[8] = (b[6]&0x0f)|0x40, (b[8]&0x3f)|0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
