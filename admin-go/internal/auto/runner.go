// SPDX-License-Identifier: Apache-2.0

package auto

import (
	"errors"
	"fmt"
	"log"
	"math"
	"sync"
	"time"

	"github.com/lsegroup/mnemosyne/admin-go/internal/audit"
	"github.com/lsegroup/mnemosyne/admin-go/internal/engine"
)

// Deps is everything the runner needs from the rest of the program.
type Deps struct {
	Store *Store
	Now   func() time.Time
	// Sleep waits; replaced in tests.
	Sleep func(time.Duration)
	// KeyFor is the agreement fingerprint of this setup under the current model and limits; "" when no model is chosen or it has no price.
	KeyFor func(Config) (string, error)
	// Projects lists every project that has notes.
	Projects func() []string
	Inspect  func(project string) ProjectState
	// Worst is the worst case in US dollars of the next call of this kind for this project; nil when unknown.
	Worst func(project string, kind Kind) (*float64, error)
	// Generate runs ONE AI job and returns what it used. It fails with a plain message, or with an *engine.UnreachableError when the
	// connection itself failed (the run waits and sends it again).
	Generate func(project string, kind Kind, by string) (engine.Outcome, error)
	// Busy reports that a job started by a person is running.
	Busy func() bool
	// Hold is told when an automatic run starts (true) and ends (false); the Go admin uses it to tell the Node server that the AI is taken.
	Hold func(bool)
	Log  func(audit.Input)
}

// Runner decides when a run starts and drives it, one AI job at a time.
type Runner struct {
	d         Deps
	mu        sync.Mutex
	ticking   bool
	executing bool
	stop      chan struct{}
}

// NewRunner builds the runner; call Start to let it look at the clock.
func NewRunner(d Deps) *Runner {
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.Sleep == nil {
		d.Sleep = time.Sleep
	}
	if d.Busy == nil {
		d.Busy = func() bool { return false }
	}
	if d.Log == nil {
		d.Log = func(audit.Input) {}
	}
	return &Runner{d: d}
}

// Active reports that an automatic run is going: a person's AI button is refused meanwhile.
func (r *Runner) Active() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.executing
}

func (r *Runner) setExecuting(v bool) {
	r.mu.Lock()
	r.executing = v
	r.mu.Unlock()
	if r.d.Hold != nil {
		r.d.Hold(v)
	}
}

// Start looks at the clock every 30 seconds.
func (r *Runner) Start() {
	r.mu.Lock()
	if r.stop != nil {
		r.mu.Unlock()
		return
	}
	r.stop = make(chan struct{})
	stop := r.stop
	r.mu.Unlock()
	go func() {
		t := time.NewTicker(tickInterval)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				r.Tick()
			}
		}
	}()
}

// Stop ends the clock watching.
func (r *Runner) Stop() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.stop != nil {
		close(r.stop)
		r.stop = nil
	}
}

// AgreementOK reports whether the saved agreement still matches the setup, the model and its limits.
func (r *Runner) AgreementOK(cfg Config) bool {
	if cfg.Agreement == nil {
		return false
	}
	key, err := r.d.KeyFor(cfg)
	return err == nil && key != "" && key == cfg.Agreement.Key
}

// Tick is one look at the clock. It never fails: a problem here must not take the portal down.
func (r *Runner) Tick() {
	r.mu.Lock()
	if r.ticking {
		r.mu.Unlock()
		return
	}
	r.ticking = true
	r.mu.Unlock()
	defer func() {
		r.mu.Lock()
		r.ticking = false
		r.mu.Unlock()
	}()
	if err := r.step(); err != nil {
		log.Printf("auto: tick failed: %v", err)
	}
}

func (r *Runner) setPaused(reason *string) error {
	st, err := r.d.Store.Get()
	if err != nil {
		return err
	}
	same := (st.PausedReason == nil && reason == nil) || (st.PausedReason != nil && reason != nil && *st.PausedReason == *reason)
	if same {
		return nil
	}
	_, err = r.d.Store.Update(func(f *File) { f.PausedReason = reason })
	return err
}

