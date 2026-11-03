package store

import (
	"encoding/json"
	"strings"
	"sync"
	"time"
)

// Seats is the register of the people who use this installation: the first ones to sign in to the documentation portal take the seats,
// up to the number the edition allows (5 without a licence, the seats of the licence with one). Once the seats are taken another person
// is refused until a seat is freed or a licence raises the number. A sealed file, like the others; only the admin program writes it.
type Seats struct {
	f      sealedFile
	loaded bool
	users  map[string]int64 // lower-case GitLab user name -> when the seat was taken (unix ms)
	mu     sync.Mutex
}

// NewSeats opens (lazily) the sealed seat register.
func NewSeats(path string, encKey []byte) *Seats {
	return &Seats{f: sealedFile{path: path, key: encKey}}
}

func (s *Seats) load() {
	if s.loaded {
		return
	}
	s.loaded = true
	s.users = map[string]int64{}
	if raw, err := s.f.read(); err == nil && raw != nil {
		var m map[string]int64
		if json.Unmarshal(raw, &m) == nil {
			s.users = m
		}
	}
}

// Admit says whether this person may use the installation, taking a free seat when there is one. limit < 0 means no limit. A person who
// already has a seat is always admitted.
func (s *Seats) Admit(user string, limit int, now time.Time) bool {
	user = strings.ToLower(strings.TrimSpace(user))
	if user == "" {
		return true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.load()
	if _, ok := s.users[user]; ok {
		return true
	}
	if limit >= 0 && len(s.users) >= limit {
		return false
	}
	s.users[user] = now.UnixMilli()
	if doc, err := json.Marshal(s.users); err == nil {
		_ = s.f.write(doc)
	}
	return true
}

// Count is how many seats are taken.
func (s *Seats) Count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.load()
	return len(s.users)
}

// Release frees the seat of a person (a person who left).
func (s *Seats) Release(user string) {
	user = strings.ToLower(strings.TrimSpace(user))
	s.mu.Lock()
	defer s.mu.Unlock()
	s.load()
	if _, ok := s.users[user]; !ok {
		return
	}
	delete(s.users, user)
	if doc, err := json.Marshal(s.users); err == nil {
		_ = s.f.write(doc)
	}
}
