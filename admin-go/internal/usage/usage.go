// Package usage is the central cost center of the AI calls: one JSON line for every AI job that ran (who started it, for which project, what
// each model used, what it cost). The Node server writes the jobs people start with a button, this program writes the automatic ones; both
// append to the same file (one line per write), and the admin page "LLM usage" reads it.
//
// The cost is counted from the tokens the provider reports (and one price per picture) at the list price of the model: the providers answer
// with token counts, not with an amount of money, so what the provider really charges is on its own billing page.
package usage

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"sync"
	"time"
)

// Line is what one model used for one part of a job.
type Line struct {
	// What is TEXT (an article), IMAGES (the text call that plans the diagram) or PICTURES (the image model painting it).
	What      string  `json:"what"`
	Model     string  `json:"model"`
	Calls     int     `json:"calls"`
	In        int     `json:"in"`
	Out       int     `json:"out"`
	Reasoning *int    `json:"reasoning,omitempty"`
	USD       float64 `json:"usd"`
	MS        int64   `json:"ms"`
}

// Entry is one AI job.
type Entry struct {
	ID   string `json:"id"`
	Time string `json:"time"`
	End  string `json:"end"`
	MS   int64  `json:"ms"`
	// Trigger is "auto" (the scheduler) or "person" (a button on a project page).
	Trigger string `json:"trigger"`
	// By is who started it: the GitLab user of the button, or who agreed to the automatic run.
	By      string `json:"by"`
	Project string `json:"project"`
	// Kind is "wiki" (the article), "diagram" (the workflow diagram) or "auto-run" (a whole run from before every job was logged).
	Kind   string  `json:"kind"`
	Status string  `json:"status"` // done or failed
	USD    float64 `json:"usd"`
	In     int     `json:"in"`
	Out    int     `json:"out"`
	Lines  []Line  `json:"lines"`
	Note   string  `json:"note,omitempty"`
}

func round6(v float64) float64 { return math.Round(v*1e6) / 1e6 }

// Log reads and appends the file. Safe for concurrent use.
type Log struct {
	file string
	mu   sync.Mutex
}

// New returns a log on file.
func New(file string) *Log { return &Log{file: file} }

func newID() string {
	var b [3]byte
	_, _ = rand.Read(b[:])
	return strconv.FormatInt(time.Now().UnixMilli(), 36) + "-" + hex.EncodeToString(b[:])
}

// Append adds one job. The totals are the sum of the lines. It never fails the caller: a logging problem must not stop an AI job.
func (l *Log) Append(e Entry) {
	if e.ID == "" {
		e.ID = newID()
	}
	e.In, e.Out, e.USD = 0, 0, 0
	for i := range e.Lines {
		e.In += e.Lines[i].In
		e.Out += e.Lines[i].Out
		e.USD += e.Lines[i].USD
		e.Lines[i].USD = round6(e.Lines[i].USD)
	}
	e.USD = round6(e.USD)
	if e.Lines == nil {
		e.Lines = []Line{}
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if enc.Encode(e) != nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if os.MkdirAll(filepath.Dir(l.file), 0o755) != nil {
		return
	}
	f, err := os.OpenFile(l.file, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o640)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.Write(buf.Bytes())
}

// All returns every job, newest first.
func (l *Log) All() []Entry {
	raw, err := os.ReadFile(l.file)
	if err != nil {
		return nil
	}
	var out []Entry
	for _, line := range bytes.Split(raw, []byte("\n")) {
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var e Entry
		if json.Unmarshal(line, &e) == nil && e.Time != "" {
			out = append(out, e)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Time > out[j].Time })
	return out
}

// Month is the cost of one calendar month (UTC).
type Month struct {
	Month    string  `json:"month"`
	Jobs     int     `json:"jobs"`
	Failed   int     `json:"failed"`
	Calls    int     `json:"calls"`
	In       int     `json:"in"`
	Out      int     `json:"out"`
	USD      float64 `json:"usd"`
	Text     float64 `json:"text"`
	Images   float64 `json:"images"`
	Pictures float64 `json:"pictures"`
}

// Months sums the jobs per month, newest first. A job belongs to the month it started in.
func Months(entries []Entry) []Month {
	by := map[string]*Month{}
	for _, e := range entries {
		if len(e.Time) < 7 {
			continue
		}
		m := by[e.Time[:7]]
		if m == nil {
			m = &Month{Month: e.Time[:7]}
			by[e.Time[:7]] = m
		}
		m.Jobs++
		if e.Status == "failed" {
			m.Failed++
		}
		m.In += e.In
		m.Out += e.Out
		m.USD += e.USD
		for _, l := range e.Lines {
			m.Calls += l.Calls
			switch l.What {
			case "TEXT":
				m.Text += l.USD
			case "IMAGES":
				m.Images += l.USD
			case "PICTURES":
				m.Pictures += l.USD
			}
		}
	}
	var out []Month
	for _, m := range by {
		m.USD, m.Text, m.Images, m.Pictures = round6(m.USD), round6(m.Text), round6(m.Images), round6(m.Pictures)
		out = append(out, *m)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Month > out[j].Month })
	return out
}
