package web

import (
	"errors"
	"log"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"gitlab.globalclouddata.org/gcd-group/mnemosyne-admin/internal/aibusy"
	"gitlab.globalclouddata.org/gcd-group/mnemosyne-admin/internal/audit"
	"gitlab.globalclouddata.org/gcd-group/mnemosyne-admin/internal/auto"
	"gitlab.globalclouddata.org/gcd-group/mnemosyne-admin/internal/engine"
	"gitlab.globalclouddata.org/gcd-group/mnemosyne-admin/internal/jobs"
	"gitlab.globalclouddata.org/gcd-group/mnemosyne-admin/internal/secrets"
	"gitlab.globalclouddata.org/gcd-group/mnemosyne-admin/internal/store"
)

const consentTTL = 600

// autoParts is everything the Auto tab needs.
type autoParts struct {
	store    *auto.Store
	runner   *auto.Runner
	members  *store.Members
	index    *engine.Index
	docs     *engine.DocStore
	lock     *aibusy.Lock
	mu       sync.Mutex
	consents map[string]int64 // used agreement tokens by nonce, with their expiry (epoch seconds)
}

// startAuto builds the Auto scheduler on the portal's files; it does not run until Start is called on the returned runner.
func (s *Server) startAuto() {
	ap := &autoParts{
		store:    auto.NewStore(s.cfg.AutoFile),
		members:  store.NewMembers(s.cfg.MembersFile, s.keys.Enc),
		index:    engine.NewIndex(s.cfg.NodesDir),
		docs:     engine.NewDocStore(s.cfg.DocsDir),
		lock:     aibusy.New(filepath.Dir(s.cfg.AutoFile)),
		consents: map[string]int64{},
	}
	s.auto = ap
	s.importUsageHistory()
	gen := &engine.Generator{Providers: s.providers, Notes: ap.index, Docs: ap.docs}
	ap.runner = auto.NewRunner(auto.Deps{
		Store: ap.store,
		Now:   func() time.Time { return s.now() },
		KeyFor: func(c auto.Config) (string, error) {
			m, err := s.autoModel()
			if err != nil || m == nil || !m.priced {
				return "", err
			}
			return auto.AgreementKey(c, m.key), nil
		},
		Projects: func() []string {
			var out []string
			for _, p := range ap.index.Projects() {
				out = append(out, p.Project)
			}
			return out
		},
		Inspect: func(project string) auto.ProjectState { return s.autoState(project).state },
		Worst: func(project string, kind auto.Kind) (*float64, error) {
			m, err := s.autoModel()
			if err != nil || m == nil || !m.priced {
				return nil, err
			}
			f := s.autoFacts(project, m)
			if kind == engine.Wiki {
				return f.est.TextWorst, nil
			}
			return f.est.ChartsWorst, nil
		},
		Generate: func(project string, kind auto.Kind, by string) (engine.Outcome, error) {
			glName := ""
			if g := matchProject(project, ap.members.KnownProjects()); g != nil {
				glName = g.Name
			}
			logf := func(e audit.Input) {
				e.User, e.EntityType, e.EntityName = "auto", "docs_"+string(kind), project
				s.audit.Write(e)
			}
			began := s.now()
			out, err := gen.Generate(project, kind, "auto (agreed by "+by+")", glName, logf)
			if err != nil {
				msg := failureMessage(err, string(kind), project)
				s.audit.Write(audit.Input{Event: "ai_failed", User: "auto", EntityType: "docs_" + string(kind), EntityName: project, Description: msg})
				var unreachable *engine.UnreachableError
				if errors.As(err, &unreachable) {
					return out, &engine.UnreachableError{Msg: msg} // nothing was billed and the run sends it again: not a job of its own
				}
				s.logUsage(project, kind, by+" (scheduled)", began, s.now(), out, err, msg)
				return out, errors.New(msg)
			}
			s.logUsage(project, kind, by+" (scheduled)", began, s.now(), out, nil, "")
			return out, nil
		},
		Busy: func() bool { return ap.lock.HeldBy("person", s.now()) || !s.licensed() },
		Hold: func(on bool) {
			if on {
				ap.lock.Hold("auto", s.now())
			} else {
				ap.lock.Release("auto")
			}
		},
		Log: s.audit.Write,
	})
}

