// SPDX-License-Identifier: Apache-2.0

package web

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/lsegroup/mnemosyne/admin-go/internal/audit"
	"github.com/lsegroup/mnemosyne/admin-go/internal/jobs"
	"github.com/lsegroup/mnemosyne/admin-go/internal/llm"
	"github.com/lsegroup/mnemosyne/admin-go/internal/store"
)

// ---- LLM providers --------------------------------------------------------------------------------------------------

func (s *Server) listProviders(_ http.ResponseWriter, _ *http.Request, _ string) (any, error) {
	return s.providers.List()
}

func (s *Server) saveProvider(_ http.ResponseWriter, r *http.Request, who string) (any, error) {
	in, err := body(r)
	if err != nil {
		return nil, err
	}
	var before *store.Provider
	if id, ok := in["id"].(string); ok {
		if p, err := s.providers.Full(id); err == nil {
			before = &p
		}
	}
	saved, err := s.providers.Upsert(store.Input{ID: in["id"], Label: in["label"], Kind: in["kind"], BaseURL: in["baseUrl"], APIKey: in["apiKey"]})
	if err != nil {
		return nil, err
	}
	var b []audit.KV
	if before != nil {
		b = []audit.KV{{Key: "label", Value: before.Label}, {Key: "kind", Value: before.Kind}, {Key: "baseUrl", Value: before.BaseURL}}
	}
	now := []audit.KV{{Key: "label", Value: saved.Label}, {Key: "kind", Value: saved.Kind}, {Key: "baseUrl", Value: saved.BaseURL}}
	changes := []string{audit.DiffLines(b, now)}
	if k, _ := in["apiKey"].(string); strings.TrimSpace(k) != "" {
		changes = append(changes, `+ apiKey: "••••" (new key stored)`)
	}
	event, desc := "create", "LLM provider connected"
	if before != nil {
		event, desc = "update", "LLM provider changed"
	}
	s.rec(r, audit.Input{Event: event, EntityType: "llm_provider", EntityID: saved.ID, EntityName: saved.Label, User: who, Changes: joinNonEmpty(changes), Description: desc})
	return saved, nil
}

func joinNonEmpty(parts []string) string {
	var keep []string
	for _, p := range parts {
		if p != "" {
			keep = append(keep, p)
		}
	}
	return strings.Join(keep, "\n")
}

func (s *Server) deleteProvider(_ http.ResponseWriter, r *http.Request, who string) (any, error) {
	id := r.PathValue("id")
	label := id
	if p, err := s.providers.Full(id); err == nil {
		label = p.Label
	}
	if err := s.providers.Remove(id); err != nil {
		return nil, err
	}
	s.rec(r, audit.Input{Event: "delete", EntityType: "llm_provider", EntityID: id, EntityName: label, User: who, Description: "LLM provider and its stored key removed"})
	return map[string]bool{"ok": true}, nil
}

// fetchModels asks the provider which models its API key may use (the list call only: no inference, no cost).
func (s *Server) fetchModels(_ http.ResponseWriter, r *http.Request, who string) (any, error) {
	id := r.PathValue("id")
	p, err := s.providers.Full(id)
	if err != nil {
		return nil, err
	}
	models, err := llm.FetchModels(p)
	if err != nil {
		s.rec(r, audit.Input{Event: "fetch_failed", EntityType: "llm_provider", EntityID: id, EntityName: p.Label, User: who, Description: err.Error()})
		return nil, err
	}
	saved, err := s.providers.SetModels(id, models)
	if err != nil {
		return nil, err
	}
	s.rec(r, audit.Input{Event: "fetch", EntityType: "llm_provider", EntityID: id, EntityName: p.Label, User: who, Description: fmt.Sprintf("Fetched %d models from the provider", len(saved.Models))})
	return saved, nil
}

// ---- the AI jobs ----------------------------------------------------------------------------------------------------

type roleView struct {
	Def        jobs.Def          `json:"def"`
	Settings   jobs.Settings     `json:"settings"`
	Effective  jobs.Effective    `json:"effective"`
	Assignment *store.Assignment `json:"assignment"`
}

// orderedJobs is the object {text, image, pdf} in that order.
type orderedJobs struct{ views map[jobs.Role]roleView }

func (o orderedJobs) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, role := range jobs.Roles {
		if i > 0 {
			b.WriteByte(',')
		}
		raw, err := json.Marshal(o.views[role])
		if err != nil {
			return nil, err
		}
		fmt.Fprintf(&b, "%q:%s", role, raw)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

func (s *Server) jobView() (map[string]orderedJobs, error) {
	list, err := s.providers.List()
	if err != nil {
		return nil, err
	}
	views := map[jobs.Role]roleView{}
	for _, role := range jobs.Roles {
		v := roleView{Def: jobs.Defs[role], Settings: list.Jobs[role], Effective: jobs.Effect(role, list.Jobs[role])}
		if a, ok := list.Assignments[role]; ok {
			a := a
			v.Assignment = &a
		}
		views[role] = v
	}
	return map[string]orderedJobs{"jobs": {views: views}}, nil
}

func (s *Server) getJobs(_ http.ResponseWriter, _ *http.Request, _ string) (any, error) {
	return s.jobView()
}

// flatJob is what the audit trail compares before and after a job was saved.
func flatJob(role jobs.Role, a *store.Assignment, st jobs.Settings, names map[string]string) []audit.KV {
	e := jobs.Effect(role, st)
	d := jobs.Defs[role].Defaults
	chars := func(t, dflt string) any {
		if t == dflt {
			return "built-in default"
		}
		return fmt.Sprintf("%d characters: %s…", jobs.JSLen(t), audit.JSON(jobs.JSSlice(t, 70)))
	}
	orDefault := func(f *float64) any {
		if f == nil {
			return "provider default"
		}
		return *f
	}
	effort := any("provider default")
	if e.ReasoningEffort != "" {
		effort = e.ReasoningEffort
	}
	var model any
	if a != nil {
		label := names[a.ProviderID]
		if label == "" {
			label = a.ProviderID
		}
		model = label + " / " + a.Model
	}
	return []audit.KV{
		{Key: "model", Value: model},
		{Key: "maxTokens", Value: e.MaxTokens},
		{Key: "temperature", Value: orDefault(e.Temperature)},
		{Key: "topP", Value: orDefault(e.TopP)},
		{Key: "reasoningEffort", Value: effort},
		{Key: "timeoutMinutes", Value: e.TimeoutMinutes},
		{Key: "systemPrompt", Value: chars(e.SystemPrompt, d.SystemPrompt)},
		{Key: "userPrompt", Value: chars(e.UserPrompt, d.UserPrompt)},
	}
}

func (s *Server) providerNames() (map[string]string, store.Listing, error) {
	list, err := s.providers.List()
	names := map[string]string{}
	for _, p := range list.Providers {
		names[p.ID] = p.Label
	}
	return names, list, err
}

func (s *Server) putJob(_ http.ResponseWriter, r *http.Request, who string) (any, error) {
	if !jobs.ValidRole(r.PathValue("role")) {
		return nil, jobs.Invalid("unknown job")
	}
	role := jobs.Role(r.PathValue("role"))
	in, err := body(r)
	if err != nil {
		return nil, err
	}
	settings, err := jobs.Validate(role, in)
	if err != nil {
		return nil, err
	}
	names, before, err := s.providerNames()
	if err != nil {
		return nil, err
	}
	var choice *store.ModelChoice
	if m, ok := in["model"].(map[string]any); ok {
		choice = &store.ModelChoice{ProviderID: m["providerId"], Model: m["model"]}
	}
	var beforeA *store.Assignment
	if a, ok := before.Assignments[role]; ok {
		a := a
		beforeA = &a
	}
	savedA, savedS, err := s.providers.SetJob(role, choice, settings)
	if err != nil {
		return nil, err
	}
	title := jobs.Defs[role].Title
	s.rec(r, audit.Input{
		Event: "update", EntityType: "llm_job", EntityID: string(role), EntityName: title, User: who,
		Changes:     audit.DiffLines(flatJob(role, beforeA, before.Jobs[role], names), flatJob(role, savedA, savedS, names)),
		Description: "AI job “" + title + "”: model, limits and prompts saved",
	})
	return s.jobView()
}

func (s *Server) putAssignments(_ http.ResponseWriter, r *http.Request, who string) (any, error) {
	in, err := body(r)
	if err != nil {
		return nil, err
	}
	names, before, err := s.providerNames()
	if err != nil {
		return nil, err
	}
	flat := func(a store.Assignments) []audit.KV {
		var out []audit.KV
		for _, role := range jobs.Roles {
			if v, ok := a[role]; ok {
				label := names[v.ProviderID]
				if label == "" {
					label = v.ProviderID
				}
				out = append(out, audit.KV{Key: string(role), Value: label + " / " + v.Model})
			}
		}
		return out
	}
	next, err := s.providers.SetAssignments(in)
	if err != nil {
		return nil, err
	}
	s.rec(r, audit.Input{Event: "update", EntityType: "llm_assignment", EntityName: "Models per job", User: who, Changes: audit.DiffLines(flat(before.Assignments), flat(next)), Description: "Model choices for text / images / PDF saved"})
	return next, nil
}

// ---- fixed addresses ------------------------------------------------------------------------------------------------

func (s *Server) hostsView() (any, error) {
	list, err := s.providers.List()
	if err != nil {
		return nil, err
	}
	hosts, err := s.providers.Hosts()
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	names := []string{}
	for _, p := range list.Providers {
		if u, err := url.Parse(p.BaseURL); err == nil && u.Hostname() != "" && !seen[u.Hostname()] {
			seen[u.Hostname()] = true
			names = append(names, u.Hostname())
		}
	}
	rows := make([]map[string]any, 0, len(hosts))
	for _, h := range hosts {
		row := map[string]any{"host": h.Host, "ip": h.IP}
		if h.VerifiedAt > 0 {
			row["verifiedAt"] = h.VerifiedAt
		}
		if t := llm.PinFallbackAt(h.Host); !t.IsZero() {
			row["fallbackAt"] = t.UnixMilli()
		}
		rows = append(rows, row)
	}
	return map[string]any{"hosts": rows, "providerHosts": names}, nil
}

func (s *Server) getHosts(_ http.ResponseWriter, _ *http.Request, _ string) (any, error) {
	return s.hostsView()
}

func pinMap(l []store.HostPin) []audit.KV {
	out := make([]audit.KV, 0, len(l))
	for _, p := range l {
		out = append(out, audit.KV{Key: p.Host, Value: p.IP})
	}
	return out
}

func (s *Server) putHosts(_ http.ResponseWriter, r *http.Request, who string) (any, error) {
	in, err := body(r)
	if err != nil {
		return nil, err
	}
	next, err := llm.ValidatePins(in["hosts"])
	if err != nil {
		return nil, err
	}
	before, err := s.providers.Hosts()
	if err != nil {
		return nil, err
	}
	for i := range next { // a pin that did not change keeps the time it was last verified
		for _, b := range before {
			if b.Host == next[i].Host && b.IP == next[i].IP {
				next[i].VerifiedAt = b.VerifiedAt
			}
		}
	}
	if err := s.providers.SetHosts(next); err != nil {
		return nil, err
	}
	llm.SetPins(next) // in force at once, for the next connection
	desc := "Fixed addresses removed: DNS is asked as usual"
	if len(next) > 0 {
		var parts []string
		for _, p := range next {
			parts = append(parts, p.Host+" → "+p.IP)
		}
		desc = "Fixed addresses saved: " + strings.Join(parts, ", ")
	}
	s.rec(r, audit.Input{Event: "update", EntityType: "llm_hosts", EntityName: "Fixed addresses", User: who, Changes: audit.DiffLines(pinMap(before), pinMap(next)), Description: desc})
	return s.hostsView()
}

// checkHost opens a TLS connection to the address as that host name and checks the certificate; it sends no request and costs nothing.
func (s *Server) checkHost(_ http.ResponseWriter, r *http.Request, who string) (any, error) {
	in, err := body(r)
	if err != nil {
		return nil, err
	}
	pins, err := llm.ValidatePins([]any{in})
	if err != nil {
		return nil, err
	}
	pin := pins[0]
	res := llm.CheckPin(pin.Host, pin.IP, pinCheckTimeout, pinCheckPort)
	verdict := "failed"
	if res.OK {
		verdict = "OK"
	}
	s.rec(r, audit.Input{Event: "check", EntityType: "llm_hosts", EntityName: pin.Host, User: who, Description: fmt.Sprintf("%s → %s: %s (%s)", pin.Host, pin.IP, verdict, res.Detail)})
	if res.OK { // remember when this address was last proven good
		if hosts, err := s.providers.Hosts(); err == nil {
			changed := false
			for i := range hosts {
				if hosts[i].Host == pin.Host && hosts[i].IP == pin.IP {
					hosts[i].VerifiedAt, changed = s.now().UnixMilli(), true
				}
			}
			if changed && s.providers.SetHosts(hosts) == nil {
				llm.SetPins(hosts)
			}
		}
	}
	return res, nil
}

// ---- GitLab SSO settings ---------------------------------------------------------------------------------------------

func secretHint(secret string) string {
	r := []rune(secret)
	switch {
	case len(r) >= 12:
		return "••••" + string(r[len(r)-4:])
	case secret != "":
		return "••••"
	}
	return ""
}

func (s *Server) getSettings(_ http.ResponseWriter, _ *http.Request, _ string) (any, error) {
	eff := s.effective()
	var localUser any
	if eff.localActive {
		localUser = s.localUser
	}
	return map[string]any{
		"gitlabUrl":    eff.gitlab.URL,
		"clientId":     eff.gitlab.ClientID,
		"hasSecret":    eff.gitlab.ClientSecret != "",
		"secretHint":   secretHint(eff.gitlab.ClientSecret),
		"ssoActive":    eff.sso,
		"redirectUris": []string{s.here("/auth/callback"), s.here("/admin/auth/callback")},
		"localUser":    localUser,
	}, nil
}

func (s *Server) putSettings(_ http.ResponseWriter, r *http.Request, who string) (any, error) {
	if !s.edition().Licensed {
		return nil, &httpError{http.StatusPaymentRequired, "Setting up GitLab SSO for the admin area needs a licence. The free edition signs administrators in with the built-in account."}
	}
	in, err := body(r)
	if err != nil {
		return nil, err
	}
	before := s.effective()
	if _, err := s.settings.Update(func(p *store.Portal) error { return store.ApplyPortalInput(p, in) }); err != nil {
		return nil, err
	}
	after := s.effective()
	pair := func(e effective) []audit.KV {
		return []audit.KV{{Key: "gitlabUrl", Value: nilIfEmpty(e.gitlab.URL)}, {Key: "clientId", Value: nilIfEmpty(e.gitlab.ClientID)}}
	}
	changes := []string{audit.DiffLines(pair(before), pair(after))}
	if secret, _ := in["clientSecret"].(string); strings.TrimSpace(secret) != "" {
		changes = append(changes, `+ clientSecret: "••••" (new secret stored)`)
	}
	desc := "GitLab SSO settings saved (not complete yet)"
	if after.sso {
		desc = "GitLab SSO settings saved (active)"
	}
	s.rec(r, audit.Input{Event: "update", EntityType: "sso", EntityName: "GitLab SSO", User: who, Changes: joinNonEmpty(changes), Description: desc})
	return map[string]bool{"ok": true}, nil
}

// nilIfEmpty is "undefined" for an unset value, like the Node server shows it.
func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// ---- the audit trail ------------------------------------------------------------------------------------------------

func (s *Server) getAudit(_ http.ResponseWriter, r *http.Request, _ string) (any, error) {
	q := r.URL.Query()
	offset, _ := strconv.Atoi(q.Get("offset"))
	limit, _ := strconv.Atoi(q.Get("limit"))
	search := q.Get("q")
	limited := !s.edition().Licensed
	if limited { // the free edition shows the last FreeAuditRecords records: no paging, no search
		offset, limit, search = 0, FreeAuditRecords, ""
	}
	events, total, err := s.audit.List(search, offset, limit)
	if err != nil {
		return nil, err
	}
	if events == nil {
		events = []audit.Event{}
	}
	if limited && len(events) > FreeAuditRecords {
		events = events[:FreeAuditRecords]
	}
	return map[string]any{"events": events, "total": total, "limited": limited, "freeLimit": FreeAuditRecords}, nil
}
