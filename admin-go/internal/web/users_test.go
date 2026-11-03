package web

import (
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/lsegroup/mnemosyne/admin-go/internal/secrets"
)

// Owner order 2026-11-03: user management that tracks the seats - who holds them, since when, and a way to free one.
func TestTheUsersPageListsTheSeatHoldersAndFreesASeat(t *testing.T) {
	r := newLicenceRig(t)
	cookie, _ := r.localCookie("Admin", "correct horse")

	// what the server wrote when people signed in with GitLab and made tokens (the files the Node server owns)
	seal := func(path string, v any) {
		raw, _ := json.Marshal(v)
		sealed, err := secrets.Seal(r.srv.keys.Enc, string(raw))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(sealed), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Now()
	projects := []map[string]any{{"id": 1, "name": "A"}, {"id": 2, "name": "B"}}
	seal(r.srv.cfg.MembersFile, map[string]any{
		"Alice": map[string]any{"at": now.Add(-time.Hour).UnixMilli(), "admin": true, "projects": projects},
		"bob":   map[string]any{"at": now.Add(-48 * time.Hour).UnixMilli(), "admin": false, "projects": projects[:1]},
	})
	seal(r.srv.cfg.TokensFile, []map[string]any{
		{"user": "alice", "expiresAt": now.Add(24 * time.Hour).UnixMilli()},
		{"user": "alice", "expiresAt": now.Add(48 * time.Hour).UnixMilli()},
		{"user": "alice", "expiresAt": now.Add(48 * time.Hour).UnixMilli(), "revokedAt": now.UnixMilli()}, // revoked: not counted
	})

	for _, u := range []string{"alice", "bob", "carol", "dave"} {
		r.do(call{path: "/p/alpha", headers: r.person(t, u)})
	}
	r.do(call{path: "/p/alpha", headers: r.person(t, "erin")}) // the fifth: refused

	got := r.api(cookie, "GET", "/users", "")
	eq(t, got.status, 200, "users")
	j := got.json(t)
	eq(t, j["edition"], any("free"), "edition")
	eq(t, j["used"], any(float64(4)), "seats used")
	eq(t, j["limit"], any(float64(4)), "limit")
	users := j["users"].([]any)
	eq(t, len(users), 4, "four seat holders")
	first := users[0].(map[string]any)
	eq(t, first["user"], any("alice"), "the first to take a seat is first")
	eq(t, first["admin"], any(true), "GitLab administrator")
	eq(t, first["tokens"], any(float64(2)), "two active tokens, the revoked one is not counted")
	eq(t, first["projects"], any(float64(2)), "projects")
	if first["firstSeen"].(float64) == 0 || first["lastSeen"].(float64) == 0 || first["lastSignIn"].(float64) == 0 {
		t.Errorf("times: %v", first)
	}
	bob := users[1].(map[string]any)
	eq(t, bob["admin"], any(false), "member")
	eq(t, bob["tokens"], any(float64(0)), "no tokens")
	carol := users[2].(map[string]any) // never signed in through the server's member file: only the seat is known
	eq(t, carol["lastSignIn"], any(float64(0)), "no sign-in record")
	refused := j["refused"].([]any)
	eq(t, len(refused), 1, "one refused person")
	eq(t, refused[0].(map[string]any)["user"], any("erin"), "who")

	// free a seat: the next person can take it
	del := r.api(cookie, "DELETE", "/users/bob", "")
	eq(t, del.status, 200, "free the seat: "+del.body)
	eq(t, del.json(t)["used"], any(float64(3)), "seats in use")
	eq(t, r.do(call{path: "/p/alpha", headers: r.person(t, "erin")}).status, 200, "erin takes the freed seat")
	again := r.api(cookie, "GET", "/users", "").json(t)
	eq(t, again["used"], any(float64(4)), "full again")
	eq(t, len(again["refused"].([]any)), 0, "erin is no longer listed as refused")
	trail := r.api(cookie, "GET", "/audit", "").body
	has(t, trail, "seat_release")
	has(t, trail, "Freed the seat of bob")

	// bad requests
	eq(t, r.api(cookie, "DELETE", "/users/nobody", "").status, 404, "not a seat holder")
	eq(t, r.api(cookie, "DELETE", "/users/bad%20name%3B", "").status, 400, "not a user name")
}

func TestTheUsersPageIsForAdministratorsOnlyAndNotOpenToCrossSiteCalls(t *testing.T) {
	r := newLicenceRig(t)
	r.do(call{path: "/p/alpha", headers: r.person(t, "alice")})
	eq(t, r.api("", "GET", "/users", "").status, 401, "not signed in")
	eq(t, r.api("", "DELETE", "/users/alice", "").status, 401, "not signed in")
	cookie, _ := r.localCookie("Admin", "correct horse")
	cross := r.do(call{method: "DELETE", path: "/admin/api/users/alice", cookie: cookie, headers: map[string]string{"Origin": "https://evil.example"}})
	eq(t, cross.status, 403, "cross-site")
	eq(t, r.srv.seats.Count(), 1, "the seat is still there")
}

func TestALicencedInstallationShowsItsSeatsAndTheTabIsInTheMenu(t *testing.T) {
	r := newLicenceRig(t)
	cookie, _ := r.localCookie("Admin", "correct horse")
	r.api(cookie, "POST", "/license/activate", `{"key":"LSE-GOODKEY-123456"}`)
	for _, u := range []string{"a", "b", "c", "d", "e", "f"} {
		eq(t, r.do(call{path: "/p/alpha", headers: r.person(t, u)}).status, 200, u+" has a seat")
	}
	j := r.api(cookie, "GET", "/users", "").json(t)
	eq(t, j["edition"], any("licensed"), "edition")
	eq(t, j["used"], any(float64(6)), "six seats")
	eq(t, j["limit"], any(float64(25)), "the seats of the licence")

	page := r.do(call{path: "/admin/", cookie: cookie}).body
	has(t, page, `<a href="#users" data-tab="users">Users</a>`)
	has(t, page, `<section id="tab-users"`)
	has(t, page, "Free this seat")
}
