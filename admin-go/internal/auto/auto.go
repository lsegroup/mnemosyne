// Package auto is the scheduled documentation update (Admin -> Auto). *** IT CAN SPEND MONEY, BUT ONLY WHAT AN ADMINISTRATOR AGREED TO ***
//
// It makes no model call itself: it decides WHEN a run starts and WHICH projects need work, and asks the injected generator to run ONE AI
// job at a time. What keeps the spending bounded:
//   - nothing runs without an agreement: the administrator agreed in a popup to the exact setup (projects, what is created, schedule,
//     model, token limits, dollar limit); the agreement is a fingerprint of that setup, and when anything it covers changes the schedule
//     PAUSES instead of running;
//   - every run has a dollar limit: before each call the worst case of that call is added to what the run has already cost, and when the
//     sum would pass the limit the run stops and lists the projects it did not reach;
//   - only projects whose notes changed since their last article are touched;
//   - one AI job at a time, the switch in the Admin stops everything, and a run that was missed by more than 12 hours is skipped;
//   - when the provider cannot be reached at all the run waits a minute and sends the same call again, for at most 15 minutes, then stops.
//
// Port of auto.ts: the files it reads and writes (auto.json), the agreement fingerprints and the texts are the Node server's.
package auto

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"gitlab.globalclouddata.org/gcd-group/mnemosyne-admin/internal/engine"
	"gitlab.globalclouddata.org/gcd-group/mnemosyne-admin/internal/jobs"
)

// Limits of the runner.
const (
	RunHistory   = 30
	MaxLate      = 12 * time.Hour
	MaxAttempts  = 2
	OutageWait   = time.Minute
	OutageMax    = 15 * time.Minute
	tickInterval = 30 * time.Second
)

// Kind is what one AI call writes.
type Kind = engine.Kind

// Schedule is when a run starts.
type Schedule struct {
	Mode string `json:"mode"` // weekly or once
	// Days are the weekdays of a weekly schedule: 0 = Sunday ... 6 = Saturday.
	Days []int `json:"days"`
	// Date is YYYY-MM-DD in TZ (once).
	Date string `json:"date,omitempty"`
	// Time is HH:MM in TZ.
	Time string `json:"time"`
	TZ   string `json:"tz"`
}

// Agreement is who agreed, when, and to which setup (a fingerprint).
type Agreement struct {
	By  string `json:"by"`
	At  string `json:"at"`
	Key string `json:"key"`
}

// Config is the saved setup.
type Config struct {
	// Enabled is the switch. Off: nothing runs and nothing is spent.
	Enabled  bool     `json:"enabled"`
	Schedule Schedule `json:"schedule"`
	// Projects are the notes projects that are kept up to date.
	Projects []string `json:"projects"`
	// Known is every project that existed when this was saved: a project not in here is "new" and not included.
	Known []string `json:"known"`
	// Text is the documentation article; Charts the architecture diagrams.
	Text   bool `json:"text"`
	Charts bool `json:"charts"`
	// LimitUSD stops a run when the next call could take it over this many US dollars.
	LimitUSD  float64    `json:"limitUsd"`
	Agreement *Agreement `json:"agreement,omitempty"`
}

// Usage is what one kind of AI call of one model used in one run. "wiki" is TEXT, "diagram" is IMAGES (the AI flow charts).
type Usage struct {
	Model           string  `json:"model"`
	Kind            Kind    `json:"kind"`
	Calls           int     `json:"calls"`
	InputTokens     int     `json:"inputTokens"`
	OutputTokens    int     `json:"outputTokens"`
	ReasoningTokens *int    `json:"reasoningTokens,omitempty"`
	USD             float64 `json:"usd"`
	// MS is how long the calls took; waiting for the provider to come back is not in it.
	MS int64 `json:"ms"`
}

// Failure is a project that could not be updated.
type Failure struct {
	Project string `json:"project"`
	Error   string `json:"error"`
}

// QueueItem is a project still to do (the first is the current one).
type QueueItem struct {
	Project    string `json:"project"`
	Text       bool   `json:"text"`
	Charts     bool   `json:"charts"`
	Attempts   int    `json:"attempts"`
	WikiDone   bool   `json:"wikiDone,omitempty"`
	ChartsDone bool   `json:"chartsDone,omitempty"`
}