func (r *Runner) step() error {
	st, err := r.d.Store.Get()
	if err != nil {
		return err
	}
	cfg := st.Config
	if cfg == nil {
		return nil
	}
	if st.Run != nil && st.Run.Status == "running" {
		// a run that was cut off by a restart goes on with the projects it had not done
		if cfg.Enabled && r.AgreementOK(*cfg) {
			r.setExecuting(true)
			return r.execute(st.Run.ID)
		}
		note := "Switched off during the run"
		if cfg.Enabled {
			note = "The agreement no longer matches the setup"
		}
		return r.finish(st.Run.ID, "stopped", note)
	}
	if !cfg.Enabled {
		return nil
	}
	if !r.AgreementOK(*cfg) {
		return r.setPaused(ptr("The agreement no longer matches: the model, its token limits or the setup changed. Open Auto and agree again."))
	}
	if err := r.setPaused(nil); err != nil {
		return err
	}
	if st.NextRunAt == nil {
		return nil
	}
	due, err := time.Parse(time.RFC3339, *st.NextRunAt)
	if err != nil {
		return nil
	}
	now := r.d.Now()
	if due.After(now) {
		return nil
	}
	if r.d.Busy() {
		return nil // a person's job is running: look again in 30 seconds
	}

	var next *string
	if n, ok := NextRun(cfg.Schedule, laterOf(now, due)); ok {
		next = ptr(iso(n))
	}
	late := now.Sub(due)
	base := Run{ID: stamp(now), ScheduledFor: *st.NextRunAt, Trigger: triggerName(cfg.Schedule, due), Updated: []string{}, Unchanged: []string{}, Failed: []Failure{}, NotReached: []string{}, Queue: []QueueItem{}, Usage: &[]Usage{}, Warnings: []string{}}
	if late > MaxLate {
		hours := int(math.Floor(late.Hours() + 0.5))
		missed := base
		missed.StartedAt, missed.FinishedAt, missed.Status = iso(now), iso(now), "missed"
		missed.Note = fmt.Sprintf("The server was not running at the planned time; this was %d hours late (the limit is 12), so the run was skipped.", hours)
		_, err := r.d.Store.Update(func(f *File) {
			f.NextRunAt = next
			f.Runs = append([]Run{missed}, f.Runs...)
			if len(f.Runs) > RunHistory {
				f.Runs = f.Runs[:RunHistory]
			}
		})
		r.d.Log(audit.Input{Event: "auto_run", EntityType: "auto", EntityName: "Automatic update", User: "auto", Description: fmt.Sprintf("Run skipped: %d hours late (the server was not running at the planned time)", hours)})
		return err
	}

	// From here on a person's AI button is refused, until the run is over.
	r.setExecuting(true)
	existing := map[string]bool{}
	for _, p := range r.d.Projects() {
		existing[p] = true
	}
	queue, unchanged := []QueueItem{}, []string{}
	for _, project := range cfg.Projects {
		if !existing[project] {
			continue
		}
		text, charts := WouldRun(r.d.Inspect(project), *cfg)
		if text || charts {
			queue = append(queue, QueueItem{Project: project, Text: text, Charts: charts})
		} else {
			unchanged = append(unchanged, project)
		}
	}
	run := base
	run.StartedAt, run.Status, run.Unchanged, run.Queue, run.Total = iso(now), "running", unchanged, queue, len(queue)
	if _, err := r.d.Store.Update(func(f *File) {
		f.Run = &run
		f.NextRunAt = next
	}); err != nil {
		r.setExecuting(false)
		return err
	}
	r.d.Log(audit.Input{Event: "auto_run", EntityType: "auto", EntityName: "Automatic update", User: "auto", Description: fmt.Sprintf("Run started (%s): %d projects to update, %d unchanged, spending limit %s, agreed by %s", run.Trigger, len(queue), len(unchanged), USD(cfg.LimitUSD), cfg.Agreement.By)})
	return r.execute(run.ID)
}

func laterOf(a, b time.Time) time.Time {
	if a.After(b) {
		return a
	}
	return b
}

func (r *Runner) mutate(id string, fn func(*Run)) error {
	_, err := r.d.Store.Update(func(f *File) {
		if f.Run != nil && f.Run.ID == id {
			fn(f.Run)
		}
	})
	return err
}

func round6(v float64) float64 { return math.Round(v*1e6) / 1e6 }

