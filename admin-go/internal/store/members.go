package store

import (
	"encoding/json"
)

// MemberProject is a GitLab project a signed-in person belongs to.
type MemberProject struct {
	ID       int    `json:"id"`
	Name     string `json:"name"`
	Path     string `json:"path"`
	FullPath string `json:"fullPath"`
	WebURL   string `json:"webUrl"`
}

// Member is what the documentation area remembers about a signed-in GitLab user. The Node server writes this file; the admin only
// reads it, to name the GitLab project of a notes project.
type Member struct {
	At       int64            `json:"at"`
	Admin    bool             `json:"admin"`
	Projects *[]MemberProject `json:"projects"`
}

// Members is the sealed members file (read only).
type Members struct{ f sealedFile }

// NewMembers opens (lazily) the sealed members file.
func NewMembers(path string, encKey []byte) *Members {
	return &Members{f: sealedFile{path: path, key: encKey}}
}

// KnownProjects is every GitLab project that signed-in people have told us about, once each (the admin area has no project list of its
// own): only for a path and a name. An unreadable or missing file simply knows none.
func (m *Members) KnownProjects() []MemberProject {
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
	seen := map[int]bool{}
	var out []MemberProject
	for _, member := range all {
		if member.Projects == nil {
			continue
		}
		for _, p := range *member.Projects {
			if !seen[p.ID] {
				seen[p.ID] = true
				out = append(out, p)
			}
		}
	}
	return out
}
