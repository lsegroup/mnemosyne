package web

import (
	"context"
	"errors"
	"fmt"
	"html"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/lsegroup/mnemosyne/admin-go/internal/audit"
	"github.com/lsegroup/mnemosyne/admin-go/internal/jobs"
	"github.com/lsegroup/mnemosyne/admin-go/internal/license"
	"github.com/lsegroup/mnemosyne/admin-go/internal/secrets"
	"github.com/lsegroup/mnemosyne/admin-go/internal/store"
)

// The two editions of Mnemosyne (the code is Apache-2.0 either way; the limits are what a licence key lifts):
//
//	free      up to FreeSeats people, the Audit tab shows the last FreeAuditRecords records only (no paging, no search), administrators sign
//	          in to the admin area with the built-in account (no GitLab SSO for the admin area, no SSO tab)
//	licensed  as many people as the licence has seats, the whole Audit history, GitLab SSO for the admin area
const (
	// FreeSeats is how many people use the free edition.
	FreeSeats = 5
	// FreeAuditRecords is how many audit records the free edition shows.
	FreeAuditRecords = 10
)

// edition is what the installation may do now.
type edition struct {
	Licensed bool
	// Seats is the number of seats of the licence; nil = no limit. Only set when Licensed.
	Seats *int
}

// edition works out the edition from the licence: a key the licence server confirmed (licensed, or within the renewal period after it ran
// out) is the licensed edition; everything else - no key, an unknown, revoked or expired key, a licence server that cannot be reached for
// longer than its last answer lasts - is the free edition. Nothing ever locks.
func (s *Server) edition() edition {
	if s.lic == nil {
		return edition{}
	}
	st := s.lic.Status()
	if st.Allowed && (st.State == "licensed" || st.State == "renewal-grace") {
		return edition{Licensed: true, Seats: st.Seats}
	}
	return edition{}
}

// seatLimit is how many people may use the installation now; -1 = no limit.
func (s *Server) seatLimit() int {
	e := s.edition()
	switch {
	case !e.Licensed:
		return FreeSeats
	case e.Seats == nil:
		return -1
	}
	return *e.Seats
}

// adminEffective is the portal setup as far as the admin area may use it: GitLab sign-in for administrators needs a licence.
func (s *Server) adminEffective() effective {
	e := s.effective()
	if !s.edition().Licensed {
		e.sso = false
	}
	return e
}