func (r *Runner) finish(id, status, note string) error {
	var done *Run
	if _, err := r.d.Store.Update(func(f *File) {
		run := f.Run
		if run == nil || run.ID != id {
			return
		}
		left := []string{}
		for _, q := range run.Queue {
			left = append(left, q.Project)
		}
		d := *run
		d.Status, d.FinishedAt, d.NotReached, d.Queue, d.Current = status, iso(r.d.Now()), append(append([]string{}, run.NotReached...), left...), []QueueItem{}, nil
		if note != "" {
			d.Note = note
		}
		d.USD = round6(run.USD)
		f.Runs = append([]Run{d}, f.Runs...)
		if len(f.Runs) > RunHistory {
			f.Runs = f.Runs[:RunHistory]
		}
		f.Run = nil
		done = &d
	}); err != nil {
		return err
	}
	if done != nil {
		d := done
		started, _ := time.Parse(time.RFC3339, d.StartedAt)
		finished, _ := time.Parse(time.RFC3339, d.FinishedAt)
		tail := ""
		if note != "" {
			tail = "; " + note
		}
		r.d.Log(audit.Input{Event: "auto_run", EntityType: "auto", EntityName: "Automatic update", User: "auto", Description: fmt.Sprintf("Run %s: %d updated, %d unchanged, %d failed, %d not reached; %d tokens in, %d out; cost $%.4f%s; ran %s%s", status, len(d.Updated), len(d.Unchanged), len(d.Failed), len(d.NotReached), d.InputTokens, d.OutputTokens, d.USD, usageWords(d.Usage), FormatDuration(finished.Sub(started).Milliseconds()), tail)})
	}
	return nil
}

// usageWords is the TEXT / IMAGES split of a run in words, for the audit trail.
func usageWords(u *[]Usage) string {
	if u == nil || len(*u) == 0 {
		return ""
	}
	var parts []string
	for _, k := range []Kind{engine.Wiki, engine.Diagram, engine.Painted} {
		cost, calls := 0.0, 0
		var models []string
		seen := map[string]bool{}
		for _, x := range *u {
			if x.Kind == k {
				cost += x.USD
				calls += x.Calls
				if !seen[x.Model] {
					seen[x.Model] = true
					models = append(models, x.Model)
				}
			}
		}
		if calls == 0 && len(models) == 0 {
			continue
		}
		label := "IMAGES"
		switch k {
		case engine.Wiki:
			label = "TEXT"
		case engine.Painted:
			label = "PICTURES"
		}
		parts = append(parts, fmt.Sprintf("%s $%.4f in %d calls (%s)", label, cost, calls, joinComma(models)))
	}
	return " (" + joinSemi(parts) + ")"
}

func joinComma(s []string) string { return joinWith(s, ", ") }
func joinSemi(s []string) string  { return joinWith(s, "; ") }
func joinWith(s []string, sep string) string {
	out := ""
	for i, x := range s {
		if i > 0 {
			out += sep
		}
		out += x
	}
	return out
}

// stopReason is why the run must stop now, or "".
func (r *Runner) stopReason() string {
	st, err := r.d.Store.Get()
	if err != nil || st.Config == nil || !st.Config.Enabled {
		return "Switched off during the run"
	}
	if !r.AgreementOK(*st.Config) {
		return "The agreement no longer matches the setup"
	}
	return ""
}

// waitIdle waits (at most half an hour) while a person's job is running; it is never started on top of it.
func (r *Runner) waitIdle() bool {
	for i := 0; i < 360 && r.d.Busy(); i++ {
		r.d.Sleep(5 * time.Second)
	}
	return !r.d.Busy()
}

// waitOutage is a pause of d while the provider cannot be reached, in 5-second steps so the switch is noticed quickly. It returns why the
// run must stop, or "".
func (r *Runner) waitOutage(d time.Duration) string {
	for i := 0; i < int(d/(5*time.Second)); i++ {
		r.d.Sleep(5 * time.Second)
		if s := r.stopReason(); s != "" {
			return s
		}
	}
	return ""
}

