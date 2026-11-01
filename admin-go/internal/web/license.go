package web

import (
	"context"
	"errors"
	"html"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"gitlab.globalclouddata.org/gcd-group/mnemosyne-admin/internal/audit"
	"gitlab.globalclouddata.org/gcd-group/mnemosyne-admin/internal/jobs"
	"gitlab.globalclouddata.org/gcd-group/mnemosyne-admin/internal/license"
	"gitlab.globalclouddata.org/gcd-group/mnemosyne-admin/internal/store"
)

// A seat is a person with a GitLab account who uses this installation, in any role: somebody who signed in to the documentation
// area during the last 12 months, or who holds a personal MCP token that is neither revoked nor expired. The same person is one seat.
func seatsUsed(members *store.Members, tokens *store.Tokens, now time.Time) int {
	seen := map[string]bool{}
	for _, u := range members.ActiveUsers(now.AddDate(-1, 0, 0)) {
		seen[u] = true
	}
	for _, u := range tokens.ActiveUsers(now) {
		seen[u] = true
	}
	return len(seen)
}

// initLicense builds the licence manager on the portal's sealed files. It does not talk to the licence server before StartLicense.
func (s *Server) initLicense() {
	// The licensed domain: the one set for it, else the host of the public URL (read here, not from s.canonical: that is set later), and only
	// when there is neither the name of the machine.
	domain := s.cfg.LicenseDomain
	if domain == "" {
		if u, err := url.Parse(s.cfg.PublicURL); err == nil {
			domain = strings.ToLower(u.Hostname())
		}
	}
	if domain == "" {
		domain, _ = os.Hostname()
	}
	members, tokens := store.NewMembers(s.cfg.MembersFile, s.keys.Enc), store.NewTokens(s.cfg.TokensFile, s.keys.Enc)
	m, err := license.New(license.Options{
		Store:     store.NewLicense(s.cfg.LicenseFile, s.keys.Enc),
		Server:    s.cfg.LicenseServer,
		PublicKey: license.ProductionKey(),
		Domain:    domain,
		Version:   s.cfg.Version,
		SeatsUsed: func() int { return seatsUsed(members, tokens, s.now()) },
		EnvKey:    s.cfg.LicenseKey,
		OnEvent: func(kind, detail string) {
			s.audit.Write(audit.Input{Event: kind, EntityType: "license", EntityName: license.Product, User: "system", Description: detail})
		},
	})
	if err != nil {
		s.lic = nil
		return
	}
	s.lic = m
}

// SetLicense replaces the licence manager (tests).
func (s *Server) SetLicense(m *license.Manager) { s.lic = m }

// StartLicense lets the licence manager talk to the licence server (first contact at once, then every 12 hours).
func (s *Server) StartLicense(ctx context.Context) {
	if s.lic != nil {
		s.lic.Start(ctx)
	}
}

// licensed is the single question: may this installation do its work now? (Also used by the Auto scheduler: a locked installation
// spends no money on AI.)
func (s *Server) licensed() bool {
	if s.lic == nil {
		return false
	}
	ok, _ := s.lic.Allowed()
	return ok
}

// gate is the front door: everything that is not the admin area (which is served by this program itself and needs its own sign-in)
// passes only while the licence allows it. The health answer stays open so that monitoring and the deploy keep working.
func (s *Server) gate(next http.Handler) http.Handler {
	health := s.cfg.BasePath + "/health"
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == health {
			next.ServeHTTP(w, r)
			return
		}
		if s.lic == nil {
			s.locked(w, r, "This installation is not set up: it needs MNEMOSYNE_SECRET (16 characters or more) and MNEMOSYNE_PUBLIC_URL.")
			return
		}
		if ok, why := s.lic.Allowed(); !ok {
			s.locked(w, r, why)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) locked(w http.ResponseWriter, r *http.Request, why string) {
	noStore(w)
	admin := s.cfg.PublicURL + s.adminBase() + "/#license"
	if r.Method == http.MethodGet && strings.Contains(r.Header.Get("Accept"), "text/html") {
		pageHeaders(w, "")
		send(w, r, http.StatusPaymentRequired, []byte(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mnemosyne is locked</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#f6f4fb;color:#2a2340;margin:0;display:grid;place-items:center;min-height:100vh}main{max-width:34rem;margin:24px;padding:32px;background:#fff;border-radius:14px;box-shadow:0 2px 24px #4b2e8318}h1{margin:0 0 8px;font-size:1.4rem;color:#4b2e83}a.btn{display:inline-block;margin-top:12px;padding:9px 16px;border-radius:8px;background:#4b2e83;color:#fff;text-decoration:none}</style></head>
<body><main><h1>Mnemosyne is locked</h1><p>`+html.EscapeString(why)+`</p><p>A GitLab administrator can enter a licence key in the admin area, under License.</p><a class="btn" href="`+html.EscapeString(admin)+`">Open the admin area</a></main></body></html>`))
		return
	}
	sendJSON(w, r, http.StatusPaymentRequired, map[string]string{"error": "licence_required", "message": why, "admin": admin})
}

// ---- admin API ------------------------------------------------------------------------------------------------------------

func (s *Server) needLicense() error {
	if s.lic == nil {
		return &httpError{http.StatusServiceUnavailable, "The licence cannot be handled until the portal is set up (MNEMOSYNE_SECRET and MNEMOSYNE_PUBLIC_URL)."}
	}
	return nil
}

func (s *Server) getLicense(_ http.ResponseWriter, _ *http.Request, _ string) (any, error) {
	if err := s.needLicense(); err != nil {
		return nil, err
	}
	return s.lic.Status(), nil
}

func (s *Server) activateLicense(_ http.ResponseWriter, r *http.Request, who string) (any, error) {
	if err := s.needLicense(); err != nil {
		return nil, err
	}
	in, err := body(r)
	if err != nil {
		return nil, err
	}
	key, _ := in["key"].(string)
	st, err := s.lic.Activate(r.Context(), key)
	var rej *license.Rejected
	switch {
	case errors.As(err, &rej):
		s.rec(r, audit.Input{Event: "denied", EntityType: "license", EntityName: license.Product, User: who, Description: "Licence key refused: " + rej.Message})
		return nil, jobs.Invalid("%s", rej.Message)
	case err != nil:
		return nil, &httpError{http.StatusBadGateway, err.Error()}
	}
	s.rec(r, audit.Input{Event: "license_activate", EntityType: "license", EntityName: license.Product, User: who, Description: "Licence key " + st.KeyHint + " activated (" + st.State + ")"})
	return st, nil
}

func (s *Server) checkLicense(_ http.ResponseWriter, r *http.Request, who string) (any, error) {
	if err := s.needLicense(); err != nil {
		return nil, err
	}
	// an unreachable licence server is not an error of this call: the answer says so (lastError)
	_ = s.lic.CheckNow(r.Context())
	s.rec(r, audit.Input{Event: "license_check", EntityType: "license", EntityName: license.Product, User: who, Description: "Licence checked with the licence server"})
	return s.lic.Status(), nil
}