// initLicense builds the licence manager and the seat register on the portal's sealed files. It does not talk to the licence server before
// StartLicense, and then only once a licence key has been entered.
func (s *Server) initLicense() {
	s.seats = store.NewSeats(s.cfg.SeatsFile, s.keys.Enc)
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
	m, err := license.New(license.Options{
		Store:          store.NewLicense(s.cfg.LicenseFile, s.keys.Enc),
		Server:         s.cfg.LicenseServer,
		PublicKey:      license.ProductionKey(),
		Domain:         domain,
		Version:        s.cfg.Version,
		SeatsUsed:      s.seats.Count,
		EnvKey:         s.cfg.LicenseKey,
		FreeWithoutKey: true,
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

// StartLicense lets the licence manager talk to the licence server (every 12 hours; only once a licence key exists).
func (s *Server) StartLicense(ctx context.Context) {
	if s.lic != nil {
		s.lic.Start(ctx)
	}
}

// sessionCookie is the cookie of the documentation portal's own sign-in (written and read by the Node server, signed with the shared key).
const sessionCookie = "mnemosyne_session"

// gate is the front door: everything that is not the admin area (which is served by this program itself and needs its own sign-in) is
// passed on to the Node server. A signed-in person takes a seat the first time they are seen; when the edition has no seat left for them
// they are refused and signed out. Anonymous requests and the health answer are never touched.
func (s *Server) gate(next http.Handler) http.Handler {
	health := s.cfg.BasePath + "/health"
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == health {
			next.ServeHTTP(w, r)
			return
		}
		if s.lic == nil || s.seats == nil {
			s.refuse(w, r, "This installation is not set up: it needs MNEMOSYNE_SECRET (16 characters or more) and MNEMOSYNE_PUBLIC_URL.", "not_configured")
			return
		}
		if c, err := r.Cookie(sessionCookie); err == nil {
			var sess secrets.Session
			if v, err := url.PathUnescape(c.Value); err == nil && secrets.VerifyToken(s.keys.Sign, v, s.now(), &sess) && sess.U != "" {
				if !s.seats.Admit(sess.U, s.seatLimit(), s.now()) {
					s.overSeats(w, r, sess.U)
					return
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}

// overSeats refuses a person for whom the edition has no seat left, and signs them out of the portal.
func (s *Server) overSeats(w http.ResponseWriter, r *http.Request, user string) {
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: s.cfg.BasePath, MaxAge: -1, HttpOnly: true, Secure: s.secure, SameSite: http.SameSiteLaxMode})
	limit := s.seatLimit()
	why := fmt.Sprintf("All %d seats of this installation are taken. Mnemosyne is free for up to %d people; a licence key lifts the limit.", limit, FreeSeats)
	if s.edition().Licensed {
		why = fmt.Sprintf("All %d seats of the licence of this installation are taken. Ask the administrator for more seats.", limit)
	}
	s.refusedOnce(user, limit)
	s.refuse(w, r, why, "seats_exhausted")
}

// refusedOnce writes one audit entry per person per hour for a refused sign-in.
func (s *Server) refusedOnce(user string, limit int) {
	s.refusedMu.Lock()
	defer s.refusedMu.Unlock()
	if s.refused == nil {
		s.refused = map[string]time.Time{}
	}
	if t, ok := s.refused[user]; ok && s.now().Sub(t) < time.Hour {
		return
	}
	s.refused[user] = s.now()
	s.audit.Write(audit.Input{Event: "denied", EntityType: "license", EntityName: license.Product, User: user, Description: fmt.Sprintf("Sign-in refused: all %d seats are taken", limit)})
}

func (s *Server) refuse(w http.ResponseWriter, r *http.Request, why, code string) {
	noStore(w)
	admin := s.cfg.PublicURL + s.adminBase() + "/#license"
	if r.Method == http.MethodGet && strings.Contains(r.Header.Get("Accept"), "text/html") {
		pageHeaders(w, "")
		send(w, r, http.StatusPaymentRequired, []byte(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mnemosyne</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#f6f4fb;color:#2a2340;margin:0;display:grid;place-items:center;min-height:100vh}main{max-width:34rem;margin:24px;padding:32px;background:#fff;border-radius:14px;box-shadow:0 2px 24px #4b2e8318}h1{margin:0 0 8px;font-size:1.4rem;color:#4b2e83}a.btn{display:inline-block;margin-top:12px;padding:9px 16px;border-radius:8px;background:#4b2e83;color:#fff;text-decoration:none}</style></head>
<body><main><h1>Mnemosyne</h1><p>`+html.EscapeString(why)+`</p><p>A GitLab administrator can see the details, and enter a licence key, in the admin area under License.</p><a class="btn" href="`+html.EscapeString(admin)+`">Open the admin area</a></main></body></html>`))
		return
	}
	sendJSON(w, r, http.StatusPaymentRequired, map[string]string{"error": code, "message": why, "admin": admin})
}

// ---- admin API ------------------------------------------------------------------------------------------------------------

func (s *Server) needLicense() error {
	if s.lic == nil {
		return &httpError{http.StatusServiceUnavailable, "The licence cannot be handled until the portal is set up (MNEMOSYNE_SECRET and MNEMOSYNE_PUBLIC_URL)."}
	}
	return nil
}

// licenseView is the licence status with what the edition allows, as the License tab shows it.
type licenseView struct {
	license.Status
	// Edition is "free" or "licensed".
	Edition string `json:"edition"`
	// SeatLimit is how many people may use the installation now (nil = no limit).
	SeatLimit *int `json:"seatLimit"`
	// FreeSeats and FreeAuditRecords are the limits of the free edition.
	FreeSeats        int `json:"freeSeats"`
	FreeAuditRecords int `json:"freeAuditRecords"`
}

func (s *Server) licenseView() licenseView {
	v := licenseView{Status: s.lic.Status(), Edition: "free", FreeSeats: FreeSeats, FreeAuditRecords: FreeAuditRecords}
	limit := s.seatLimit()
	if limit >= 0 {
		v.SeatLimit = &limit
	}
	if s.edition().Licensed {
		v.Edition = "licensed"
	}
	return v
}

func (s *Server) getLicense(_ http.ResponseWriter, _ *http.Request, _ string) (any, error) {
	if err := s.needLicense(); err != nil {
		return nil, err
	}
	return s.licenseView(), nil
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
	return s.licenseView(), nil
}

func (s *Server) checkLicense(_ http.ResponseWriter, r *http.Request, who string) (any, error) {
	if err := s.needLicense(); err != nil {
		return nil, err
	}
	// an unreachable licence server is not an error of this call: the answer says so (lastError); without a key there is nothing to check
	_ = s.lic.CheckNow(r.Context())
	s.rec(r, audit.Input{Event: "license_check", EntityType: "license", EntityName: license.Product, User: who, Description: "Licence checked with the licence server"})
	return s.licenseView(), nil
}
