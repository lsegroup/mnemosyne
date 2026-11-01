package web

import (
	"fmt"
	"net/http"
	"os"
	"strconv"
	"time"

	"gitlab.globalclouddata.org/gcd-group/mnemosyne-admin/internal/auto"
	"gitlab.globalclouddata.org/gcd-group/mnemosyne-admin/internal/engine"
	"gitlab.globalclouddata.org/gcd-group/mnemosyne-admin/internal/usage"
)

// usageWhat is the label of a kind of call in the cost center.
func usageWhat(k engine.Kind) string {
	switch k {
	case engine.Wiki:
		return "TEXT"
	case engine.Painted:
		return "PICTURES"
	}
	return "IMAGES"
}

// logUsage writes one automatic AI job into the cost center: who agreed to it, which project, what each model used and what it cost. A job
// that failed because the provider could not be reached used nothing (the run sends it again), so it is not written; one that failed after
// the text call was billed is, with what was used.
func (s *Server) logUsage(project string, kind auto.Kind, by string, began, end time.Time, out engine.Outcome, err error, msg string) {
	if s.usage == nil {
		return
	}
	e := usage.Entry{
		Time:    began.UTC().Format("2006-01-02T15:04:05.000Z"),
		End:     end.UTC().Format("2006-01-02T15:04:05.000Z"),
		MS:      end.Sub(began).Milliseconds(),
		Trigger: "auto",
		By:      by,
		Project: project,
		Kind:    string(kind),
		Status:  "done",
		Note:    out.Warning,
	}
	if err != nil {
		e.Status, e.Note = "failed", msg
	}
	var pictureMS int64
	if p := out.Picture; p != nil {
		pictureMS = p.MS
	}
	if out.InputTokens > 0 || out.OutputTokens > 0 {
		l := usage.Line{What: usageWhat(kind), Model: out.Model, Calls: 1, In: out.InputTokens, Out: out.OutputTokens, Reasoning: out.ReasoningTokens, MS: max(0, e.MS-pictureMS)}
		if out.USD != nil {
			l.USD = *out.USD
		}
		e.Lines = append(e.Lines, l)
	}
	if p := out.Picture; p != nil {
		e.Lines = append(e.Lines, usage.Line{What: "PICTURES", Model: p.Model, Calls: p.Count, USD: p.USD, MS: p.MS})
	}
	s.usage.Append(e)
}

// getUsage is the cost center: the cost per month and a page of the jobs, newest first.
func (s *Server) getUsage(_ http.ResponseWriter, r *http.Request, _ string) (any, error) {
	all := s.usage.All()
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
	limit, err := strconv.Atoi(r.URL.Query().Get("limit"))
	if err != nil || limit < 1 || limit > 100 {
		limit = 10
	}
	offset = max(0, min(offset, len(all)))
	end := min(len(all), offset+limit)
	rows := all[offset:end]
	if rows == nil {
		rows = []usage.Entry{}
	}
	months := usage.Months(all)
	if len(months) > 24 {
		months = months[:24]
	}
	if months == nil {
		months = []usage.Month{}
	}
	return map[string]any{"total": len(all), "offset": offset, "limit": limit, "months": months, "rows": rows}, nil
}

// importUsageHistory writes the automatic runs that happened before every job was logged into the cost center, once (a marker file next to
// it says it was done): one line per run, with the split by model that the run recorded.
func (s *Server) importUsageHistory() {
	marker := s.cfg.UsageFile + ".imported"
	if _, err := os.Stat(marker); err == nil || s.usage == nil || s.auto == nil {
		return
	}
	f, err := s.auto.store.Get()
	if err != nil {
		return
	}
	for i := len(f.Runs) - 1; i >= 0; i-- {
		r := f.Runs[i]
		if r.FinishedAt == "" || (r.USD == 0 && r.InputTokens == 0) {
			continue
		}
		e := usage.Entry{ID: "auto-run-" + r.ID, Time: r.StartedAt, End: r.FinishedAt, Trigger: "auto", By: r.Trigger, Kind: "auto-run", Status: "done",
			Project: fmt.Sprintf("%d projects updated, %d unchanged", len(r.Updated), len(r.Unchanged))}
		if a, err1 := time.Parse(time.RFC3339Nano, r.StartedAt); err1 == nil {
			if b, err2 := time.Parse(time.RFC3339Nano, r.FinishedAt); err2 == nil {
				e.MS = b.Sub(a).Milliseconds()
			}
		}
		if len(r.Failed) > 0 {
			e.Note = fmt.Sprintf("%d project(s) failed: %s — %s", len(r.Failed), r.Failed[0].Project, r.Failed[0].Error)
		}
		if r.Usage != nil {
			for _, u := range *r.Usage {
				e.Lines = append(e.Lines, usage.Line{What: usageWhat(u.Kind), Model: u.Model, Calls: u.Calls, In: u.InputTokens, Out: u.OutputTokens, Reasoning: u.ReasoningTokens, USD: u.USD, MS: u.MS})
			}
		} else {
			e.Lines = append(e.Lines, usage.Line{What: "TEXT", Model: "(the split by model was not recorded)", Calls: 1, In: r.InputTokens, Out: r.OutputTokens, USD: r.USD})
		}
		s.usage.Append(e)
	}
	_ = os.WriteFile(marker, []byte("the automatic runs before the cost center existed were written into it\n"), 0o640)
}
