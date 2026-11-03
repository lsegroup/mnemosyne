// SPDX-License-Identifier: Apache-2.0

package store

import (
	"encoding/json"
	"net/url"
	"strings"

	"github.com/lsegroup/mnemosyne/admin-go/internal/jobs"
)

// GitLabSettings is the SSO application saved in the admin page.
type GitLabSettings struct {
	URL          string `json:"url"`
	ClientID     string `json:"clientId"`
	ClientSecret string `json:"clientSecret"`
}

// Portal is what the admin page can edit; it overrides the environment values.
type Portal struct {
	GitLab *GitLabSettings `json:"gitlab,omitempty"`
	// SSOLiveAt is the epoch second of the first successful GitLab admin sign-in: SSO is proven live from then on.
	SSOLiveAt int64 `json:"ssoLiveAt,omitempty"`
}

// Settings is the sealed portal settings file.
type Settings struct{ f sealedFile }

// NewSettings opens (lazily) the sealed settings file.
func NewSettings(path string, encKey []byte) *Settings {
	return &Settings{f: sealedFile{path: path, key: encKey}}
}

func (s *Settings) get() (Portal, error) {
	raw, err := s.f.read()
	if err != nil || raw == nil {
		return Portal{}, err
	}
	var p Portal
	return p, json.Unmarshal(raw, &p)
}

// Get returns the saved settings (empty when nothing is saved).
func (s *Settings) Get() (Portal, error) {
	s.f.mu.Lock()
	defer s.f.mu.Unlock()
	return s.get()
}

// Update reads, lets fn change, and writes the settings in one step.
func (s *Settings) Update(fn func(*Portal) error) (Portal, error) {
	s.f.mu.Lock()
	defer s.f.mu.Unlock()
	p, err := s.get()
	if err != nil {
		return p, err
	}
	if err := fn(&p); err != nil {
		return p, err
	}
	doc, err := json.Marshal(p)
	if err != nil {
		return p, err
	}
	return p, s.f.write(doc)
}

// text is a trimmed string field of the form; anything but a string counts as empty.
func text(v any, field string, max int) (string, error) {
	s, _ := v.(string)
	s = strings.TrimSpace(s)
	if jobs.JSLen(s) > max {
		return "", jobs.Invalid("%s is too long", field)
	}
	return s, nil
}

// checkHTTPURL is JavaScript's `new URL(s)` plus the http(s) rule of the forms.
func checkHTTPURL(s, field string) error {
	u, err := url.Parse(s)
	if err != nil || u.Scheme == "" || ((u.Scheme == "http" || u.Scheme == "https") && u.Host == "") {
		return jobs.Invalid("%s is not a valid URL", field)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return jobs.Invalid("%s must be http(s)", field)
	}
	return nil
}

// ApplyPortalInput validates the SSO form and applies it; an empty secret keeps the stored one. Admin rights come from GitLab, never
// from a list here.
func ApplyPortalInput(p *Portal, in map[string]any) error {
	u, err := text(in["gitlabUrl"], "GitLab URL", 300)
	if err != nil {
		return err
	}
	u = strings.TrimRight(u, "/")
	if u != "" {
		if err := checkHTTPURL(u, "GitLab URL"); err != nil {
			return err
		}
	}
	clientID, err := text(in["clientId"], "Application ID", 200)
	if err != nil {
		return err
	}
	secret, err := text(in["clientSecret"], "Secret", 500)
	if err != nil {
		return err
	}
	if secret == "" && p.GitLab != nil {
		secret = p.GitLab.ClientSecret
	}
	p.GitLab = &GitLabSettings{URL: u, ClientID: clientID, ClientSecret: secret}
	return nil
}
