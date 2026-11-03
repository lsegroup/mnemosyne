// SPDX-License-Identifier: Apache-2.0

package store

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/lsegroup/mnemosyne/admin-go/internal/jobs"
)

// Provider API formats.
const (
	OpenAICompatible  = "openai-compatible"
	AnthropicMessages = "anthropic-messages"
)

// Provider is a connection: endpoint and API key, plus the models its API reported when last fetched.
type Provider struct {
	ID      string   `json:"id"`
	Label   string   `json:"label"`
	Kind    string   `json:"kind"`
	BaseURL string   `json:"baseUrl"`
	APIKey  string   `json:"apiKey"`
	Models  []string `json:"models"`
	// ModelsPulledAt is the epoch millisecond of the last successful fetch.
	ModelsPulledAt int64 `json:"modelsPulledAt,omitempty"`
}

// PublicProvider is what the browser may see: the key is never sent back, only a hint.
type PublicProvider struct {
	ID             string   `json:"id"`
	Label          string   `json:"label"`
	Kind           string   `json:"kind"`
	BaseURL        string   `json:"baseUrl"`
	Models         []string `json:"models"`
	ModelsPulledAt int64    `json:"modelsPulledAt,omitempty"`
	HasKey         bool     `json:"hasKey"`
	KeyHint        string   `json:"keyHint"`
}

// Assignment is the model chosen for a job.
type Assignment struct {
	ProviderID string `json:"providerId"`
	Model      string `json:"model"`
}

// Assignments maps a job to its model.
type Assignments map[jobs.Role]Assignment

// HostPin pins a host name to an IP address (Admin -> LLM, "Fixed addresses").
type HostPin struct {
	Host string `json:"host"`
	IP   string `json:"ip"`
	// VerifiedAt is when a check last connected to IP as Host with a valid certificate (unix ms; 0 = never).
	VerifiedAt int64 `json:"verifiedAt,omitempty"`
}

type providersDoc struct {
	Providers   []Provider  `json:"providers"`
	Assignments Assignments `json:"assignments"`
	Jobs        jobs.File   `json:"jobs"`
	Hosts       []HostPin   `json:"hosts"`
	// ActiveID is the first-generation layout (one active provider with one model); migrated on read, never written.
	ActiveID string `json:"activeId,omitempty"`
}

// legacyProvider reads the first-generation per-provider "model".
type legacyProvider struct {
	ID    string `json:"id"`
	Model string `json:"model"`
}

// Providers is the sealed providers file.
type Providers struct{ f sealedFile }

// NewProviders opens (lazily) the sealed providers file.
func NewProviders(path string, encKey []byte) *Providers {
	return &Providers{f: sealedFile{path: path, key: encKey}}
}

func (s *Providers) read() (*providersDoc, error) {
	raw, err := s.f.read()
	if err != nil {
		return nil, err
	}
	d := &providersDoc{}
	if raw != nil {
		if err := json.Unmarshal(raw, d); err != nil {
			return nil, err
		}
		var old struct {
			Providers []legacyProvider `json:"providers"`
		}
		_ = json.Unmarshal(raw, &old)
		for i := range d.Providers {
			if d.Providers[i].Models == nil {
				d.Providers[i].Models = []string{}
				if i < len(old.Providers) && old.Providers[i].Model != "" {
					d.Providers[i].Models = []string{old.Providers[i].Model}
				}
			}
		}
	}
	if d.Providers == nil {
		d.Providers = []Provider{}
	}
	if d.Assignments == nil {
		d.Assignments = Assignments{}
	}
	if d.ActiveID != "" {
		if _, ok := d.Assignments[jobs.Text]; !ok {
			var old struct {
				Providers []legacyProvider `json:"providers"`
			}
			_ = json.Unmarshal(raw, &old)
			for _, p := range old.Providers {
				if p.ID == d.ActiveID && p.Model != "" {
					d.Assignments[jobs.Text] = Assignment{ProviderID: p.ID, Model: p.Model}
				}
			}
		}
	}
	if d.Jobs == nil {
		d.Jobs = jobs.File{}
	}
	if d.Hosts == nil {
		d.Hosts = []HostPin{}
	}
	return d, nil
}

func (s *Providers) write(d *providersDoc) error {
	clean := *d
	clean.ActiveID = ""
	doc, err := json.Marshal(clean)
	if err != nil {
		return err
	}
	return s.f.write(doc)
}

// mutate serialises a read-modify-write cycle so concurrent admin requests cannot lose updates.
func (s *Providers) mutate(fn func(*providersDoc) error) error {
	s.f.mu.Lock()
	defer s.f.mu.Unlock()
	d, err := s.read()
	if err != nil {
		return err
	}
	if err := fn(d); err != nil {
		return err
	}
	return s.write(d)
}

