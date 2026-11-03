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
