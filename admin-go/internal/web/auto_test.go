package web

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gitlab.globalclouddata.org/gcd-group/mnemosyne-admin/internal/auto"
	"gitlab.globalclouddata.org/gcd-group/mnemosyne-admin/internal/engine"
)

const article = `A product description paragraph.

## Features and how it works

It works.

## Specifications

| a | b |

## Hardware and software requirements

None.

## Disaster recovery

### What is required

Things.

### Installation / rebuild steps

1. Do it.

### Access

By URL.

### Testing and verification

1. Check.

### Known gotchas

None.`

const planAnswer = `{"title":"Alpha","diagrams":[{"name":"Overview","columns":[{"title":"CLIENTS","nodes":[{"id":"u","label":"Browser"}]},{"title":"APP","nodes":[{"id":"a","label":"Server","detail":"Node, :40001"}]}],"links":[{"from":"u","to":"a","label":"HTTPS"}]}]}`

// llmServer answers like an AI provider: an article for the writer, a diagram plan for the architect.
// fakeImages is what the fake provider got asked to paint, and whether it should refuse.
type fakeImages struct {
	bodies []map[string]any
	fail   bool
}

// fakePNG is the picture the fake image model returns.
var fakePNG = []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1}

func llmServer(t *testing.T, planText string) (*httptest.Server, *[]map[string]any, *fakeImages) {
	var seen []map[string]any
	images := &fakeImages{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/models":
			_, _ = w.Write([]byte(`{"data":[{"id":"muse-spark-1.3-contributor"},{"id":"mystery-model"},{"id":"muse-image-1.0"}]}`))
		case "/v1/images/generations":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			images.bodies = append(images.bodies, body)
			if images.fail {
				w.WriteHeader(500)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]any{"b64_json": base64.StdEncoding.EncodeToString(fakePNG)}}})
		case "/v1/chat/completions":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			seen = append(seen, body)
			msgs := body["messages"].([]any)
			system := msgs[0].(map[string]any)["content"].(string)
			content := article
			if strings.Contains(system, "solutions architect") {
				content = planText
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"choices": []any{map[string]any{"message": map[string]any{"content": content}, "finish_reason": "stop"}},
				"usage":   map[string]any{"prompt_tokens": 1200, "completion_tokens": 3400, "completion_tokens_details": map[string]any{"reasoning_tokens": 900}},
			})
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &seen, images
}

