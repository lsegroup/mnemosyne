// SPDX-License-Identifier: Apache-2.0

package auto

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lsegroup/mnemosyne/admin-go/internal/audit"
	"github.com/lsegroup/mnemosyne/admin-go/internal/engine"
	"github.com/lsegroup/mnemosyne/admin-go/internal/jobs"
)

type rig struct {
	t      *testing.T
	store  *Store
	runner *Runner
	clock  time.Time
	key    string // the agreement fingerprint the "model" currently has
	states map[string]ProjectState
	worst  map[Kind]*float64
	busy   bool
	logs   []audit.Input
	calls  []string
	// generate is what the AI "does"; it may advance the clock and change the store
	generate func(project string, kind Kind) (engine.Outcome, error)
}

func fptr(v float64) *float64 { return &v }

func newRig(t *testing.T) *rig {
	r := &rig{t: t, clock: time.Date(2026, 11, 7, 1, 0, 0, 0, time.UTC), key: "key-1", states: map[string]ProjectState{}, worst: map[Kind]*float64{engine.Wiki: fptr(0.10), engine.Diagram: fptr(0.05)}}
	r.store = NewStore(filepath.Join(t.TempDir(), "auto.json"))
	r.generate = func(project string, kind Kind) (engine.Outcome, error) {
		r.clock = r.clock.Add(90 * time.Second)
		return engine.Outcome{Model: "muse-spark-1.3-contributor", InputTokens: 1000, OutputTokens: 4000, USD: fptr(0.0009)}, nil
	}
	r.runner = NewRunner(Deps{
		Store:  r.store,
		Now:    func() time.Time { return r.clock },
		Sleep:  func(d time.Duration) { r.clock = r.clock.Add(d) },
		KeyFor: func(Config) (string, error) { return r.key, nil },
		Projects: func() []string {
			var out []string
			for p := range r.states {
				out = append(out, p)
			}
			return out
		},
		Inspect: func(p string) ProjectState { return r.states[p] },
		Worst:   func(_ string, k Kind) (*float64, error) { return r.worst[k], nil },
		Generate: func(p string, k Kind, by string) (engine.Outcome, error) {
			r.calls = append(r.calls, p+":"+string(k)+":"+by)
			return r.generate(p, k)
		},
		Busy: func() bool { return r.busy },
		Log:  func(e audit.Input) { r.logs = append(r.logs, e) },
	})
	return r
}

// setup saves an agreed, switched-on schedule whose next run is due now.
func (r *rig) setup(projects []string, text, charts bool, limit float64) {
	r.t.Helper()
	cfg := Config{Enabled: true, Schedule: Schedule{Mode: "weekly", Days: []int{6}, Time: "01:00", TZ: "UTC"}, Projects: projects, Known: projects, Text: text, Charts: charts, LimitUSD: limit, Agreement: &Agreement{By: "store", At: iso(r.clock), Key: r.key}}
	if _, err := r.store.Update(func(f *File) {
		f.Config = &cfg
		f.NextRunAt = ptr(iso(r.clock))
	}); err != nil {
		r.t.Fatal(err)
	}
}

func (r *rig) changed(project string) {
	r.states[project] = ProjectState{Project: project, Notes: 5, HasArticle: true, TextDue: true, ChartsDue: true, Detail: "2 notes new or changed"}
}
func (r *rig) unchanged(project string) {
	r.states[project] = ProjectState{Project: project, Notes: 5, HasArticle: true, Detail: "up to date"}
}

func (r *rig) state() File {
	r.t.Helper()
	f, err := r.store.Get()
	if err != nil {
		r.t.Fatal(err)
	}
	return f
}

func (r *rig) logged(event, contains string) bool {
	for _, l := range r.logs {
		if l.Event == event && strings.Contains(l.Description, contains) {
			return true
		}
	}
	return false
}

func is[T comparable](t *testing.T, got, want T, what string) {
	t.Helper()
	if got != want {
		t.Errorf("%s: got %v, want %v", what, got, want)
	}
}