// failureMessage is what the run list is told when a job fails; unexpected errors go to the server log only.
func failureMessage(err error, kind, project string) string {
	var ve *jobs.ValidationError
	var un *engine.UnreachableError
	switch {
	case errors.As(err, &un):
		return un.Msg
	case errors.As(err, &ve):
		return ve.Msg
	}
	log.Printf("docs %s job for %s failed: %v", kind, project, err)
	return "The generation failed unexpectedly."
}

// matchProject is the GitLab project a notes project belongs to: its slug equals the GitLab project's path or name slug.
func matchProject(notesProject string, projects []store.MemberProject) *store.MemberProject {
	key := engine.Slug(notesProject)
	for i := range projects {
		if engine.Slug(projects[i].Path) == key || engine.Slug(projects[i].Name) == key {
			return &projects[i]
		}
	}
	return nil
}

// ---- the model and what a project would cost -----------------------------------------------------------------------------

type autoModel struct {
	label  string
	model  string
	priced bool
	tj, ij jobs.Effective
	key    string
	// pictureUSD is what ONE picture of the image model costs: zero when no image model is chosen, nil when the chosen one has no list price
	// (the cost of a diagram job then cannot be limited). A diagram job paints one picture per picture of the plan.
	pictureUSD *float64
}

// autoModel is the model for TEXT (it also plans the charts) and everything that decides what a call can cost, as one fingerprint; nil
// when no model is chosen.
func (s *Server) autoModel() (*autoModel, error) {
	p, model, err := s.providers.Assigned(jobs.Text)
	if err != nil || p == nil {
		return nil, err
	}
	stored, err := s.providers.Jobs()
	if err != nil {
		return nil, err
	}
	tj, ij := jobs.Effect(jobs.Text, stored[jobs.Text]), jobs.Effect(jobs.Image, stored[jobs.Image])
	_, priced := engine.EstimateUSD(model, 1, 1)
	m := &autoModel{label: p.Label + " / " + model, model: model, priced: priced, tj: tj, ij: ij}
	zero := 0.0
	m.pictureUSD = &zero
	ip, im, err := s.providers.Assigned(jobs.Image)
	if err != nil {
		return nil, err
	}
	if ip != nil {
		// the image model paints the workflow diagram: it is named in the agreement, part of its key and of what a diagram job can cost
		m.label += ", and the pictures by " + ip.Label + " / " + im
		m.key = auto.ModelKey(p.ID, model, tj, ij, ip.ID, im)
		m.pictureUSD = nil
		if usd, ok := engine.ImagePriceUSD(im); ok {
			m.pictureUSD = &usd
		}
	} else {
		m.key = auto.ModelKey(p.ID, model, tj, ij)
	}
	return m, nil
}

type autoStateInfo struct {
	notes []engine.Note
	wiki  *engine.DocMeta
	state auto.ProjectState
}

// autoState is what a run would do for one project, from the notes and the stored articles: nothing is sent to a model.
func (s *Server) autoState(project string) autoStateInfo {
	notes := s.auto.index.InProject(project)
	wiki, diagram := s.auto.docs.Latest(project, "wiki"), s.auto.docs.Latest(project, "diagram")
	return autoStateInfo{notes: notes, wiki: wiki, state: auto.Inspect(project, notes, wiki, diagram)}
}

type autoFactsInfo struct {
	state auto.ProjectState
	est   auto.Estimate
}