func writeNote(t *testing.T, dir, project, id, observed, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, "nodes", project), 0o755); err != nil {
		t.Fatal(err)
	}
	text := "---\nid: " + id + "\ntitle: Note " + id + "\ntype: howto\nstatus: working\nproject: " + project + "\ncomponents: [web]\nobserved_at: " + observed + "\n---\n\n" + body + "\n"
	if err := os.WriteFile(filepath.Join(dir, "nodes", project, id+".md"), []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

// autoRig is a Go admin signed in as the built-in account, with a model chosen for Text and two projects with notes.
type autoRig struct {
	*harness
	cookie string
	llm    *httptest.Server
	seen   *[]map[string]any
	images *fakeImages
	// provider is the id of the fake provider
	provider string
}

func newAutoRig(t *testing.T, model string, plan string) *autoRig {
	h := newHarness(t, withLocal(nil))
	llm, seen, images := llmServer(t, plan)
	cookie, _ := h.localCookie("Admin", "correct horse")
	writeNote(t, h.dir, "alpha", "alpha-one", "2026-10-20", "Alpha runs on :3000. password: hunter2hunter2")
	writeNote(t, h.dir, "alpha", "alpha-two", "2026-10-21", "More about alpha.")
	writeNote(t, h.dir, "beta", "beta-one", "2026-10-22", "Beta.")
	r := &autoRig{harness: h, cookie: cookie, llm: llm, seen: seen, images: images}
	id := h.api(cookie, "POST", "/providers", `{"label":"Fake AI","kind":"openai-compatible","baseUrl":"`+llm.URL+`/v1","apiKey":"sk-test-key-1234567890"}`).json(t)["id"].(string)
	r.provider = id
	h.api(cookie, "POST", "/providers/"+id+"/models", "")
	if model != "" {
		if got := h.api(cookie, "PUT", "/llm/jobs/text", `{"model":{"providerId":"`+id+`","model":"`+model+`"}}`); got.status != 200 {
			t.Fatalf("model: %s", got.body)
		}
	}
	return r
}

func (r *autoRig) setup(t *testing.T, projects string) (token string, body string) {
	cfg := `{"config":{"schedule":{"mode":"weekly","days":[1,2,3,4,5],"time":"02:00","tz":"UTC"},"projects":` + projects + `,"text":true,"charts":true,"limitUsd":1}}`
	est := r.api(r.cookie, "POST", "/auto/estimate", cfg)
	if est.status != 200 {
		t.Fatalf("estimate: %d %s", est.status, est.body)
	}
	tok := est.json(t)["token"].(string)
	return tok, strings.TrimSuffix(cfg, "}") + `,"token":"` + tok + `"}`
}

func TestTheAutoTabNeedsAModelAndRefusesAModelWithoutAPrice(t *testing.T) {
	r := newAutoRig(t, "", planAnswer)
	got := r.api(r.cookie, "GET", "/auto", "").json(t)
	eq(t, got["model"], nil, "no model yet")
	eq(t, got["enabled"], any(false), "off")
	eq(t, got["agreementOk"], any(false), "no agreement")
	eq(t, len(got["projects"].([]any)), 2, "both projects with notes are listed")
	est := r.api(r.cookie, "POST", "/auto/estimate", `{"config":{"schedule":{"mode":"weekly","days":[1],"time":"02:00","tz":"UTC"},"projects":["alpha"],"text":true,"limitUsd":1}}`)
	eq(t, est.json(t)["error"], any("Choose a model for Text in Admin → LLM first."), "no model")

	r = newAutoRig(t, "mystery-model", planAnswer)
	est = r.api(r.cookie, "POST", "/auto/estimate", `{"config":{"schedule":{"mode":"weekly","days":[1],"time":"02:00","tz":"UTC"},"projects":["alpha"],"text":true,"limitUsd":1}}`)
	eq(t, est.json(t)["error"], any("No list price is known for mystery-model, so a dollar limit cannot be enforced. Choose a priced model for Text in LLM."), "no price")
}

func TestAnAgreementIsOneTimeAndBoundToExactlyThisSetup(t *testing.T) {
	r := newAutoRig(t, "muse-spark-1.3-contributor", planAnswer)

	got := r.api(r.cookie, "GET", "/auto", "").json(t)
	model := got["model"].(map[string]any)
	eq(t, model["label"], any("Fake AI / muse-spark-1.3-contributor"), "model label")
	eq(t, model["priced"], any(true), "priced")
	alpha := got["projects"].([]any)[0].(map[string]any)
	eq(t, alpha["project"], any("alpha"), "alpha first")
	eq(t, alpha["notes"], any(float64(2)), "two notes")
	eq(t, alpha["textDue"], any(true), "no article yet")
	eq(t, alpha["detail"], any("no article yet"), "detail")
	eq(t, alpha["glPath"], nil, "no GitLab project known")
	if est := alpha["est"].(map[string]any); est["textTypical"] == nil || est["textWorst"].(float64) <= est["textTypical"].(float64) {
		t.Errorf("estimates: %v", est)
	}

	// refusals before any agreement
	for body, want := range map[string]string{
		`{"config":{"schedule":{"mode":"weekly","days":[1],"time":"2:00","tz":"UTC"},"projects":["alpha"],"text":true,"limitUsd":1}}`:  "The start time must be on the 24-hour clock and look like 02:00 or 23:30.",
		`{"config":{"schedule":{"mode":"weekly","days":[1],"time":"02:00","tz":"UTC"},"projects":["nope"],"text":true,"limitUsd":1}}`:  "Tick at least one project.",
		`{"config":{"schedule":{"mode":"weekly","days":[1],"time":"02:00","tz":"UTC"},"projects":["alpha"],"limitUsd":1}}`:             "Tick TEXT, AI flow charts, or both.",
		`{"config":{"schedule":{"mode":"weekly","days":[1],"time":"02:00","tz":"UTC"},"projects":["alpha"],"text":true,"limitUsd":0}}`: "The spending limit must be a positive amount in US dollars.",
	} {
		eq(t, r.api(r.cookie, "POST", "/auto/estimate", body).json(t)["error"], any(want), "estimate refusal")
	}

	// no token, a token for another setup: refused, and audited
	_, saveBody := r.setup(t, `["alpha","beta"]`)
	noToken := strings.Replace(saveBody, `"token":"`, `"tokenx":"`, 1)
	eq(t, r.api(r.cookie, "PUT", "/auto", noToken).status, 403, "no token")
	otherToken, _ := r.setup(t, `["alpha"]`)
	wrong := strings.Replace(saveBody, saveBody[strings.Index(saveBody, `"token":"`)+9:len(saveBody)-2], otherToken, 1)
	res := r.api(r.cookie, "PUT", "/auto", wrong)
	eq(t, res.status, 403, "a token for a different setup")
	has(t, res.body, "The agreement has expired or does not match this setup.")
	has(t, r.api(r.cookie, "GET", "/audit?q=denied", "").body, "Automatic update refused: no valid agreement")

	// the real one works once
	saved := r.api(r.cookie, "PUT", "/auto", saveBody)
	eq(t, saved.status, 200, "saved")
	payload := saved.json(t)
	eq(t, payload["enabled"], any(true), "switched on by saving")
	eq(t, payload["agreementOk"], any(true), "agreement matches")
	cfg := payload["config"].(map[string]any)
	eq(t, cfg["agreement"].(map[string]any)["by"], any("Admin"), "who agreed")
	eq(t, len(cfg["agreement"].(map[string]any)["key"].(string)), 64, "fingerprint")
	next, _ := time.Parse(time.RFC3339, payload["nextRunAt"].(string))
	eq(t, next.UTC().Hour(), 2, "next run at 02:00 UTC")
	eq(t, r.api(r.cookie, "PUT", "/auto", saveBody).status, 403, "the same token a second time")
	has(t, r.api(r.cookie, "GET", "/audit?q=auto_agree", "").body, "Agreed to automatic AI use (Schedule: every Monday, Tuesday, Wednesday, Thursday and Friday at 02:00 UTC;")

	// changing the model's limits changes the fingerprint: the agreement no longer matches, the switch cannot be turned on
	id := r.api(r.cookie, "GET", "/providers", "").json(t)["providers"].([]any)[0].(map[string]any)["id"].(string)
	r.api(r.cookie, "PUT", "/llm/jobs/text", `{"model":{"providerId":"`+id+`","model":"muse-spark-1.3-contributor"},"maxTokens":30000}`)
	eq(t, r.api(r.cookie, "GET", "/auto", "").json(t)["agreementOk"], any(false), "agreement broken by the new limit")
	off := r.api(r.cookie, "PUT", "/auto/switch", `{"enabled":false}`)
	eq(t, off.json(t)["enabled"], any(false), "off needs nothing")
	on := r.api(r.cookie, "PUT", "/auto/switch", `{"enabled":true}`)
	eq(t, on.status, 409, "on needs the agreement")
	has(t, on.body, "The agreement does not match the current setup")
}

func TestAnAutomaticRunWritesTheArticleAndTheDiagramsAndReportsWhatItUsed(t *testing.T) {
	r := newAutoRig(t, "muse-spark-1.3-contributor", planAnswer)
	_, saveBody := r.setup(t, `["alpha","beta"]`)
	eq(t, r.api(r.cookie, "PUT", "/auto", saveBody).status, 200, "saved")
	// it is due now
	r.srv.auto.store.Update(func(f *auto.File) { due := iso(r.now); f.NextRunAt = &due })

	r.srv.auto.runner.Tick()

	// two projects x (article + charts) = four calls, one at a time; the notes were masked before they left
	eq(t, len(*r.seen), 4, "AI calls")
	user := (*r.seen)[0]["messages"].([]any)[1].(map[string]any)["content"].(string)
	has(t, user, "### NOTE alpha-one")
	has(t, user, "password: [redacted]")
	lacks(t, user, "hunter2hunter2")
	eq(t, (*r.seen)[0]["model"], any("muse-spark-1.3-contributor"), "model")

	payload := r.api(r.cookie, "GET", "/auto", "").json(t)
	run := payload["runs"].([]any)[0].(map[string]any)
	eq(t, run["status"], any("completed"), "status")
	eq(t, len(run["updated"].([]any)), 2, "both projects updated")
	eq(t, run["inputTokens"], any(float64(4800)), "tokens in")
	eq(t, run["outputTokens"], any(float64(13600)), "tokens out")
	usage := run["usage"].([]any)
	eq(t, len(usage), 2, "TEXT and IMAGES")
	eq(t, usage[0].(map[string]any)["kind"], any("wiki"), "TEXT")
	eq(t, usage[0].(map[string]any)["reasoningTokens"], any(float64(1800)), "reasoning tokens are summed")
	eq(t, usage[1].(map[string]any)["calls"], any(float64(2)), "two chart calls")
	eq(t, payload["run"], nil, "nothing running")

	// what is stored is what the Node server stores: the article with the fingerprint of every note, the diagram with its plan
	wiki := r.srv.auto.docs.Latest("alpha", "wiki")
	if wiki == nil || wiki.NoteCount == nil || *wiki.NoteCount != 2 || len(wiki.NoteHashes) != 2 || wiki.Ext != "md" || !strings.HasPrefix(wiki.Model, "Fake AI / muse") || wiki.By != "auto (agreed by Admin)" {
		t.Fatalf("article meta: %+v", wiki)
	}
	text, _ := r.srv.auto.docs.Read(*wiki)
	has(t, string(text), "## Disaster recovery")
	diagram := r.srv.auto.docs.Latest("alpha", "diagram")
	if diagram == nil || diagram.Ext != "svg" || diagram.BasedOn != wiki.ID || diagram.Plan == nil || len(diagram.Plan.Columns) != 2 {
		t.Fatalf("diagram meta: %+v", diagram)
	}
	svg, _ := r.srv.auto.docs.Read(*diagram)
	has(t, string(svg), "<svg xmlns")
	has(t, string(svg), ">Server</text>")
	rawJSON, _ := os.ReadFile(filepath.Join(r.srv.cfg.DocsDir, "alpha", "wiki-"+wiki.ID+".json"))
	has(t, string(rawJSON), `"noteHashes": {`)

	// the audit trail has one start and one done per call, and the run
	trail := r.api(r.cookie, "GET", "/audit?limit=500", "").body
	has(t, trail, "Article written by Fake AI / muse-spark-1.3-contributor from 2 notes (1200 tokens in, 3400 out, 900 of it reasoning)")
	has(t, trail, "Architecture diagrams drawn by Mnemosyne from a plan written by muse-spark-1.3-contributor (1 picture: Overview; 2 boxes, 1 arrows; 1200 tokens in, 3400 out, 900 of it reasoning)")
	has(t, trail, "Run completed: 2 updated, 0 unchanged, 0 failed, 0 not reached; 4800 tokens in, 13600 out; cost $0.0032")

	// nothing changed since: the next due run touches nothing and costs nothing
	r.srv.auto.store.Update(func(f *auto.File) { due := iso(r.now); f.NextRunAt = &due })
	r.srv.auto.runner.Tick()
	eq(t, len(*r.seen), 4, "no further AI call")
	second := r.api(r.cookie, "GET", "/auto", "").json(t)["runs"].([]any)[0].(map[string]any)
	eq(t, second["status"], any("nothing"), "second run")
	eq(t, len(second["unchanged"].([]any)), 2, "both unchanged")

	// a note changes: only that project is written again
	writeNote(t, r.dir, "beta", "beta-one", "2026-10-30", "Beta, changed.")
	r.srv.auto.index = engine.NewIndex(r.srv.cfg.NodesDir)
	r.srv.auto.store.Update(func(f *auto.File) { due := iso(r.now); f.NextRunAt = &due })
	r.srv.auto.runner.Tick()
	eq(t, len(*r.seen), 6, "beta only: article and charts")
	third := r.api(r.cookie, "GET", "/auto", "").json(t)["runs"].([]any)[0].(map[string]any)
	eq(t, strings.Join(toStrings(third["updated"]), ","), "beta", "updated")
	eq(t, strings.Join(toStrings(third["unchanged"]), ","), "alpha", "unchanged")
}

func TestAnUnusablePlanIsReportedAndTheArticleIsKept(t *testing.T) {
	r := newAutoRig(t, "muse-spark-1.3-contributor", `{"title":"x","diagrams":[{"columns":[{"nodes":[{"label":"alone"}]}]}]}`)
	_, saveBody := r.setup(t, `["alpha"]`)
	r.api(r.cookie, "PUT", "/auto", saveBody)
	r.srv.auto.store.Update(func(f *auto.File) { due := iso(r.now); f.NextRunAt = &due })
	r.srv.auto.runner.Tick()
	run := r.api(r.cookie, "GET", "/auto", "").json(t)["runs"].([]any)[0].(map[string]any)
	failed := run["failed"].([]any)[0].(map[string]any)
	eq(t, failed["project"], any("alpha"), "project")
	has(t, failed["error"].(string), "diagrams: The AI answered, but not with a usable diagram plan: none of the pictures in the plan could be used")
	has(t, failed["error"].(string), "(the earlier step was saved)")
	has(t, failed["error"].(string), "Nothing was drawn (1,200 tokens in, 3,400 out were used)")
	if r.srv.auto.docs.Latest("alpha", "wiki") == nil {
		t.Error("the article was saved")
	}
	if r.srv.auto.docs.Latest("alpha", "diagram") != nil {
		t.Error("no diagram was drawn")
	}
}

func TestAPersonsJobOnAProjectPageHoldsTheScheduledRunBack(t *testing.T) {
	r := newAutoRig(t, "muse-spark-1.3-contributor", planAnswer)
	_, saveBody := r.setup(t, `["alpha"]`)
	r.api(r.cookie, "PUT", "/auto", saveBody)
	r.srv.auto.store.Update(func(f *auto.File) { due := iso(r.now); f.NextRunAt = &due })
	// the Node server says so in a file next to the other portal state
	r.srv.auto.lock.Hold("person", r.now)
	r.srv.auto.runner.Tick()
	eq(t, len(*r.seen), 0, "no AI call while a person's job runs")
	r.srv.auto.lock.Release("person")
	r.srv.auto.runner.Tick()
	eq(t, len(*r.seen), 2, "the run goes ahead afterwards")
	if r.srv.auto.lock.HeldBy("auto", r.now) {
		t.Error("the lock of an automatic run is released at the end")
	}
}

func iso(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }
