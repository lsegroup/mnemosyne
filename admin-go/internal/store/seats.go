// SPDX-License-Identifier: Apache-2.0
package store

import (
	"encoding/json"
	"sort"
	"strings"
	"sync"
	"time"
)

// Seats is the register of the people who use this installation: the first people to sign in to the documentation portal take the seats, up to
// the number the edition allows (4 without a licence, the seats of the licence with one). Once the seats are taken another person is refused until
// a seat is freed or a licence raises the number. A sealed file, like the others; only the admin program writes it.
type Seats struct {
	f         sync.Mutex
	file      sealedFile
	loaded    bool
	users     map[string]*Seat // lower-case GitLab user name
	persisted time.Time        // when the last-seen times were last written
}

// Seat is one person who holds a seat.
type Seat struct {
	User string `json:"user"`
	// FirstSeen is when the seat was taken, LastSeen when the person was last seen at the front door (unix ms).
	FirstSeen int64 `json:"firstSeen"`
	LastSeen  int64 `json:"lastSeen"`
}

// seatsWriteEvery is how often the last-seen times are written: every new seat and every release is written at once, a person who just keeps
// working only moves a time in memory.
const seatsWriteEvery = time.Minute

// NewSeats opens (lazily) the sealed seat register.
func NewSeats(path string, encKey []byte) *Seats {
	return &Seats{file: sealedFile{path: path, key: encKey}}
}

func (s *Seats) load() {
	if s.loaded {
		return
	}
	s.loaded = true
	s.users = map[string]*Seat{}
	raw, err := s.file.read()
	if err != nil || raw == nil {
		return
	}
	var now map[string]Seat
	if json.Unmarshal(raw, &now) == nil {
		for u, v := range now {
			v := v
			v.User = u
			s.users[u] = &v
		}
		return
	}
	var old map[string]int64 // the first version of the file: user -> when the seat was taken
	if json.Unmarshal(raw, &old) == nil {
		for u, at := range old {
			s.users[u] = &Seat{User: u, FirstSeen: at, LastSeen: at}
		}
	}
}

func (s *Seats) save(now time.Time) {
	doc := map[string]Seat{}
	for u, v := range s.users {
		doc[u] = Seat{FirstSeen: v.FirstSeen, LastSeen: v.LastSeen}
	}
	if b, err := json.Marshal(doc); err == nil {
		_ = s.file.write(b)
		s.persisted = now
	}
}

// Admit says whether this person may use the installation, taking a free seat when there is one. limit < 0 means no limit. A person who
// already has a seat is always admitted (and seen again).
func (s *Seats) Admit(user string, limit int, now time.Time) bool {
	user = strings.ToLower(strings.TrimSpace(user))
	if user == "" {
		return true
	}
	s.f.Lock()
	defer s.f.Unlock()
	s.load()
	if seat, ok := s.users[user]; ok {
		seat.LastSeen = now.UnixMilli()
		if now.Sub(s.persisted) >= seatsWriteEvery {
			s.save(now)
		}
		return true
	}
	if limit >= 0 && len(s.users) >= limit {
		return false
	}
	s.users[user] = &Seat{User: user, FirstSeen: now.UnixMilli(), LastSeen: now.UnixMilli()}
	s.save(now)
	return true
}

// Count is how many seats are taken.
func (s *Seats) Count() int {
	s.f.Lock()
	defer s.f.Unlock()
	s.load()
	return len(s.users)
}

// List is everybody who holds a seat, the one who took it first at the top.
func (s *Seats) List() []Seat {
	s.f.Lock()
	defer s.f.Unlock()
	s.load()
	out := make([]Seat, 0, len(s.users))
	for _, v := range s.users {
		out = append(out, *v)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].FirstSeen != out[j].FirstSeen {
			return out[i].FirstSeen < out[j].FirstSeen
		}
		return out[i].User < out[j].User
	})
	return out
}

// Release frees the seat of a person (a person who left). It reports whether the person had one.
func (s *Seats) Release(user string) bool {
	user = strings.ToLower(strings.TrimSpace(user))
	s.f.Lock()
	defer s.f.Unlock()
	s.load()
	if _, ok := s.users[user]; !ok {
		return false
	}
	delete(s.users, user)
	s.save(time.Now())
	return true
}