// autoFacts is the same plus what its calls would cost (typical and worst case), the way the agreement popup counts them.
func (s *Server) autoFacts(project string, m *autoModel) autoFactsInfo {
	st := s.autoState(project)
	d := jobs.Defs[jobs.Text].Defaults
	prompt := engine.BuildWikiPrompt(project, "", st.notes, engine.Templates{System: m.tj.SystemPrompt, User: m.tj.UserPrompt}, engine.Templates{System: d.SystemPrompt, User: d.UserPrompt})
	article := 40_000
	if st.wiki != nil {
		if raw, err := s.auto.docs.Read(*st.wiki); err == nil {
			article = min(len(raw), 60_000)
		}
	}
	planIn := engine.ApproxTokens(article) + 1500
	usd := func(in, out int) *float64 {
		if v, ok := engine.EstimateUSD(m.model, in, out); ok {
			return &v
		}
		return nil
	}
	// a diagram job is the text call that plans it plus the pictures the image model paints (one price per picture: typically three, at
	// most five)
	withPictures := func(v *float64, pictures int) *float64 {
		if v == nil || m.pictureUSD == nil {
			return nil
		}
		sum := *v + *m.pictureUSD*float64(pictures)
		return &sum
	}
	return autoFactsInfo{state: st.state, est: auto.Estimate{
		TextTypical:   usd(prompt.InputTokens, min(12_000, m.tj.MaxTokens)),
		TextWorst:     usd(prompt.InputTokens, m.tj.MaxTokens),
		ChartsTypical: withPictures(usd(planIn, min(12_000, m.ij.MaxTokens)), engine.TypicalPictures),
		ChartsWorst:   withPictures(usd(planIn, m.ij.MaxTokens), engine.MaxPictures),
	}}
}

// ---- the API ----------------------------------------------------------------------------------------------------------------

func (s *Server) runStatus() (map[string]any, error) {
	st, err := s.auto.store.Get()
	if err != nil {
		return nil, err
	}
	enabled := st.Config != nil && st.Config.Enabled
	return map[string]any{"enabled": enabled, "nextRunAt": st.NextRunAt, "pausedReason": st.PausedReason, "run": st.Run, "runs": st.Runs}, nil
}

type estimateJSON struct {
	TextTypical   *float64 `json:"textTypical"`
	TextWorst     *float64 `json:"textWorst"`
	ChartsTypical *float64 `json:"chartsTypical"`
	ChartsWorst   *float64 `json:"chartsWorst"`
}

type autoProject struct {
	GLPath *string `json:"glPath"`
	auto.ProjectState
	Est *estimateJSON `json:"est"`
}

// autoPayload is everything the Auto tab shows: the saved setup, the state of every project with notes, the estimates, the runs.
func (s *Server) autoPayload() (any, error) {
	st, err := s.auto.store.Get()
	if err != nil {
		return nil, err
	}
	model, err := s.autoModel()
	if err != nil {
		return nil, err
	}
	known := s.auto.members.KnownProjects()
	projects := []autoProject{}
	for _, p := range s.auto.index.Projects() {
		ap := autoProject{}
		if model != nil {
			f := s.autoFacts(p.Project, model)
			ap.ProjectState = f.state
			ap.Est = &estimateJSON{f.est.TextTypical, f.est.TextWorst, f.est.ChartsTypical, f.est.ChartsWorst}
		} else {
			ap.ProjectState = s.autoState(p.Project).state
		}
		if g := matchProject(p.Project, known); g != nil {
			path := g.FullPath
			ap.GLPath = &path
		}
		projects = append(projects, ap)
	}
	status, err := s.runStatus()
	if err != nil {
		return nil, err
	}
	out := status
	out["config"] = st.Config
	out["agreementOk"] = st.Config != nil && s.auto.runner.AgreementOK(*st.Config)
	if model != nil {
		out["model"] = map[string]any{"label": model.label, "priced": model.priced}
	} else {
		out["model"] = nil
	}
	out["projects"] = projects
	out["serverTime"] = s.now().UTC().Format("2006-01-02T15:04:05.000Z")
	return out, nil
}

type autoPlan struct {
	cfg     auto.Input
	model   *autoModel
	summary auto.Summary
	key     string
}

