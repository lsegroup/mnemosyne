// SPDX-License-Identifier: Apache-2.0
package web

import (
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/lsegroup/mnemosyne/admin-go/internal/audit"
	"github.com/lsegroup/mnemosyne/admin-go/internal/store"
)

// userRow is one person who holds a seat, with what the server knows about them from their sign-ins and their tokens.
type userRow struct {
	User string `json:"user"`
	// FirstSeen is when the seat was taken, LastSeen when the person was last seen (unix ms).
	FirstSeen int64 `json:"firstSeen"`
	LastSeen  int64 `json:"lastSeen"`
	// LastSignIn is the last time GitLab confirmed the person (unix ms; 0 = the server has no record).
	LastSignIn int64 `json:"lastSignIn"`
	// Admin: a GitLab administrator.
	Admin bool `json:"admin"`
	// Tokens is how many personal MCP tokens the person holds that are neither revoked nor expired.
	Tokens   int `json:"tokens"`
	Projects int `json:"projects"`
}

type refusedRow struct {
	User string `json:"user"`
	At   int64  `json:"at"`
}

// getUsers is the seat register: who holds the seats of this installation and how many are left.
func (s *Server) getUsers(_ http.ResponseWriter, _ *http.Request, _ string) (any, error) {
	if err := s.needLicense(); err != nil {
		return nil, err
	}
	members := store.NewMembers(s.cfg.MembersFile, s.keys.Enc).ByUser()
	tokens := store.NewTokens(s.cfg.TokensFile, s.keys.Enc).ActiveCounts(s.now())
	rows := []userRow{}
	for _, seat := range s.seats.List() {
		row := userRow{User: seat.User, FirstSeen: seat.FirstSeen, LastSeen: seat.LastSeen, Tokens: tokens[seat.User]}
		if m, ok := members[seat.User]; ok {
			row.LastSignIn, row.Admin = m.At, m.Admin
			if m.Projects != nil {
				row.Projects = len(*m.Projects)
			}
		}
		rows = append(rows, row)
	}
	s.refusedMu.Lock()
	refused := []refusedRow{}
	for u, t := range s.refused {
		refused = append(refused, refusedRow{User: u, At: t.UnixMilli()})
	}
	s.refusedMu.Unlock()
	sort.Slice(refused, func(i, j int) bool { return refused[i].At > refused[j].At })
	limit := s.seatLimit()
	out := map[string]any{"edition": "free", "used": len(rows), "users": rows, "refused": refused, "freeSeats": FreeSeats}
	if s.edition().Licensed {
		out["edition"] = "licensed"
		out["trial"] = s.lic.Status().State == "trial"
	}
	if limit >= 0 {
		out["limit"] = limit
	} else {
		out["limit"] = nil
	}
	return out, nil
}

var reUser = regexp.MustCompile(`^[A-Za-z0-9_.@-]{1,100}$`)

// releaseSeat frees the seat of a person who left. The person is not blocked: if they sign in to the portal again and a seat is free they
// take one again. Their personal MCP tokens are not touched (they expire on their own, 90 days at most).
func (s *Server) releaseSeat(_ http.ResponseWriter, r *http.Request, who string) (any, error) {
	if err := s.needLicense(); err != nil {
		return nil, err
	}
	user := strings.ToLower(r.PathValue("user"))
	if !reUser.MatchString(user) {
		return nil, &httpError{http.StatusBadRequest, "that is not a user name"}
	}
	if !s.seats.Release(user) {
		return nil, &httpError{http.StatusNotFound, user + " does not hold a seat"}
	}
	s.refusedMu.Lock()
	delete(s.refused, user)
	s.refusedMu.Unlock()
	s.rec(r, audit.Input{Event: "seat_release", EntityType: "seats", EntityName: user, User: who, Description: "Freed the seat of " + user + " (" + strconv.Itoa(s.seats.Count()) + " seats in use)"})
	return map[string]any{"ok": true, "used": s.seats.Count()}, nil
}
