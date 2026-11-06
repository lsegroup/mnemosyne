// SPDX-License-Identifier: Apache-2.0
package web

import (
	"net/http"

	"github.com/lsegroup/mnemosyne/admin-go/internal/audit"
	"github.com/lsegroup/mnemosyne/admin-go/internal/store"
)

// accessLevel is one row of the Access tab.
type accessLevel struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Hint  string `json:"hint"`
	On    bool   `json:"on"`
}

var accessLabels = map[string][2]string{
	"admin":      {"GitLab administrators", "Every project. Administrators also keep the admin area and the scheduler (LLM auto) whatever is switched here."},
	"owner":      {"Owners", "People who own the GitLab project, or its group, that the notes belong to."},
	"maintainer": {"Maintainers", "Maintainer on the GitLab project of the notes."},
	"developer":  {"Developers", "Developer on the GitLab project of the notes."},
	"reporter":   {"Reporters", "Reporter on the GitLab project of the notes."},
	"guest":      {"Guests", "Guest (or planner, or minimal access) on the GitLab project of the notes."},
}

func accessList(roles map[string]bool) []accessLevel {
	out := make([]accessLevel, 0, len(store.GenerateLevels))
	for _, k := range store.GenerateLevels {
		out = append(out, accessLevel{Key: k, Label: accessLabels[k][0], Hint: accessLabels[k][1], On: roles[k]})
	}
	return out
}

// getAccess is who may start the AI jobs on the project pages: one switch per level.
func (s *Server) getAccess(_ http.ResponseWriter, _ *http.Request, _ string) (any, error) {
	p, err := s.settings.Get()
	if err != nil {
		return nil, err
	}
	return map[string]any{"levels": accessList(p.GenerateRoles()), "defaults": store.DefaultGenerate()}, nil
}

// putAccess saves the switches. The scheduler (LLM auto) and the admin area stay with GitLab administrators: nothing here changes that.
func (s *Server) putAccess(_ http.ResponseWriter, r *http.Request, who string) (any, error) {
	in, err := body(r)
	if err != nil {
		return nil, err
	}
	var before, after map[string]bool
	if _, err := s.settings.Update(func(p *store.Portal) error {
		before = p.GenerateRoles()
		if err := store.ApplyGenerateInput(p, in); err != nil {
			return err
		}
		after = p.GenerateRoles()
		return nil
	}); err != nil {
		return nil, err
	}
	kv := func(m map[string]bool) []audit.KV {
		out := make([]audit.KV, 0, len(store.GenerateLevels))
		for _, k := range store.GenerateLevels {
			out = append(out, audit.KV{Key: k, Value: m[k]})
		}
		return out
	}
	s.rec(r, audit.Input{Event: "update", EntityType: "access", EntityName: "Who may generate", User: who, Changes: audit.DiffLines(kv(before), kv(after)), Description: "Who may generate documentation and pictures changed"})
	return accessList(after), nil
}