// plan checks the submitted setup and works out what it would cost; it fails with a plain message when it cannot be saved.
func (s *Server) plan(body map[string]any) (autoPlan, error) {
	model, err := s.autoModel()
	if err != nil {
		return autoPlan{}, err
	}
	if model == nil {
		return autoPlan{}, jobs.Invalid("Choose a model for Text in Admin → LLM first.")
	}
	if !model.priced {
		return autoPlan{}, jobs.Invalid("No list price is known for %s, so a dollar limit cannot be enforced. Choose a priced model for Text in LLM.", model.model)
	}
	var known []string
	for _, p := range s.auto.index.Projects() {
		known = append(known, p.Project)
	}
	c, err := auto.ParseInput(body["config"], known, s.now())
	if err != nil {
		return autoPlan{}, err
	}
	var rows []auto.Row
	for _, project := range c.Projects {
		f := s.autoFacts(project, model)
		rows = append(rows, auto.Row{State: f.state, Est: f.est})
	}
	cfg := auto.Config{Schedule: c.Schedule, Projects: c.Projects, Known: c.Known, Text: c.Text, Charts: c.Charts, LimitUSD: c.LimitUSD}
	return autoPlan{cfg: c, model: model, summary: auto.Summarize(cfg, rows, model.label), key: auto.AgreementKey(cfg, model.key)}, nil
}

func flatAuto(c *auto.Config) []audit.KV {
	if c == nil {
		return nil
	}
	var creates []string
	if c.Text {
		creates = append(creates, "TEXT")
	}
	if c.Charts {
		creates = append(creates, "AI flow charts")
	}
	return []audit.KV{
		{Key: "enabled", Value: c.Enabled},
		{Key: "schedule", Value: auto.DescribeSchedule(c.Schedule)},
		{Key: "projects", Value: strings.Join(c.Projects, ", ")},
		{Key: "creates", Value: strings.Join(creates, " + ")},
		{Key: "limitUsd", Value: c.LimitUSD},
	}
}

type consent struct {
	P   string `json:"p"`
	M   string `json:"m"`
	U   string `json:"u"`
	N   string `json:"n"`
	Exp int64  `json:"exp"`
}

func (s *Server) getAuto(_ http.ResponseWriter, _ *http.Request, _ string) (any, error) {
	return s.autoPayload()
}

func (s *Server) getAutoStatus(_ http.ResponseWriter, _ *http.Request, _ string) (any, error) {
	return s.runStatus()
}

// estimateAuto is step 4 of the tab: what the setup would cost (free: it reads notes only) and the one-time agreement token for saving it.
func (s *Server) estimateAuto(_ http.ResponseWriter, r *http.Request, who string) (any, error) {
	in, err := body(r)
	if err != nil {
		return nil, err
	}
	p, err := s.plan(in)
	if err != nil {
		return nil, err
	}
	token, err := secrets.SignToken(s.keys.Sign, consent{P: "auto", M: p.key, U: who, N: randomB64(12), Exp: s.now().Unix() + consentTTL})
	if err != nil {
		return nil, err
	}
	return map[string]any{"live": p.summary.Live, "agree": p.summary.Agree, "token": token}, nil
}

