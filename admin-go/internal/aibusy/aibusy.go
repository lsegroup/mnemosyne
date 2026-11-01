// Package aibusy lets the Go admin and the Node server agree that only ONE AI job runs at a time, although they are two processes: a
// small file next to the other portal state says who is working ("auto" = an automatic run, "person" = a job a person started on a
// project page). A lock that is older than a few hours is forgotten, so a crash never blocks the AI for good.
package aibusy

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

// Lock is the file.
type Lock struct{ path string }

// New returns the lock file next to dir's other files.
func New(dir string) *Lock { return &Lock{path: filepath.Join(dir, "ai-busy.json")} }

const stale = 3 * time.Hour

type state struct {
	By    string `json:"by"`
	Since string `json:"since"`
}

// Hold writes the lock for who ("auto" or "person").
func (l *Lock) Hold(by string, now time.Time) {
	_ = os.MkdirAll(filepath.Dir(l.path), 0o755)
	raw, _ := json.Marshal(state{By: by, Since: now.UTC().Format("2006-01-02T15:04:05.000Z")})
	_ = os.WriteFile(l.path, raw, 0o600)
}

// Release removes the lock when it is held by who.
func (l *Lock) Release(by string) {
	if s, ok := l.read(); ok && s.By == by {
		_ = os.Remove(l.path)
	}
}

func (l *Lock) read() (state, bool) {
	raw, err := os.ReadFile(l.path)
	if err != nil {
		return state{}, false
	}
	var s state
	if json.Unmarshal(raw, &s) != nil {
		return state{}, false
	}
	return s, true
}

// HeldBy reports whether somebody other than me holds a fresh lock.
func (l *Lock) HeldBy(other string, now time.Time) bool {
	s, ok := l.read()
	if !ok || s.By != other {
		return false
	}
	since, err := time.Parse(time.RFC3339, s.Since)
	return err == nil && now.Sub(since) < stale
}
