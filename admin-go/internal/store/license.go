// SPDX-License-Identifier: Apache-2.0

package store

import (
	"encoding/json"
	"strings"
	"time"
)

// LicenseState is what this installation remembers about its licence: who it is (an id made once), the key a person entered, and the
// last signed answer of the licence server. Sealed like the other files; only the admin program reads and writes it.
type LicenseState struct {
	InstanceID string `json:"instanceId"`
	Key        string `json:"key,omitempty"`
	// Payload and Sig are the last signed answer of the licence server (base64), verified again every time they are loaded.
	Payload string `json:"payload,omitempty"`
	Sig     string `json:"sig,omitempty"`
	// ReceivedAt is when (unix seconds, local clock) that answer arrived.
	ReceivedAt int64 `json:"receivedAt,omitempty"`
	// LastSeen is the latest time this installation has seen on its clock or from the licence server (unix seconds): a clock
	// that is set back below it is noticed.
	LastSeen  int64 `json:"lastSeen,omitempty"`
	CreatedAt int64 `json:"createdAt,omitempty"`
}

// License is the sealed licence state file.
type License struct{ f sealedFile }

// NewLicense opens (lazily) the sealed licence file.
func NewLicense(path string, encKey []byte) *License {
	return &License{f: sealedFile{path: path, key: encKey}}
}

// Load returns the state; a missing file is an empty state. An unreadable (tampered) file is an error: the caller starts a new identity.
func (l *License) Load() (LicenseState, error) {
	l.f.mu.Lock()
	defer l.f.mu.Unlock()
	return l.load()
}

func (l *License) load() (LicenseState, error) {
	var st LicenseState
	raw, err := l.f.read()
	if err != nil || raw == nil {
		return st, err
	}
	err = json.Unmarshal(raw, &st)
	return st, err
}

// Update changes the state under the file lock (read, change, write) and returns the new state.
func (l *License) Update(change func(*LicenseState)) (LicenseState, error) {
	l.f.mu.Lock()
	defer l.f.mu.Unlock()
	st, _ := l.load() // an unreadable file is replaced
	change(&st)
	doc, err := json.Marshal(st)
	if err != nil {
		return st, err
	}
	return st, l.f.write(doc)
}

// ActiveUsers is every GitLab user name that signed in to the documentation area since the given time (lower case). The Node server
// writes the members file; this only reads it, to count seats.
func (m *Members) ActiveUsers(since time.Time) []string {
	m.f.mu.Lock()
	defer m.f.mu.Unlock()
	raw, err := m.f.read()
	if err != nil || raw == nil {
		return nil
	}
	var all map[string]Member
	if json.Unmarshal(raw, &all) != nil {
		return nil
	}
	var out []string
	for name, member := range all {
		if member.At >= since.UnixMilli() {
			out = append(out, strings.ToLower(name))
		}
	}
	return out
}

// Tokens is the sealed file of personal MCP tokens (read only here: the Node server issues and checks them).
type Tokens struct{ f sealedFile }

// NewTokens opens (lazily) the sealed tokens file.
func NewTokens(path string, encKey []byte) *Tokens {
	return &Tokens{f: sealedFile{path: path, key: encKey}}
}

// ActiveUsers is every user who holds a token that is neither revoked nor expired at the given time (lower case).
func (t *Tokens) ActiveUsers(now time.Time) []string {
	t.f.mu.Lock()
	defer t.f.mu.Unlock()
	raw, err := t.f.read()
	if err != nil || raw == nil {
		return nil
	}
	var list []struct {
		User      string `json:"user"`
		ExpiresAt int64  `json:"expiresAt"`
		RevokedAt int64  `json:"revokedAt"`
	}
	if json.Unmarshal(raw, &list) != nil {
		return nil
	}
	var out []string
	for _, tk := range list {
		if tk.RevokedAt == 0 && tk.ExpiresAt > now.UnixMilli() {
			out = append(out, strings.ToLower(tk.User))
		}
	}
	return out
}

// ActiveCounts is how many tokens (neither revoked nor expired) every user holds, by lower-case user name.
func (t *Tokens) ActiveCounts(now time.Time) map[string]int {
	out := map[string]int{}
	for _, u := range t.ActiveUsers(now) {
		out[u]++
	}
	return out
}

// Path is where the sealed file lives.
func (l *License) Path() string { return l.f.path }
