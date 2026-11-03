package auto

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/lsegroup/mnemosyne/admin-go/internal/engine"
	"github.com/lsegroup/mnemosyne/admin-go/internal/golden"
	"github.com/lsegroup/mnemosyne/admin-go/internal/jobs"
)

// nodeAuto is what the old Node implementation of the scheduler answered for these cases. The Node repository no longer has that code:
// the answers were recorded once from its last build (see package golden) and are kept in testdata/golden.
func nodeAuto(t *testing.T, cases any) map[string]json.RawMessage {
	t.Helper()
	raw, _ := json.Marshal(cases)
	sum := sha256.Sum256(raw)
	out := golden.Bytes(t, "auto-"+hex.EncodeToString(sum[:6])+".json", func() []byte { return runNodeAuto(t, raw) })
	var res map[string]json.RawMessage
	if err := json.Unmarshal(out, &res); err != nil {
		t.Fatal(err)
	}
	return res
}

// runNodeAuto asks a Node build that still has the scheduler (record mode only).
func runNodeAuto(t *testing.T, raw []byte) []byte {
	t.Helper()
	root, _ := filepath.Abs(filepath.Join("..", ".."))
	dist := os.Getenv("MNEMOSYNE_NODE_DIST")
	if dist == "" {
		dist = filepath.Join(root, "..", "packages", "server", "dist")
	}
	if _, err := os.Stat(filepath.Join(dist, "auto.js")); err != nil {
		t.Skip("the Node build is not at hand (set MNEMOSYNE_NODE_DIST)")
	}
	bin, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	file := filepath.Join(t.TempDir(), "cases.json")
	if err := os.WriteFile(file, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(bin, filepath.Join(root, "testdata", "gen", "engine.mjs"), "auto", file)
	cmd.Env = append(os.Environ(), "MNEMOSYNE_NODE_DIST="+dist)
	out, err := cmd.Output()
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			t.Fatalf("node: %v\n%s", err, ee.Stderr)
		}
		t.Fatal(err)
	}
	return out
}

func same(t *testing.T, what string, got any, wantRaw json.RawMessage) {
	t.Helper()
	gotRaw, _ := json.Marshal(got)
	var g, w any
	_ = json.Unmarshal(gotRaw, &g)
	_ = json.Unmarshal(wantRaw, &w)
	if !reflect.DeepEqual(g, w) {
		t.Errorf("%s differs:\n Go:   %s\n Node: %s", what, gotRaw, wantRaw)
	}
}

type modelCase struct {
	ProviderID string        `json:"providerId"`
	Model      string        `json:"model"`
	Text       jobs.Settings `json:"text"`
	Image      jobs.Settings `json:"image"`
}

func weekly(tz, hhmm string, days ...int) Schedule {
	return Schedule{Mode: "weekly", Days: days, Time: hhmm, TZ: tz}
}