func TestADueRunUpdatesOnlyTheProjectsThatChangedAndRecordsWhatItUsed(t *testing.T) {
	r := newRig(t)
	r.changed("alpha")
	r.unchanged("beta")
	r.setup([]string{"alpha", "beta", "gone"}, true, true, 5) // "gone" has no notes any more
	r.runner.Tick()

	f := r.state()
	if f.Run != nil || len(f.Runs) != 1 {
		t.Fatalf("the run is over and in the history: run=%v runs=%d", f.Run, len(f.Runs))
	}
	run := f.Runs[0]
	is(t, run.Status, "completed", "status")
	is(t, strings.Join(run.Updated, ","), "alpha", "updated")
	is(t, strings.Join(run.Unchanged, ","), "beta", "unchanged")
	is(t, len(run.Failed), 0, "failed")
	is(t, strings.Join(r.calls, " "), "alpha:wiki:store alpha:diagram:store", "calls: the article, then the charts, one at a time")
	is(t, run.InputTokens, 2000, "tokens in")
	is(t, run.OutputTokens, 8000, "tokens out")
	is(t, run.USD, 0.0018, "cost")
	is(t, run.Total, 1, "total")
	is(t, run.Trigger, "Saturday 01:00 schedule", "trigger")
	is(t, run.ID, "20261107T010000Z", "id")
	u := *run.Usage
	is(t, len(u), 2, "usage rows (TEXT and IMAGES)")
	is(t, u[0].Kind, engine.Wiki, "TEXT first")
	is(t, u[0].MS, int64(90_000), "how long the call took")
	is(t, u[1].Kind, engine.Diagram, "then IMAGES")
	is(t, u[1].Model, "muse-spark-1.3-contributor", "the model that answered")
	is(t, *f.NextRunAt, "2026-11-14T01:00:00.000Z", "the next run is a week later")
	is(t, r.runner.Active(), false, "not active any more")

	if !r.logged("auto_run", "Run started (Saturday 01:00 schedule): 1 projects to update, 1 unchanged, spending limit $5.00, agreed by store") {
		t.Errorf("the start is audited: %+v", r.logs)
	}
	if !r.logged("auto_start", "Automatic update (agreed by store): article for alpha; at most $0.10; run so far $<0.01 of $5.00") {
		t.Errorf("each call is audited: %+v", r.logs)
	}
	if !r.logged("auto_run", "Run completed: 1 updated, 1 unchanged, 0 failed, 0 not reached; 2000 tokens in, 8000 out; cost $0.0018 (TEXT $0.0009 in 1 calls (muse-spark-1.3-contributor); IMAGES $0.0009 in 1 calls (muse-spark-1.3-contributor)); ran 3 min 0 s") {
		t.Errorf("the end is audited with the split: %+v", r.logs)
	}
}

func TestNothingHappensBeforeItIsDueOrWhileSwitchedOff(t *testing.T) {
	r := newRig(t)
	r.changed("alpha")
	r.setup([]string{"alpha"}, true, false, 5)
	r.store.Update(func(f *File) { f.NextRunAt = ptr(iso(r.clock.Add(time.Hour))) })
	r.runner.Tick()
	is(t, len(r.calls), 0, "not due yet")
	r.clock = r.clock.Add(2 * time.Hour)
	r.store.Update(func(f *File) { f.Config.Enabled = false })
	r.runner.Tick()
	is(t, len(r.calls), 0, "switched off")
	is(t, len(r.state().Runs), 0, "no run")
}

func TestAChangedModelOrSetupPausesInsteadOfRunning(t *testing.T) {
	r := newRig(t)
	r.changed("alpha")
	r.setup([]string{"alpha"}, true, false, 5)
	r.key = "key-2" // the model, its limits or its prompts changed after the agreement
	r.runner.Tick()
	f := r.state()
	is(t, len(r.calls), 0, "no AI call")
	if f.PausedReason == nil || !strings.HasPrefix(*f.PausedReason, "The agreement no longer matches") {
		t.Fatalf("paused: %v", f.PausedReason)
	}
	r.key = "key-1"
	r.runner.Tick()
	f = r.state()
	if f.PausedReason != nil {
		t.Errorf("the pause is lifted when the agreement matches again: %v", *f.PausedReason)
	}
	is(t, len(f.Runs), 1, "and the run goes ahead")
}

func TestTheRunStopsBeforeACallThatCouldPassTheDollarLimit(t *testing.T) {
	r := newRig(t)
	for _, p := range []string{"alpha", "beta", "gamma"} {
		r.changed(p)
	}
	r.worst[engine.Wiki] = fptr(0.30)
	r.setup([]string{"alpha", "beta", "gamma"}, true, false, 0.7)
	r.generate = func(string, Kind) (engine.Outcome, error) {
		r.clock = r.clock.Add(time.Minute)
		return engine.Outcome{Model: "m", InputTokens: 10, OutputTokens: 10, USD: fptr(0.25)}, nil
	}
	r.runner.Tick()
	run := r.state().Runs[0]
	is(t, run.Status, "limit", "status")
	is(t, strings.Join(run.Updated, ","), "alpha,beta", "what was done")
	is(t, strings.Join(run.NotReached, ","), "gamma", "what was not reached")
	is(t, run.Note, "Stopped before gamma: its next call could cost up to $0.30 and the run had used $0.50 of the $0.70 limit.", "note")
	is(t, len(r.calls), 2, "calls")
}

func TestAFailedProjectIsListedAndTheRunGoesOn(t *testing.T) {
	r := newRig(t)
	r.changed("alpha")
	r.changed("beta")
	r.setup([]string{"alpha", "beta"}, true, true, 5)
	r.generate = func(project string, kind Kind) (engine.Outcome, error) {
		r.clock = r.clock.Add(time.Minute)
		if project == "alpha" && kind == engine.Diagram {
			return engine.Outcome{}, jobs.Invalid("The AI answered, but not with a usable diagram plan: the plan has no arrows between its boxes.")
		}
		if project == "beta" && kind == engine.Wiki {
			return engine.Outcome{}, jobs.Invalid("The provider rejected the API key (HTTP 401).")
		}
		return engine.Outcome{Model: "m", InputTokens: 1, OutputTokens: 1, USD: fptr(0.001), Warning: "left out: Access"}, nil
	}
	r.runner.Tick()
	run := r.state().Runs[0]
	is(t, run.Status, "completed", "status")
	is(t, len(run.Failed), 2, "both failed")
	is(t, run.Failed[0].Error, "diagrams: The AI answered, but not with a usable diagram plan: the plan has no arrows between its boxes. (the earlier step was saved)", "the diagrams failed after the article was saved")
	is(t, run.Failed[1].Error, "article: The provider rejected the API key (HTTP 401).", "the article failed")
	is(t, len(run.Updated), 0, "nothing counts as updated")
	is(t, len(run.Warnings), 1, "a warning of the saved article")
	is(t, run.Warnings[0], "alpha: left out: Access", "warning text")
}

func TestAnUnreachableProviderIsWaitedForAndTheSameCallIsSentAgain(t *testing.T) {
	r := newRig(t)
	r.changed("alpha")
	r.setup([]string{"alpha"}, true, false, 5)
	attempts := 0
	r.generate = func(string, Kind) (engine.Outcome, error) {
		attempts++
		if attempts <= 2 {
			return engine.Outcome{}, &engine.UnreachableError{Msg: "Could not reach the provider (no such host)."}
		}
		r.clock = r.clock.Add(30 * time.Second)
		return engine.Outcome{Model: "m", InputTokens: 5, OutputTokens: 5, USD: fptr(0.01)}, nil
	}
	start := r.clock
	r.runner.Tick()
	run := r.state().Runs[0]
	is(t, run.Status, "completed", "status")
	is(t, attempts, 3, "the same call was sent three times")
	is(t, r.clock.Sub(start), 3*time.Minute+30*time.Second, "one and two minutes of waiting (growing pauses), then the call")
	is(t, (*run.Usage)[0].MS, int64(30_000), "waiting is not in the time of the call")
	if !r.logged("auto_run", "Could not reach the provider (no such host) while working on alpha; the run waits and tries again with growing pauses (1, 2, 4 and 8 minutes), for at most 15 minutes") {
		t.Errorf("the wait is audited: %+v", r.logs)
	}
	if !r.logged("auto_run", "The provider is reachable again after 3 minute(s); the run goes on") {
		t.Errorf("the return is audited: %+v", r.logs)
	}
}