func addUsage(list *[]Usage, e Usage) {
	for i := range *list {
		row := &(*list)[i]
		if row.Model == e.Model && row.Kind == e.Kind {
			row.Calls += e.Calls
			row.InputTokens += e.InputTokens
			row.OutputTokens += e.OutputTokens
			if e.ReasoningTokens != nil {
				v := *e.ReasoningTokens
				if row.ReasoningTokens != nil {
					v += *row.ReasoningTokens
				}
				row.ReasoningTokens = &v
			}
			row.USD = round6(row.USD + e.USD)
			row.MS += e.MS
			return
		}
	}
	e.USD = round6(e.USD)
	*list = append(*list, e)
}

// execute drives the run. The caller has set executing; it is cleared when the run is over, however it ends.
func (r *Runner) execute(id string) error {
	defer r.setExecuting(false)
	giveUps := 0 // projects in a row that the provider could not be reached for
	for {
		st, err := r.d.Store.Get()
		if err != nil {
			return err
		}
		run := st.Run
		if run == nil || run.ID != id || run.Status != "running" {
			return nil
		}
		cfg := st.Config
		if cfg == nil || !cfg.Enabled {
			return r.finish(id, "stopped", "Switched off during the run")
		}
		if !r.AgreementOK(*cfg) {
			return r.finish(id, "stopped", "The agreement no longer matches the setup")
		}
		if len(run.Queue) == 0 {
			status := "nothing"
			if len(run.Updated) > 0 || len(run.Failed) > 0 {
				status = "completed"
			}
			return r.finish(id, status, "")
		}
		item := run.Queue[0]

		if item.Attempts >= MaxAttempts {
			if err := r.mutate(id, func(x *Run) {
				x.Failed = append(x.Failed, Failure{Project: item.Project, Error: "The service was restarted during this project twice; it was skipped."})
				x.Queue = x.Queue[1:]
			}); err != nil {
				return err
			}
			continue
		}
		if err := r.mutate(id, func(x *Run) { x.Queue[0].Attempts++ }); err != nil {
			return err
		}

		failure := ""
		gaveUp := false
		did := 0
		// stopHere ends the run in the middle of a project: what was saved of it counts as updated, the rest is listed as not reached.
		stopHere := func(status, note string) error {
			if err := r.mutate(id, func(x *Run) {
				x.Current = nil
				if did > 0 || item.WikiDone || item.ChartsDone {
					x.Queue = x.Queue[1:]
					x.Updated = append(x.Updated, item.Project)
				}
			}); err != nil {
				return err
			}
			return r.finish(id, status, note)
		}
		for _, kind := range []Kind{engine.Wiki, engine.Diagram} {
			if kind == engine.Wiki && (!item.Text || item.WikiDone) || kind == engine.Diagram && (!item.Charts || item.ChartsDone) {
				continue
			}
			// the switch and the agreement are looked at again before EVERY call, not only between projects
			if s := r.stopReason(); s != "" {
				return stopHere("stopped", s)
			}
			if !r.waitIdle() {
				failure = "A job started by a person kept the AI busy for half an hour."
				break
			}
			worst, err := r.d.Worst(item.Project, kind)
			if err != nil {
				return err
			}
			cur, _ := r.d.Store.Get()
			spent := 0.0
			if cur.Run != nil {
				spent = cur.Run.USD
			}
			if worst == nil {
				failure = "The cost of this call cannot be limited: the model has no list price."
				break
			}
			if spent+*worst > cfg.LimitUSD {
				return stopHere("limit", fmt.Sprintf("Stopped before %s: its next call could cost up to %s and the run had used %s of the %s limit.", item.Project, USD(*worst), USD(spent), USD(cfg.LimitUSD)))
			}
			if err := r.mutate(id, func(x *Run) { x.Current = &Current{Project: item.Project, Kind: kind, Since: iso(r.d.Now())} }); err != nil {
				return err
			}
			what := "article"
			if kind == engine.Diagram {
				what = "diagrams"
			}
			r.d.Log(audit.Input{Event: "auto_start", EntityType: "docs_" + string(kind), EntityName: item.Project, User: "auto", Description: fmt.Sprintf("Automatic update (agreed by %s): %s for %s; at most %s; run so far %s of %s", cfg.Agreement.By, what, item.Project, USD(*worst), USD(spent), USD(cfg.LimitUSD))})
			waited := time.Duration(0)
			tries := 0
			for {
				began := r.d.Now()
				out, err := r.d.Generate(item.Project, kind, cfg.Agreement.By)
				if err == nil {
					took := r.d.Now().Sub(began).Milliseconds()
					if took < 0 {
						took = 0
					}
					did++
					if err := r.mutate(id, func(x *Run) {
						cost := *worst
						if out.USD != nil {
							cost = *out.USD
						}
						x.InputTokens += out.InputTokens
						x.OutputTokens += out.OutputTokens
						x.USD = round6(x.USD + cost)
						if x.Usage == nil {
							x.Usage = &[]Usage{}
						}
						addUsage(x.Usage, Usage{Model: out.Model, Kind: kind, Calls: 1, InputTokens: out.InputTokens, OutputTokens: out.OutputTokens, ReasoningTokens: out.ReasoningTokens, USD: cost, MS: took})
						// the image model's calls inside a diagram job are their own line (they used no tokens, they are billed per picture)
						if p := out.Picture; p != nil {
							x.USD = round6(x.USD + p.USD)
							addUsage(x.Usage, Usage{Model: p.Model, Kind: engine.Painted, Calls: p.Count, USD: p.USD, MS: p.MS})
						}
						if out.Warning != "" {
							x.Warnings = append(x.Warnings, item.Project+": "+out.Warning)
						}
						if x.Current != nil {
							x.Current.Waiting = ""
						}
						if kind == engine.Wiki {
							x.Queue[0].WikiDone = true
						} else {
							x.Queue[0].ChartsDone = true
						}
					}); err != nil {
						return err
					}
					if waited > 0 {
						r.d.Log(audit.Input{Event: "auto_run", EntityType: "auto", EntityName: "Automatic update", User: "auto", Description: fmt.Sprintf("The provider is reachable again after %d minute(s); the run goes on", int(math.Floor(waited.Minutes()+0.5)))})
					}
					break
				}
				var unreachable *engine.UnreachableError
				if !errors.As(err, &unreachable) {
					failure = what + ": " + err.Error()
					break
				}
				// The connection itself failed, so nothing reached the provider and nothing was billed: wait and send the same call again.
				why := trimDot(unreachable.Msg)
				if tries >= len(OutageSteps) {
					// this project is given up on, the run goes on with the next one (the provider may be back for it)
					gaveUp = true
					failure = fmt.Sprintf("%s: %s for %d minutes, so this project was given up on and is still due at the next run", what, why, int(OutageMax.Minutes()))
					break
				}
				step := OutageSteps[tries]
				if tries == 0 {
					r.d.Log(audit.Input{Event: "auto_run", EntityType: "auto", EntityName: "Automatic update", User: "auto", Description: fmt.Sprintf("%s while working on %s; the run waits and tries again with growing pauses (1, 2, 4 and 8 minutes), for at most %d minutes", why, item.Project, int(OutageMax.Minutes()))})
				}
				tries++
				waited += step
				if err := r.mutate(id, func(x *Run) {
					if x.Current != nil {
						x.Current.Waiting = fmt.Sprintf("%s: waiting %d minute(s) (retry %d of %d)", why, int(step.Minutes()), tries, len(OutageSteps))
					}
				}); err != nil {
					return err
				}
				if s := r.waitOutage(step); s != "" {
					return stopHere("stopped", s)
				}
			}
			if failure != "" {
				break
			}
		}
		if err := r.mutate(id, func(x *Run) {
			x.Current = nil
			x.Queue = x.Queue[1:]
			if failure != "" {
				msg := failure
				if did > 0 {
					msg += " (the earlier step was saved)"
				}
				x.Failed = append(x.Failed, Failure{Project: item.Project, Error: msg})
			} else {
				x.Updated = append(x.Updated, item.Project)
			}
		}); err != nil {
			return err
		}
		if !gaveUp {
			giveUps = 0
		} else if giveUps++; giveUps >= MaxGiveUps {
			return r.finish(id, "stopped", fmt.Sprintf("The provider could not be reached for %d projects in a row (each tried for %d minutes), so the run was stopped. Nothing was lost: what was not done is listed as not reached and is still due at the next run.", MaxGiveUps, int(OutageMax.Minutes())))
		}
	}
}

func trimDot(s string) string {
	if len(s) > 0 && s[len(s)-1] == '.' {
		return s[:len(s)-1]
	}
	return s
}
