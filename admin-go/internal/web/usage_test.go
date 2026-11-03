// SPDX-License-Identifier: Apache-2.0

package web

import (
	"os"
	"testing"

	"github.com/lsegroup/mnemosyne/admin-go/internal/auto"
)

func (r *autoRig) usageJSON(t *testing.T, query string) map[string]any {
	t.Helper()
	got := r.api(r.cookie, "GET", "/usage"+query, "")
	eq(t, got.status, 200, "usage")
	return got.json(t)
}

// Owner order 2026-11-01: every AI job is logged in one cost center - who started it, for which project, what each model used, what it cost.
func TestEveryAutomaticJobIsInTheCostCenterWithWhoWhatAndCost(t *testing.T) {
	r := newAutoRig(t, "muse-spark-1.3-contributor", planWithDetail)
	r.useImageModel(t, "muse-image-1.0")
	r.runDueNow(t, `["alpha","beta"]`)

	u := r.usageJSON(t, "")
	eq(t, u["total"], any(float64(4)), "an article and a diagram for each of two projects")
	rows := u["rows"].([]any)
	var diagram map[string]any
	for _, x := range rows {
		e := x.(map[string]any)
		eq(t, e["trigger"], any("auto"), "who: the schedule")
		eq(t, e["by"], any("Admin (scheduled)"), "who agreed")
		eq(t, e["status"], any("done"), "status")
		if e["kind"] == "diagram" && e["project"] == "alpha" {
			diagram = e
		}
	}
	if diagram == nil {
		t.Fatal("no diagram job of alpha")
	}
	lines := diagram["lines"].([]any)
	eq(t, len(lines), 2, "the plan call and the pictures")
	plan, pics := lines[0].(map[string]any), lines[1].(map[string]any)
	eq(t, plan["what"], any("IMAGES"), "the text call that plans")
	eq(t, plan["model"], any("muse-spark-1.3-contributor"), "plan model")
	eq(t, plan["in"], any(float64(1200)), "tokens in")
	eq(t, pics["what"], any("PICTURES"), "the image model")
	eq(t, pics["model"], any("muse-image-1.0"), "image model")
	eq(t, pics["calls"], any(float64(2)), "overview and detail picture")
	eq(t, pics["usd"], any(0.02), "two pictures at $0.01")
	eq(t, diagram["usd"], any(0.0208), "plan $0.0008 and two pictures")

	// the month adds up to what the run cost
	months := u["months"].([]any)
	eq(t, len(months), 1, "one month")
	m := months[0].(map[string]any)
	eq(t, m["jobs"], any(float64(4)), "jobs")
	eq(t, m["usd"], any(0.0432), "the same as the run cost")
	eq(t, m["pictures"], any(0.04), "pictures")
	eq(t, m["text"], any(0.0016), "articles")
	eq(t, m["images"], any(0.0016), "plan calls")

	// ten to a page, newest first
	page := r.usageJSON(t, "?offset=3&limit=3")
	eq(t, len(page["rows"].([]any)), 1, "the last job is alone on the second page of three")
	eq(t, page["total"], any(float64(4)), "total")
}

// A job that failed after the text call was billed is in the cost center with what was used.
func TestAFailedJobStillCountsTheTextCallThatWasBilled(t *testing.T) {
	r := newAutoRig(t, "muse-spark-1.3-contributor", planWithDetail)
	r.useImageModel(t, "muse-image-1.0")
	r.images.failFrom = 1
	r.runDueNow(t, `["alpha"]`)

	u := r.usageJSON(t, "")
	var failed map[string]any
	for _, x := range u["rows"].([]any) {
		if e := x.(map[string]any); e["status"] == "failed" {
			failed = e
		}
	}
	if failed == nil {
		t.Fatal("the failed diagram job is not in the cost center")
	}
	eq(t, failed["kind"], any("diagram"), "kind")
	has(t, failed["note"].(string), "could not paint the overview")
	eq(t, failed["usd"], any(0.0008), "the plan call was billed")
	eq(t, len(failed["lines"].([]any)), 1, "no picture was billed")
}

// The runs of before every job was logged are written into the cost center once.
func TestTheEarlierAutomaticRunsAreImportedOnce(t *testing.T) {
	r := newAutoRig(t, "muse-spark-1.3-contributor", planAnswer)
	_ = os.Remove(r.srv.cfg.UsageFile + ".imported")
	_ = os.Remove(r.srv.cfg.UsageFile)
	rc := 1800
	r.srv.auto.store.Update(func(f *auto.File) {
		f.Runs = append(f.Runs, auto.Run{ID: "r1", StartedAt: "2026-10-31T21:40:13.000Z", FinishedAt: "2026-10-31T22:47:32.000Z", Trigger: "Saturday 21:40 schedule", Status: "completed",
			Updated: []string{"a", "b"}, Unchanged: []string{"c"}, InputTokens: 237167, OutputTokens: 604093, USD: 0.1445,
			Usage: &[]auto.Usage{{Model: "muse-spark-1.3-contributor", Kind: "wiki", Calls: 26, InputTokens: 109045, OutputTokens: 240648, ReasoningTokens: &rc, USD: 0.059, MS: 1534000}, {Model: "muse-spark-1.3-contributor", Kind: "diagram", Calls: 26, InputTokens: 128122, OutputTokens: 363445, USD: 0.0855, MS: 2500000}}})
	})
	r.srv.importUsageHistory()
	r.srv.importUsageHistory() // a second start does not write it again

	u := r.usageJSON(t, "")
	eq(t, u["total"], any(float64(1)), "one entry for the run")
	e := u["rows"].([]any)[0].(map[string]any)
	eq(t, e["kind"], any("auto-run"), "kind")
	eq(t, e["by"], any("Saturday 21:40 schedule"), "trigger")
	eq(t, e["usd"], any(0.1445), "cost")
	eq(t, len(e["lines"].([]any)), 2, "TEXT and IMAGES")
	eq(t, u["months"].([]any)[0].(map[string]any)["month"], any("2026-10"), "month")
}

// The tab is there, Auto has no run log any more, and both point to each other.
func TestTheUsageTabReplacesTheRunLogOfTheAutoTab(t *testing.T) {
	h := newHarness(t, withLocal(nil))
	cookie, _ := h.localCookie("Admin", "correct horse")
	page := h.do(call{path: "/admin/", cookie: cookie}).body
	// the menu, in this order (owner 2026-11-01)
	has(t, page, `<a href="#llm" data-tab="llm" class="active">LLM</a><a href="#usage" data-tab="usage">LLM usage</a><a href="#auto" data-tab="auto">LLM auto</a><a href="#sso" data-tab="sso">SSO</a><a href="#audit" data-tab="audit">Audit</a><a href="#license" data-tab="license">License</a>`)
	has(t, page, `<section id="tab-usage"`)
	has(t, page, "Cost per month")
	has(t, page, `id="usageRows"`)
	has(t, page, "usagePage=0,USAGE_PER=10")
	lacks(t, page, `id="autoRuns"`)
	lacks(t, page, `id="autoTotals"`)
	has(t, page, `id="autoLast"`)
	has(t, page, `<a href="#usage">LLM usage</a>`)
	lacks(t, page, "autoRuns(AUTO.runs)")
}