func (s *Providers) view() (*providersDoc, error) {
	s.f.mu.Lock()
	defer s.f.mu.Unlock()
	return s.read()
}

func hint(key string) string {
	n := len([]rune(key))
	switch {
	case n >= 12:
		r := []rune(key)
		return "••••" + string(r[n-4:])
	case key != "":
		return "••••"
	}
	return ""
}

// Public hides the key.
func (p Provider) Public() PublicProvider {
	models := p.Models
	if models == nil {
		models = []string{}
	}
	return PublicProvider{ID: p.ID, Label: p.Label, Kind: p.Kind, BaseURL: p.BaseURL, Models: models, ModelsPulledAt: p.ModelsPulledAt, HasKey: p.APIKey != "", KeyHint: hint(p.APIKey)}
}

// Listing is the answer of GET /providers.
type Listing struct {
	Providers   []PublicProvider `json:"providers"`
	Assignments Assignments      `json:"assignments"`
	Jobs        jobs.File        `json:"jobs"`
}

// List returns the providers (without keys), the model per job and the stored settings of every job.
func (s *Providers) List() (Listing, error) {
	d, err := s.view()
	if err != nil {
		return Listing{}, err
	}
	out := Listing{Providers: make([]PublicProvider, 0, len(d.Providers)), Assignments: d.Assignments, Jobs: d.Jobs}
	for _, p := range d.Providers {
		out.Providers = append(out.Providers, p.Public())
	}
	return out, nil
}

// Hosts returns the pinned host names.
func (s *Providers) Hosts() ([]HostPin, error) {
	d, err := s.view()
	if err != nil {
		return nil, err
	}
	return d.Hosts, nil
}

// SetHosts stores the pinned host names (already validated).
func (s *Providers) SetHosts(h []HostPin) error {
	return s.mutate(func(d *providersDoc) error {
		if h == nil {
			h = []HostPin{}
		}
		d.Hosts = h
		return nil
	})
}

// Jobs returns the stored (non-default) settings of every job.
func (s *Providers) Jobs() (jobs.File, error) {
	d, err := s.view()
	if err != nil {
		return nil, err
	}
	return d.Jobs, nil
}

// ModelChoice is a {providerId, model} the form sent; nil clears the job's model.
type ModelChoice struct {
	ProviderID any
	Model      any
}

// SetJob saves one job: its model (or none) and its settings. Other jobs stay untouched. The model must be one the provider reported.
func (s *Providers) SetJob(role jobs.Role, choice *ModelChoice, settings jobs.Settings) (*Assignment, jobs.Settings, error) {
	var gotA *Assignment
	var gotS jobs.Settings
	err := s.mutate(func(d *providersDoc) error {
		if choice != nil && (truthy(choice.ProviderID) || truthy(choice.Model)) {
			p := d.find(choice.ProviderID)
			if p == nil {
				return jobs.Invalid("%s: unknown provider", role)
			}
			m, ok := choice.Model.(string)
			if !ok || !contains(p.Models, m) {
				return jobs.Invalid("%s: model is not one of the models this provider reported", role)
			}
			d.Assignments[role] = Assignment{ProviderID: p.ID, Model: m}
		} else {
			delete(d.Assignments, role)
		}
		if settings.IsEmpty() {
			delete(d.Jobs, role)
		} else {
			d.Jobs[role] = settings
		}
		if a, ok := d.Assignments[role]; ok {
			gotA = &a
		}
		gotS = d.Jobs[role]
		return nil
	})
	return gotA, gotS, err
}

func truthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case string:
		return t != ""
	case bool:
		return t
	case float64:
		return t != 0
	}
	return true
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func (d *providersDoc) find(id any) *Provider {
	s, ok := id.(string)
	if !ok {
		return nil
	}
	for i := range d.Providers {
		if d.Providers[i].ID == s {
			return &d.Providers[i]
		}
	}
	return nil
}

// Full is a provider including its key, for server-side use only (fetching models, AI calls).
func (s *Providers) Full(id string) (Provider, error) {
	d, err := s.view()
	if err != nil {
		return Provider{}, err
	}
	if p := d.find(id); p != nil {
		return *p, nil
	}
	return Provider{}, jobs.Invalid("unknown provider id")
}

// Assigned is the provider and model chosen for a job, including the key; nil when none is chosen.
func (s *Providers) Assigned(role jobs.Role) (*Provider, string, error) {
	d, err := s.view()
	if err != nil {
		return nil, "", err
	}
	a, ok := d.Assignments[role]
	if !ok {
		return nil, "", nil
	}
	if p := d.find(a.ProviderID); p != nil {
		cp := *p
		return &cp, a.Model, nil
	}
	return nil, "", nil
}

// Input is the provider form.
type Input struct {
	ID      any
	Label   any
	Kind    any
	BaseURL any
	APIKey  any
}

func required(v any, field string, max int) (string, error) {
	s, _ := v.(string)
	s = strings.TrimSpace(s)
	if s == "" {
		return "", jobs.Invalid("%s is required", field)
	}
	if jobs.JSLen(s) > max {
		return "", jobs.Invalid("%s is too long", field)
	}
	return s, nil
}

func uuid() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

// Upsert adds a provider or changes one (an empty key on change keeps the stored key).
func (s *Providers) Upsert(in Input) (PublicProvider, error) {
	label, err := required(in.Label, "name", 80)
	if err != nil {
		return PublicProvider{}, err
	}
	kind, _ := in.Kind.(string)
	if kind != OpenAICompatible && kind != AnthropicMessages {
		return PublicProvider{}, jobs.Invalid("API format must be openai-compatible or anthropic-messages")
	}
	baseURL, err := required(in.BaseURL, "base URL", 300)
	if err != nil {
		return PublicProvider{}, err
	}
	baseURL = strings.TrimRight(baseURL, "/")
	u, perr := url.Parse(baseURL)
	if perr != nil || u.Scheme == "" || ((u.Scheme == "http" || u.Scheme == "https") && u.Host == "") {
		return PublicProvider{}, jobs.Invalid("base URL is not a valid URL")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return PublicProvider{}, jobs.Invalid("base URL must be http(s)")
	}
	newKey, _ := in.APIKey.(string)
	newKey = strings.TrimSpace(newKey)
	if jobs.JSLen(newKey) > 500 {
		return PublicProvider{}, jobs.Invalid("API key is too long")
	}
	var saved Provider
	err = s.mutate(func(d *providersDoc) error {
		var existing *Provider
		if truthy(in.ID) {
			existing = d.find(in.ID)
			if existing == nil {
				return jobs.Invalid("unknown provider id")
			}
		}
		if existing == nil && newKey == "" {
			return jobs.Invalid("API key is required")
		}
		// A different endpoint or key may expose different models: forget the old list and any choice made from it.
		changed := existing == nil || existing.BaseURL != baseURL || (newKey != "" && newKey != existing.APIKey)
		p := Provider{Label: label, Kind: kind, BaseURL: baseURL, APIKey: newKey, Models: []string{}}
		if existing != nil {
			p.ID = existing.ID
			if newKey == "" {
				p.APIKey = existing.APIKey
			}
			if !changed {
				p.Models, p.ModelsPulledAt = existing.Models, existing.ModelsPulledAt
			}
			*existing = p
			if changed {
				d.dropAssignments(p.ID)
			}
		} else {
			p.ID = uuid()
			d.Providers = append(d.Providers, p)
		}
		saved = p
		return nil
	})
	return saved.Public(), err
}

// SetModels remembers the models a provider reported; a choice that is no longer offered is dropped.
func (s *Providers) SetModels(id string, models []string) (PublicProvider, error) {
	var saved Provider
	err := s.mutate(func(d *providersDoc) error {
		p := d.find(id)
		if p == nil {
			return jobs.Invalid("unknown provider id")
		}
		p.Models = models
		p.ModelsPulledAt = time.Now().UnixMilli()
		for _, role := range jobs.Roles {
			if a, ok := d.Assignments[role]; ok && a.ProviderID == id && !contains(models, a.Model) {
				delete(d.Assignments, role)
			}
		}
		saved = *p
		return nil
	})
	return saved.Public(), err
}

// SetAssignments chooses one model per job; a missing role is cleared. The model must be one the provider reported.
func (s *Providers) SetAssignments(in map[string]any) (Assignments, error) {
	next := Assignments{}
	err := s.mutate(func(d *providersDoc) error {
		for _, role := range jobs.Roles {
			v, _ := in[string(role)].(map[string]any)
			if v == nil {
				continue
			}
			p := d.find(v["providerId"])
			if p == nil {
				return jobs.Invalid("%s: unknown provider", role)
			}
			m, ok := v["model"].(string)
			if !ok || !contains(p.Models, m) {
				return jobs.Invalid("%s: model is not one of the models this provider reported", role)
			}
			next[role] = Assignment{ProviderID: p.ID, Model: m}
		}
		d.Assignments = next
		return nil
	})
	return next, err
}

// Remove deletes a provider and the choices that used it.
func (s *Providers) Remove(id string) error {
	return s.mutate(func(d *providersDoc) error {
		kept := d.Providers[:0]
		for _, p := range d.Providers {
			if p.ID != id {
				kept = append(kept, p)
			}
		}
		d.Providers = kept
		d.dropAssignments(id)
		return nil
	})
}

func (d *providersDoc) dropAssignments(providerID string) {
	for _, role := range jobs.Roles {
		if a, ok := d.Assignments[role]; ok && a.ProviderID == providerID {
			delete(d.Assignments, role)
		}
	}
}
