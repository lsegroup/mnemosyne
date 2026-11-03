// SPDX-License-Identifier: Apache-2.0

package store

import (
	"path/filepath"
	"testing"
	"time"
)

func TestTheFirstPeopleTakeTheSeatsAndTheRestAreRefused(t *testing.T) {
	enc := make([]byte, 32)
	path := filepath.Join(t.TempDir(), "seats.enc")
	now := time.Now()
	s := NewSeats(path, enc)
	for _, u := range []string{"a", "B", "c"} {
		if !s.Admit(u, 3, now) {
			t.Fatalf("%s should get a seat", u)
		}
	}
	if s.Admit("d", 3, now) {
		t.Error("the fourth person must be refused")
	}
	if !s.Admit("b", 3, now) { // the same person in another spelling already has a seat
		t.Error("a person with a seat is always admitted")
	}
	if s.Count() != 3 {
		t.Errorf("count %d", s.Count())
	}
	// the register is kept: a new process knows who holds the seats
	again := NewSeats(path, enc)
	if again.Count() != 3 || again.Admit("d", 3, now) || !again.Admit("a", 3, now) {
		t.Error("the register was not kept")
	}
	// a seat can be freed, a limit of -1 means no limit, an empty user name is never refused
	again.Release("a")
	if !again.Admit("d", 3, now) {
		t.Error("a freed seat is free")
	}
	for _, u := range []string{"e", "f", "g", "h"} {
		if !again.Admit(u, -1, now) {
			t.Errorf("no limit: %s", u)
		}
	}
	if !again.Admit("", 0, now) {
		t.Error("no user, nothing to count")
	}
}

func TestTheRegisterKnowsWhenASeatWasTakenAndWhenThePersonWasLastSeen(t *testing.T) {
	enc := make([]byte, 32)
	path := filepath.Join(t.TempDir(), "seats.enc")
	t0 := time.Date(2026, 11, 3, 10, 0, 0, 0, time.UTC)
	s := NewSeats(path, enc)
	s.Admit("Alice", 4, t0)
	s.Admit("bob", 4, t0.Add(time.Hour))
	s.Admit("alice", 4, t0.Add(2*time.Hour)) // seen again

	list := s.List()
	if len(list) != 2 || list[0].User != "alice" || list[1].User != "bob" {
		t.Fatalf("the one who took a seat first is first: %+v", list)
	}
	if list[0].FirstSeen != t0.UnixMilli() || list[0].LastSeen != t0.Add(2*time.Hour).UnixMilli() {
		t.Errorf("first and last seen: %+v", list[0])
	}
	// the last-seen time reaches the file (a new process sees it) once a minute has passed, and every new seat is written at once
	s.Admit("alice", 4, t0.Add(3*time.Hour))
	again := NewSeats(path, enc).List()
	if again[0].LastSeen != t0.Add(3*time.Hour).UnixMilli() || len(again) != 2 {
		t.Errorf("written to the file: %+v", again)
	}
	// freeing a seat is written at once and reported
	if !s.Release("ALICE") || s.Release("alice") {
		t.Error("release reports whether the person had a seat")
	}
	if got := NewSeats(path, enc).Count(); got != 1 {
		t.Errorf("count after release: %d", got)
	}
}

// The first version of the file only knew when a seat was taken (user -> unix ms): it still loads.
func TestTheFirstVersionOfTheRegisterFileStillLoads(t *testing.T) {
	enc := make([]byte, 32)
	path := filepath.Join(t.TempDir(), "seats.enc")
	old := &sealedFile{path: path, key: enc}
	if err := old.write([]byte(`{"carol":1793600000000}`)); err != nil {
		t.Fatal(err)
	}
	list := NewSeats(path, enc).List()
	if len(list) != 1 || list[0].User != "carol" || list[0].FirstSeen != 1793600000000 || list[0].LastSeen != 1793600000000 {
		t.Errorf("%+v", list)
	}
}