// One bad stretch gives up on ONE project only: the run goes on with the next one (two Oct 31 runs lost 25 and 80 projects to EAI_AGAIN).
func TestAProviderThatStaysAwayGivesUpOnTheProjectAndTheRunGoesOn(t *testing.T) {
	r := newRig(t)
	r.changed("alpha")
	r.changed("beta")
	r.setup([]string{"alpha", "beta"}, true, false, 5)
	r.generate = func(project string, kind Kind) (engine.Outcome, error) {
		if project == "beta" { // the provider is back for the second project
			r.clock = r.clock.Add(30 * time.Second)
			return engine.Outcome{Model: "m", InputTokens: 5, OutputTokens: 5, USD: fptr(0.01)}, nil
		}
		return engine.Outcome{}, &engine.UnreachableError{Msg: "Could not reach the provider (no such host)."}
	}
	start := r.clock
	r.runner.Tick()
	run := r.state().Runs[0]
	is(t, run.Status, "completed", "the run is not abandoned")
	is(t, strings.Join(run.Updated, ","), "beta", "the second project was done")
	is(t, len(run.Failed), 1, "one project given up on")
	is(t, run.Failed[0].Project, "alpha", "which")
	is(t, run.Failed[0].Error, "article: Could not reach the provider (no such host) for 15 minutes, so this project was given up on and is still due at the next run", "why")
	is(t, len(r.calls), 6, "the first try and one more after pauses of 1, 2, 4 and 8 minutes, then beta")
	is(t, r.clock.Sub(start), 15*time.Minute+30*time.Second, "15 minutes of growing pauses, then beta")
	is(t, len(run.NotReached), 0, "nothing is left unreached")
}

// If the provider stays away for MaxGiveUps projects in a row it is really down: the run stops and lists the rest as not reached.
func TestAProviderThatIsReallyDownStopsTheRunAfterThreeProjects(t *testing.T) {
	r := newRig(t)
	for _, p := range []string{"alpha", "beta", "gamma", "delta"} {
		r.changed(p)
	}
	r.setup([]string{"alpha", "beta", "gamma", "delta"}, true, false, 5)
	r.generate = func(string, Kind) (engine.Outcome, error) {
		return engine.Outcome{}, &engine.UnreachableError{Msg: "Could not reach the provider (connection refused)."}
	}
	r.runner.Tick()
	run := r.state().Runs[0]
	is(t, run.Status, "stopped", "status")
	is(t, run.Note, "The provider could not be reached for 3 projects in a row (each tried for 15 minutes), so the run was stopped. Nothing was lost: what was not done is listed as not reached and is still due at the next run.", "note")
	is(t, len(run.Failed), 3, "three projects given up on")
	is(t, strings.Join(run.NotReached, ","), "delta", "the rest was not reached")
	is(t, len(r.calls), 15, "five tries for each of the three projects")
}

func TestSwitchingOffDuringARunStopsBeforeTheNextCall(t *testing.T) {
	r := newRig(t)
	r.changed("alpha")
	r.changed("beta")
	r.setup([]string{"alpha", "beta"}, true, true, 5)
	r.generate = func(string, Kind) (engine.Outcome, error) {
		r.clock = r.clock.Add(time.Minute)
		r.store.Update(func(f *File) { f.Config.Enabled = false }) // the administrator pressed the switch
		return engine.Outcome{Model: "m", InputTokens: 1, OutputTokens: 1, USD: fptr(0.001)}, nil
	}
	r.runner.Tick()
	run := r.state().Runs[0]
	is(t, run.Status, "stopped", "status")
	is(t, run.Note, "Switched off during the run", "note")
	is(t, len(r.calls), 1, "no second call")
	is(t, strings.Join(run.Updated, ","), "alpha", "what was saved of alpha counts")
	is(t, strings.Join(run.NotReached, ","), "beta", "beta was not reached")
}

func TestARunThatIsTooLateIsSkipped(t *testing.T) {
	r := newRig(t)
	r.changed("alpha")
	r.setup([]string{"alpha"}, true, false, 5)
	r.clock = r.clock.Add(13 * time.Hour) // the server was down at the planned time
	r.runner.Tick()
	f := r.state()
	is(t, len(r.calls), 0, "no AI call")
	is(t, f.Runs[0].Status, "missed", "status")
	is(t, f.Runs[0].Note, "The server was not running at the planned time; this was 13 hours late (the limit is 12), so the run was skipped.", "note")
	is(t, *f.NextRunAt, "2026-11-14T01:00:00.000Z", "the next run is planned")
}

func TestAPersonsJobHoldsTheRunBack(t *testing.T) {
	r := newRig(t)
	r.changed("alpha")
	r.setup([]string{"alpha"}, true, false, 5)
	r.busy = true
	r.runner.Tick()
	is(t, len(r.calls), 0, "waits while a person's AI job runs")
	is(t, len(r.state().Runs), 0, "and has not started")
	r.busy = false
	r.runner.Tick()
	is(t, len(r.calls), 1, "goes ahead afterwards")
}

func TestARunCutOffByARestartGoesOnWithWhatWasNotDone(t *testing.T) {
	r := newRig(t)
	r.changed("alpha")
	r.setup([]string{"alpha", "beta"}, true, false, 5)
	r.store.Update(func(f *File) {
		f.Run = &Run{ID: "20261107T010000Z", StartedAt: iso(r.clock), ScheduledFor: iso(r.clock), Trigger: "Saturday 01:00 schedule", Status: "running", Total: 2,
			Queue: []QueueItem{{Project: "alpha", Text: true, Attempts: 2}, {Project: "beta", Text: true, Attempts: 0}}, Usage: &[]Usage{}}
		f.NextRunAt = ptr("2026-11-14T01:00:00.000Z")
	})
	r.states["beta"] = ProjectState{Project: "beta", TextDue: true, ChartsDue: true, HasArticle: true}
	r.runner.Tick()
	run := r.state().Runs[0]
	is(t, run.Status, "completed", "status")
	is(t, len(run.Failed), 1, "alpha was cut off twice")
	is(t, run.Failed[0].Error, "The service was restarted during this project twice; it was skipped.", "message")
	is(t, strings.Join(run.Updated, ","), "beta", "beta was done")
	is(t, strings.Join(r.calls, " "), "beta:wiki:store", "only beta was sent")
}

func TestTheOneThatCannotBePricedIsNeverRun(t *testing.T) {
	r := newRig(t)
	r.changed("alpha")
	r.worst[engine.Wiki] = nil // the model has no list price
	r.setup([]string{"alpha"}, true, false, 5)
	r.runner.Tick()
	run := r.state().Runs[0]
	is(t, len(r.calls), 0, "no call")
	is(t, run.Failed[0].Error, "The cost of this call cannot be limited: the model has no list price.", "message")
}

func TestTheStoreKeepsTheNodeFormat(t *testing.T) {
	r := newRig(t)
	r.changed("alpha")
	r.setup([]string{"alpha"}, true, false, 5)
	r.runner.Tick()
	raw := engine.JSONIndent(r.state())
	for _, want := range []string{`"nextRunAt": "2026-11-14T01:00:00.000Z"`, `"pausedReason": null`, `"run": null`, `"startedAt": "2026-11-07T01:00:00.000Z"`, `"limitUsd": 5`, `"kind": "wiki"`, `"usage": [`} {
		if !strings.Contains(raw, want) {
			t.Errorf("auto.json lacks %s:\n%.900s", want, raw)
		}
	}
	if _, err := time.Parse(time.RFC3339, r.state().Runs[0].StartedAt); err != nil {
		t.Error(err)
	}
	if errors.Is(nil, nil) && len(r.state().Runs[0].Warnings) != 0 {
		t.Error("warnings start empty")
	}
}
