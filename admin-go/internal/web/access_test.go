package web

import (
	"reflect"
	"testing"

	"github.com/lsegroup/mnemosyne/admin-go/internal/store"
)

// Owner order 2026-11-06: administrators and project owners may generate documentation and pictures by default; a switch per level in
// the admin area grants or revokes it. The scheduler and the admin area stay with GitLab administrators.
// same compares values that eq (comparable only) cannot.
func same(t *testing.T, got, want any, what string) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Errorf("%s: got %v, want %v", what, got, want)
	}
}

func TestTheAccessTabSetsWhoMayGenerateAndStartsWithAdministratorsAndOwners(t *testing.T) {
	r := newLicenceRig(t)
	cookie, _ := r.localCookie("Admin", "correct horse")

	// nothing saved: administrators and owners
	got := r.api(cookie, "GET", "/access", "")
	eq(t, got.status, 200, "access: "+got.body)
	on := map[string]bool{}
	var order []string
	for _, l := range got.json(t)["levels"].([]any) {
		m := l.(map[string]any)
		order = append(order, m["key"].(string))
		on[m["key"].(string)] = m["on"].(bool)
	}
	same(t, order, []string{"admin", "owner", "maintainer", "developer", "reporter", "guest"}, "levels, highest first")
	same(t, on, map[string]bool{"admin": true, "owner": true, "maintainer": false, "developer": false, "reporter": false, "guest": false}, "default")

	// grant maintainers and developers, revoke owners
	put := r.api(cookie, "PUT", "/access", `{"admin":true,"owner":false,"maintainer":true,"developer":true,"reporter":false,"guest":false}`)
	eq(t, put.status, 200, "save: "+put.body)
	saved, err := r.srv.settings.Get()
	if err != nil {
		t.Fatal(err)
	}
	same(t, saved.GenerateRoles(), map[string]bool{"admin": true, "owner": false, "maintainer": true, "developer": true, "reporter": false, "guest": false}, "saved switches")
	again := r.api(cookie, "GET", "/access", "").json(t)["levels"].([]any)
	eq(t, again[1].(map[string]any)["on"], any(false), "owners are off now")
	eq(t, again[3].(map[string]any)["on"], any(true), "developers are on now")

	// the change is in the audit trail with what changed
	trail := r.api(cookie, "GET", "/audit", "").body
	has(t, trail, "Who may generate documentation and pictures changed")
	has(t, trail, "- owner: true")
	has(t, trail, "+ developer: true")

	// bad input: every level needs a true or false
	eq(t, r.api(cookie, "PUT", "/access", `{"admin":true,"owner":"yes","maintainer":true,"developer":true,"reporter":false,"guest":false}`).status, 400, "not a boolean")
	eq(t, r.api(cookie, "PUT", "/access", `{"admin":true}`).status, 400, "levels missing")

	// another part of the settings changing (once SSO is live the local sign-in ends, so this comes last) keeps what was saved here
	if _, err := r.srv.settings.Update(func(p *store.Portal) error { p.SSOLiveAt = 1; return nil }); err != nil {
		t.Fatal(err)
	}
	after, _ := r.srv.settings.Get()
	eq(t, after.GenerateRoles()["developer"], true, "still granted after another part of the settings changed")

	// a saved partial map (written by something else) falls back to the default for the missing levels
	same(t, store.Portal{Generate: map[string]bool{"guest": true}}.GenerateRoles(), map[string]bool{"admin": true, "owner": true, "maintainer": false, "developer": false, "reporter": false, "guest": true}, "missing levels use the default")
}

func TestTheAccessTabIsInTheMenuAndForAdministratorsOnly(t *testing.T) {
	r := newLicenceRig(t)
	eq(t, r.api("", "GET", "/access", "").status, 401, "not signed in")
	eq(t, r.api("", "PUT", "/access", `{}`).status, 401, "not signed in")
	cookie, _ := r.localCookie("Admin", "correct horse")
	cross := r.do(call{method: "PUT", path: "/admin/api/access", cookie: cookie, body: `{"admin":false,"owner":false,"maintainer":false,"developer":false,"reporter":false,"guest":false}`, headers: map[string]string{"Origin": "https://evil.example"}})
	eq(t, cross.status, 403, "cross-site")
	saved, _ := r.srv.settings.Get()
	eq(t, saved.GenerateRoles()["admin"], true, "nothing changed")

	page := r.do(call{path: "/admin/", cookie: cookie}).body
	has(t, page, `<a href="#access" data-tab="access">Access</a>`)
	has(t, page, `<section id="tab-access"`)
	has(t, page, "Who may generate")
}