// saveAuto saves the setup. Only with the agreement token of exactly this setup; saving agrees to it and switches the schedule on.
func (s *Server) saveAuto(_ http.ResponseWriter, r *http.Request, who string) (any, error) {
	in, err := body(r)
	if err != nil {
		return nil, err
	}
	p, err := s.plan(in)
	if err != nil {
		return nil, err
	}
	var c consent
	token, _ := in["token"].(string)
	valid := secrets.VerifyToken(s.keys.Sign, token, s.now(), &c)
	s.auto.mu.Lock()
	_, used := s.auto.consents[c.N]
	s.auto.mu.Unlock()
	if !valid || c.P != "auto" || c.M != p.key || c.U != who || used {
		s.rec(r, audit.Input{Event: "denied", EntityType: "auto", EntityName: "Automatic update", User: who, Description: "Automatic update refused: no valid agreement (token missing, expired, reused or for a different setup)"})
		return nil, &httpError{status: http.StatusForbidden, msg: "The agreement has expired or does not match this setup. Press “Save schedule…” again and agree."}
	}
	if s.auto.runner.Active() {
		return nil, &httpError{status: http.StatusConflict, msg: "An automatic run is going. Wait until it has finished before changing the schedule."}
	}
	s.auto.mu.Lock()
	s.auto.consents[c.N] = c.Exp
	for n, exp := range s.auto.consents {
		if exp < s.now().Unix() {
			delete(s.auto.consents, n)
		}
	}
	s.auto.mu.Unlock()

	cur, err := s.auto.store.Get()
	if err != nil {
		return nil, err
	}
	before := cur.Config
	now := s.now()
	saved, err := s.auto.store.Update(func(f *auto.File) {
		f.Config = &auto.Config{
			Enabled: true, Schedule: p.cfg.Schedule, Projects: p.cfg.Projects, Known: p.cfg.Known, Text: p.cfg.Text, Charts: p.cfg.Charts, LimitUSD: p.cfg.LimitUSD,
			Agreement: &auto.Agreement{By: who, At: now.UTC().Format("2006-01-02T15:04:05.000Z"), Key: p.key},
		}
		f.NextRunAt = nil
		if n, ok := auto.NextRun(p.cfg.Schedule, now); ok {
			v := n.UTC().Format("2006-01-02T15:04:05.000Z")
			f.NextRunAt = &v
		}
		f.PausedReason = nil
	})
	if err != nil {
		return nil, err
	}
	var parts []string
	for _, f := range p.summary.Agree {
		parts = append(parts, f[0]+": "+f[1])
	}
	s.rec(r, audit.Input{Event: "auto_agree", EntityType: "auto", EntityName: "Automatic update", User: who, Changes: audit.DiffLines(flatAuto(before), flatAuto(saved.Config)), Description: "Agreed to automatic AI use (" + strings.Join(parts, "; ") + ")"})
	return s.autoPayload()
}

// switchAuto is the kill switch. Off needs nothing; on only when the saved agreement still matches the setup, the model and its limits.
func (s *Server) switchAuto(_ http.ResponseWriter, r *http.Request, who string) (any, error) {
	in, err := body(r)
	if err != nil {
		return nil, err
	}
	on := in["enabled"] == true
	st, err := s.auto.store.Get()
	if err != nil {
		return nil, err
	}
	if st.Config == nil {
		return nil, &httpError{status: http.StatusConflict, msg: "Set up the schedule first."}
	}
	var next *string
	if on {
		if !s.auto.runner.AgreementOK(*st.Config) {
			return nil, &httpError{status: http.StatusConflict, msg: "The agreement does not match the current setup (or no priced model is chosen). Press “Save schedule…” and agree again."}
		}
		n, ok := auto.NextRun(st.Config.Schedule, s.now())
		if !ok {
			return nil, &httpError{status: http.StatusConflict, msg: "The one-time moment is already in the past. Choose a new date and press “Save schedule…”."}
		}
		v := n.UTC().Format("2006-01-02T15:04:05.000Z")
		next = &v
	}
	if _, err := s.auto.store.Update(func(f *auto.File) {
		f.Config.Enabled = on
		f.NextRunAt = next
		f.PausedReason = nil
	}); err != nil {
		return nil, err
	}
	word := "OFF"
	if on {
		word = "ON"
	}
	s.rec(r, audit.Input{Event: "update", EntityType: "auto", EntityName: "Automatic update", User: who, Changes: audit.DiffLines([]audit.KV{{Key: "enabled", Value: st.Config.Enabled}}, []audit.KV{{Key: "enabled", Value: on}}), Description: "Automatic update switched " + word})
	return s.autoPayload()
}