func TestTheScheduleTheAgreementAndTheCostArithmeticAreTheNodeServers(t *testing.T) {
	type nextCase struct {
		Schedule Schedule `json:"schedule"`
		After    string   `json:"after"`
	}
	nexts := []nextCase{
		{weekly("UTC", "02:00", 1, 2, 3, 4, 5), "2026-11-01T01:00:00.000Z"},
		{weekly("UTC", "02:00", 1, 2, 3, 4, 5), "2026-11-02T02:00:00.000Z"}, // exactly at a run: the next one is strictly later
		{weekly("UTC", "23:30", 0, 6), "2026-11-06T23:31:00.000Z"},
		{weekly("Europe/Zurich", "02:30", 0), "2026-03-28T00:00:00.000Z"}, // 02:30 does not exist on the day the clocks go forward
		{weekly("Europe/Zurich", "02:30", 0), "2026-10-24T00:00:00.000Z"}, // and exists twice when they go back
		{weekly("Europe/Zurich", "03:00", 0, 1), "2026-03-29T00:00:00.000Z"},
		{weekly("America/New_York", "01:30", 0), "2026-03-07T00:00:00.000Z"},
		{weekly("America/New_York", "01:30", 0), "2026-10-31T00:00:00.000Z"},
		{weekly("Asia/Kolkata", "09:15", 3), "2026-11-01T00:00:00.000Z"},
		{weekly("Pacific/Auckland", "00:30", 1, 4), "2026-09-26T00:00:00.000Z"},
		{weekly("Australia/Lord_Howe", "02:15", 6), "2026-10-03T00:00:00.000Z"},
		{weekly("Asia/Singapore", "04:00", 0, 1, 2, 3, 4, 5, 6), "2026-12-31T23:00:00.000Z"},
		{Schedule{Mode: "once", Days: []int{}, Date: "2026-11-07", Time: "01:00", TZ: "UTC"}, "2026-11-01T00:00:00.000Z"},
		{Schedule{Mode: "once", Days: []int{}, Date: "2026-11-07", Time: "01:00", TZ: "UTC"}, "2026-11-07T01:00:00.000Z"},
		{Schedule{Mode: "once", Days: []int{}, Date: "2026-03-29", Time: "02:30", TZ: "Europe/Zurich"}, "2026-03-01T00:00:00.000Z"},
	}
	base := Config{Schedule: weekly("UTC", "02:00", 1, 3, 5), Projects: []string{"b", "a"}, Text: true, Charts: false, LimitUSD: 5}
	once := Config{Schedule: Schedule{Mode: "once", Days: []int{}, Date: "2026-12-01", Time: "03:00", TZ: "Europe/Zurich"}, Projects: []string{"x"}, Text: true, Charts: true, LimitUSD: 2.5}
	type keyCase struct {
		Cfg      Config `json:"cfg"`
		ModelKey string `json:"modelKey"`
	}
	keys := []keyCase{{base, "model-1"}, {base, "model-2"}, {once, "model-1"}, {Config{Schedule: weekly("Asia/Tokyo", "00:00", 0), Projects: []string{"ä", "z"}, Charts: true, LimitUSD: 0.01}, "ünïcode <&> key"}}

	type parseCase struct {
		Input any      `json:"input"`
		Known []string `json:"known"`
		Now   string   `json:"now"`
	}
	known := []string{"alpha", "beta", "gamma"}
	now := "2026-11-01T00:00:00.000Z"
	sched := func(m map[string]any) map[string]any {
		s := map[string]any{"mode": "weekly", "days": []any{1, 2}, "time": "02:00", "tz": "UTC"}
		for k, v := range m {
			s[k] = v
		}
		return s
	}
	input := func(m map[string]any) map[string]any {
		in := map[string]any{"schedule": sched(nil), "projects": []any{"beta", "alpha", "alpha", "nope"}, "text": true, "charts": false, "limitUsd": 5}
		for k, v := range m {
			in[k] = v
		}
		return in
	}
	parses := []parseCase{
		{input(nil), known, now},
		{input(map[string]any{"schedule": sched(map[string]any{"time": "7:00"})}), known, now},
		{input(map[string]any{"schedule": sched(map[string]any{"time": "24:00"})}), known, now},
		{input(map[string]any{"schedule": sched(map[string]any{"tz": "Mars/Olympus"})}), known, now},
		{input(map[string]any{"schedule": sched(map[string]any{"days": []any{}})}), known, now},
		{input(map[string]any{"schedule": sched(map[string]any{"days": []any{"6", 0, 0, 7, -1, 1.5, "x", nil, true}})}), known, now},
		{input(map[string]any{"schedule": sched(map[string]any{"mode": "once", "date": "2026-11-07"})}), known, now},
		{input(map[string]any{"schedule": sched(map[string]any{"mode": "once", "date": "2026-10-01"})}), known, now},
		{input(map[string]any{"schedule": sched(map[string]any{"mode": "once", "date": "2026-02-30"})}), known, now},
		{input(map[string]any{"schedule": sched(map[string]any{"mode": "once", "date": "soon"})}), known, now},
		{input(map[string]any{"projects": []any{"nope"}}), known, now},
		{input(map[string]any{"text": false, "charts": false}), known, now},
		{input(map[string]any{"text": false, "charts": true, "limitUsd": "3,456"}), known, now},
		{input(map[string]any{"limitUsd": 0}), known, now},
		{input(map[string]any{"limitUsd": 100001}), known, now},
		{input(map[string]any{"limitUsd": "abc"}), known, now},
		{input(map[string]any{"limitUsd": nil}), known, now},
		{input(map[string]any{"limitUsd": 1.005}), known, now},
		{nil, known, now},
		{"text", known, now},
	}

	str := func(s string) *string { return &s }
	notes := []map[string]any{
		{"id": "n1", "title": "One", "type": "howto", "status": "working", "observed_at": "2026-10-01", "components": []string{"b", "a"}, "body": "Body one"},
		{"id": "n2", "title": "Two", "type": "gotcha", "status": "broken", "observed_at": nil, "components": []string{}, "body": "Body two"},
	}
	goNotes := []engine.Note{
		{ID: "n1", Title: "One", Type: "howto", Status: "working", ObservedAt: str("2026-10-01"), Components: []string{"b", "a"}, Body: "Body one"},
		{ID: "n2", Title: "Two", Type: "gotcha", Status: "broken", Components: []string{}, Body: "Body two"},
	}
	hashes := engine.NoteHashes(goNotes)
	wiki := func(extra map[string]any) map[string]any {
		w := map[string]any{"kind": "wiki", "id": "20261020T100000Z", "generatedAt": "2026-10-20T10:00:00.000Z", "project": "p", "model": "m", "by": "x", "ext": "md"}
		for k, v := range extra {
			w[k] = v
		}
		return w
	}
	diagram := func(basedOn string) map[string]any {
		return map[string]any{"kind": "diagram", "id": "20261020T110000Z", "generatedAt": "2026-10-20T11:00:00.000Z", "project": "p", "model": "m", "by": "x", "basedOn": basedOn, "ext": "svg"}
	}
	type inspectCase struct {
		Project string           `json:"project"`
		Notes   []map[string]any `json:"notes"`
		Wiki    any              `json:"wiki"`
		Diagram any              `json:"diagram"`
	}
	inspects := []inspectCase{
		{"p", notes, nil, nil},
		{"p", notes, wiki(map[string]any{"noteHashes": hashes}), diagram("20261020T100000Z")},
		{"p", notes, wiki(map[string]any{"noteHashes": hashes}), diagram("older")},
		{"p", notes, wiki(map[string]any{"noteHashes": hashes}), nil},
		{"p", notes, wiki(map[string]any{"noteHashes": map[string]string{"n1": hashes["n1"], "n2": "0000"}}), nil},
		{"p", notes, wiki(map[string]any{"noteHashes": map[string]string{"n1": hashes["n1"], "n2": hashes["n2"], "gone": "1"}}), nil},
		{"p", notes, wiki(map[string]any{"noteCount": 2}), nil},
		{"p", notes, wiki(map[string]any{"noteCount": 5}), nil},
		{"p", notes, wiki(map[string]any{"generatedAt": "2026-09-01T10:00:00.000Z"}), nil},
	}
	goInspect := func(c inspectCase) ProjectState {
		var w, d *engine.DocMeta
		if c.Wiki != nil {
			raw, _ := json.Marshal(c.Wiki)
			w = &engine.DocMeta{}
			_ = json.Unmarshal(raw, w)
		}
		if c.Diagram != nil {
			raw, _ := json.Marshal(c.Diagram)
			d = &engine.DocMeta{}
			_ = json.Unmarshal(raw, d)
		}
		return Inspect(c.Project, goNotes, w, d)
	}

	f := func(v float64) *float64 { return &v }
	type summaryCase struct {
		Cfg   Config `json:"cfg"`
		Rows  []any  `json:"rows"`
		Label string `json:"label"`
	}
	state := func(textDue, chartsDue, hasArticle bool) ProjectState {
		return ProjectState{Project: "p", Notes: 3, HasArticle: hasArticle, TextDue: textDue, ChartsDue: chartsDue, Detail: "x"}
	}
	row := func(s ProjectState, e Estimate) map[string]any {
		return map[string]any{"state": s, "est": map[string]any{"textTypical": e.TextTypical, "textWorst": e.TextWorst, "chartsTypical": e.ChartsTypical, "chartsWorst": e.ChartsWorst}}
	}
	est := Estimate{f(0.0123), f(0.1111), f(0.0044), f(0.125)}
	noPrice := Estimate{}
	both := Config{Schedule: weekly("UTC", "02:00", 6, 0), Projects: []string{"a", "b", "c"}, Text: true, Charts: true, LimitUSD: 1.5}
	summaries := []summaryCase{
		{both, []any{row(state(true, true, false), est), row(state(false, false, true), est), row(state(false, true, true), est)}, "Meta Model API / muse-spark-1.3"},
		{both, []any{row(state(true, true, false), est), row(state(false, false, true), noPrice)}, "unpriced"},
		{base, []any{row(state(true, true, true), Estimate{f(0.001), f(0.005), f(0.2), f(0.3)})}, "text only"},
		{once, []any{row(state(false, false, true), est)}, "once"},
		{Config{Schedule: weekly("UTC", "01:00", 1, 2, 3, 4, 5, 6, 0), Projects: []string{"a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n"}, Text: true, LimitUSD: 100}, []any{}, "many"},
	}
	durations := []int64{0, 400, 999, 1000, 42_000, 59_499, 60_000, 4_039_000, 3_599_000, 3_600_000, 8_220_000, -5}

	four, eight, temp, topP := 4242, 9, 0.3, 0.9
	modelCases := []modelCase{
		{"p1", "muse-spark-1.3-contributor", jobs.Settings{}, jobs.Settings{}},
		{"p1", "muse-spark-1.3", jobs.Settings{MaxTokens: &four, Temperature: &temp, ReasoningEffort: "low"}, jobs.Settings{TopP: &topP, TimeoutMinutes: &eight}},
		{"p2", "gpt-x", jobs.Settings{UserPrompt: "Write {{notes}} <now> & “well” \u2028 done"}, jobs.Settings{SystemPrompt: "Plan only."}},
	}

	res := nodeAuto(t, map[string]any{"next": nexts, "keys": keys, "parse": parses, "inspect": inspects, "summary": summaries, "durations": durations, "modelKeys": modelCases})

	var wantNext []*string
	_ = json.Unmarshal(res["next"], &wantNext)
	for i, c := range nexts {
		after, _ := time.Parse(time.RFC3339, c.After)
		got, ok := NextRun(c.Schedule, after)
		switch {
		case wantNext[i] == nil && ok:
			t.Errorf("next %d (%s %v): Go %s, Node none", i, c.Schedule.TZ, c.Schedule.Days, got.Format(time.RFC3339))
		case wantNext[i] != nil && !ok:
			t.Errorf("next %d (%s %v): Go none, Node %s", i, c.Schedule.TZ, c.Schedule.Days, *wantNext[i])
		case ok && iso(got) != *wantNext[i]:
			t.Errorf("next %d (%s %s on %v after %s): Go %s, Node %s", i, c.Schedule.TZ, c.Schedule.Time, c.Schedule.Days, c.After, iso(got), *wantNext[i])
		}
	}
	var wantDescribe []string
	var wantRuns []int
	_ = json.Unmarshal(res["describe"], &wantDescribe)
	_ = json.Unmarshal(res["runsPerMonth"], &wantRuns)
	for i, c := range nexts {
		if got := DescribeSchedule(c.Schedule); got != wantDescribe[i] {
			t.Errorf("describe %d: %q, Node %q", i, got, wantDescribe[i])
		}
		if got := RunsPerMonth(c.Schedule); got != wantRuns[i] {
			t.Errorf("runsPerMonth %d: %d, Node %d", i, got, wantRuns[i])
		}
	}
	var wantKeys []string
	_ = json.Unmarshal(res["keys"], &wantKeys)
	for i, c := range keys {
		if got := AgreementKey(c.Cfg, c.ModelKey); got != wantKeys[i] {
			t.Errorf("agreement key %d: %s, Node %s (an agreement saved by Node would no longer match)", i, got, wantKeys[i])
		}
	}

	var wantParsed []map[string]json.RawMessage
	_ = json.Unmarshal(res["parsed"], &wantParsed)
	for i, c := range parses {
		nowT, _ := time.Parse(time.RFC3339, c.Now)
		var decoded any // what the page sends: JSON, so numbers are float64
		raw, _ := json.Marshal(c.Input)
		_ = json.Unmarshal(raw, &decoded)
		got, err := ParseInput(decoded, c.Known, nowT)
		if msg, isErr := wantParsed[i]["error"]; isErr {
			var want string
			_ = json.Unmarshal(msg, &want)
			if err == nil || err.Error() != want {
				t.Errorf("parse %d: Go %v, Node error %q", i, err, want)
			}
			continue
		}
		if err != nil {
			t.Errorf("parse %d: Go refuses (%v), Node accepts", i, err)
			continue
		}
		same(t, "parse "+string(rune('0'+i%10)), map[string]any{"schedule": got.Schedule, "projects": got.Projects, "known": got.Known, "text": got.Text, "charts": got.Charts, "limitUsd": got.LimitUSD}, wantParsed[i]["ok"])
	}

	var wantInspect []json.RawMessage
	_ = json.Unmarshal(res["inspect"], &wantInspect)
	for i, c := range inspects {
		same(t, "inspect "+string(rune('0'+i)), goInspect(c), wantInspect[i])
	}

	var wantSummary []json.RawMessage
	_ = json.Unmarshal(res["summary"], &wantSummary)
	for i, c := range summaries {
		var rows []Row
		for _, r := range c.Rows {
			m := r.(map[string]any)
			e := m["est"].(map[string]any)
			get := func(k string) *float64 { v, _ := e[k].(*float64); return v }
			rows = append(rows, Row{State: m["state"].(ProjectState), Est: Estimate{get("textTypical"), get("textWorst"), get("chartsTypical"), get("chartsWorst")}})
		}
		same(t, "summary "+string(rune('0'+i)), Summarize(c.Cfg, rows, c.Label), wantSummary[i])
	}

	var wantModelKeys []string
	_ = json.Unmarshal(res["modelKeys"], &wantModelKeys)
	for i, c := range modelCases {
		if got := ModelKey(c.ProviderID, c.Model, jobs.Effect(jobs.Text, c.Text), jobs.Effect(jobs.Image, c.Image)); got != wantModelKeys[i] {
			t.Errorf("model key %d: %s, Node %s (an agreement saved by Node would no longer match)", i, got, wantModelKeys[i])
		}
	}

	var wantDur []string
	_ = json.Unmarshal(res["duration"], &wantDur)
	for i, ms := range durations {
		if got := FormatDuration(ms); got != wantDur[i] {
			t.Errorf("duration %d ms: %q, Node %q", ms, got, wantDur[i])
		}
	}
}