// Current is the call that is running.
type Current struct {
	Project string `json:"project"`
	Kind    Kind   `json:"kind"`
	Since   string `json:"since"`
	// Waiting is set while waiting for the provider to come back.
	Waiting string `json:"waiting,omitempty"`
}

// Run is one automatic run.
type Run struct {
	ID           string      `json:"id"`
	StartedAt    string      `json:"startedAt"`
	FinishedAt   string      `json:"finishedAt,omitempty"`
	ScheduledFor string      `json:"scheduledFor"`
	Trigger      string      `json:"trigger"`
	Status       string      `json:"status"` // running, completed, nothing, limit, missed, stopped
	Updated      []string    `json:"updated"`
	Unchanged    []string    `json:"unchanged"`
	Failed       []Failure   `json:"failed"`
	NotReached   []string    `json:"notReached"`
	Queue        []QueueItem `json:"queue"`
	Total        int         `json:"total"`
	Current      *Current    `json:"current,omitempty"`
	InputTokens  int         `json:"inputTokens"`
	OutputTokens int         `json:"outputTokens"`
	USD          float64     `json:"usd"`
	// Usage is the same tokens and cost split by model and kind; nil for a run made before this was recorded.
	Usage    *[]Usage `json:"usage,omitempty"`
	Note     string   `json:"note,omitempty"`
	Warnings []string `json:"warnings"`
}

// File is auto.json: the setup, the next run, the running run and the history.
type File struct {
	Config *Config `json:"config,omitempty"`
	// NextRunAt is the ISO instant of the next run (null = nothing planned).
	NextRunAt *string `json:"nextRunAt"`
	// PausedReason is why the schedule is not running although it is switched on.
	PausedReason *string `json:"pausedReason"`
	Run          *Run    `json:"run"`
	Runs         []Run   `json:"runs"`
}

func (f *File) normalise() {
	if f.Runs == nil {
		f.Runs = []Run{}
	}
	for i := range f.Runs {
		f.Runs[i].normalise()
	}
	if f.Run != nil {
		f.Run.normalise()
	}
	if f.Config != nil {
		if f.Config.Projects == nil {
			f.Config.Projects = []string{}
		}
		if f.Config.Known == nil {
			f.Config.Known = []string{}
		}
		if f.Config.Schedule.Days == nil {
			f.Config.Schedule.Days = []int{}
		}
	}
}

func (r *Run) normalise() {
	if r.Updated == nil {
		r.Updated = []string{}
	}
	if r.Unchanged == nil {
		r.Unchanged = []string{}
	}
	if r.Failed == nil {
		r.Failed = []Failure{}
	}
	if r.NotReached == nil {
		r.NotReached = []string{}
	}
	if r.Queue == nil {
		r.Queue = []QueueItem{}
	}
	if r.Warnings == nil {
		r.Warnings = []string{}
	}
}

// ValidationError is a plain message for the person who filled in the form.
type ValidationError = jobs.ValidationError

func invalid(msg string) error { return &jobs.ValidationError{Msg: msg} }

// Store is auto.json: one JSON file next to the other portal state (no secrets in it).
type Store struct {
	path string
	mu   sync.Mutex
}

// NewStore opens (lazily) the file.
func NewStore(path string) *Store { return &Store{path: path} }

func (s *Store) get() (File, error) {
	raw, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return File{Runs: []Run{}}, nil
	}
	if err != nil {
		return File{}, err
	}
	var f File
	if err := json.Unmarshal(raw, &f); err != nil {
		return File{}, err
	}
	f.normalise()
	return f, nil
}

// Get returns the saved state.
func (s *Store) Get() (File, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.get()
}

// Update is a serialised read-modify-write, written atomically.
func (s *Store) Update(fn func(*File)) (File, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	f, err := s.get()
	if err != nil {
		return f, err
	}
	fn(&f)
	f.normalise()
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return f, err
	}
	tmp := s.path + ".go.tmp"
	if err := os.WriteFile(tmp, []byte(engine.JSONIndent(f)), 0o600); err != nil {
		return f, err
	}
	return f, os.Rename(tmp, s.path)
}

// stamp is the compact UTC timestamp, like the document store's version ids.
func stamp(t time.Time) string { return engine.Stamp(t) }

func iso(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

func ptr[T any](v T) *T { return &v }

func joinAnd(items []string) string {
	if len(items) < 2 {
		return strings.Join(items, "")
	}
	return strings.Join(items[:len(items)-1], ", ") + " and " + items[len(items)-1]
}
