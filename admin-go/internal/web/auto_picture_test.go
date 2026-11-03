// SPDX-License-Identifier: Apache-2.0

package web

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/lsegroup/mnemosyne/admin-go/internal/auto"
	"github.com/lsegroup/mnemosyne/admin-go/internal/jobs"
)

// useImageModel chooses the image model for the Images job (Admin -> LLM), the way the page does.
func (r *autoRig) useImageModel(t *testing.T, model string) {
	t.Helper()
	got := r.api(r.cookie, "PUT", "/llm/jobs/image", `{"model":{"providerId":"`+r.provider+`","model":"`+model+`"}}`)
	if got.status != 200 {
		t.Fatalf("image model: %d %s", got.status, got.body)
	}
}

func (r *autoRig) runDueNow(t *testing.T, projects string) {
	t.Helper()
	_, saveBody := r.setup(t, projects)
	eq(t, r.api(r.cookie, "PUT", "/auto", saveBody).status, 200, "saved")
	r.srv.auto.store.Update(func(f *auto.File) { due := iso(r.now); f.NextRunAt = &due })
	r.srv.auto.runner.Tick()
}

// the plan of the AI with an overview and one detail picture
const planWithDetail = `{"title":"Alpha","diagrams":[
 {"name":"Overview","columns":[{"title":"CLIENTS","nodes":[{"id":"u","label":"Browser"}]},{"title":"APP","nodes":[{"id":"a","label":"Server","detail":"Node, :40001"}]}],"links":[{"from":"u","to":"a","label":"HTTPS"}]},
 {"name":"Sign-in and security","columns":[{"title":"APP","nodes":[{"id":"w","label":"Web portal"}]},{"title":"IDENTITY","nodes":[{"id":"i","label":"GitLab OAuth"}]}],"links":[{"from":"w","to":"i","label":"authorize"}]}]}`

// docFiles lists the diagram files of a project (what is left after a run).
func (r *autoRig) docFiles(project string) []string {
	entries, _ := os.ReadDir(filepath.Join(r.srv.cfg.DocsDir, project))
	var out []string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "diagram-") || strings.HasPrefix(e.Name(), "picture-") {
			out = append(out, e.Name())
		}
	}
	sort.Strings(out)
	return out
}

// Owner order 2026-10-29: the workflow diagram is made by the image model chosen in Admin -> LLM -> Images, on the page and in the PDF.
// Owner order 2026-11-01: a new run replaces every earlier diagram and picture of the project; no colour is named, straight lines only.
func TestAnAutomaticRunLetsTheImageModelPaintEveryPictureAndReplacesTheOldOnes(t *testing.T) {
	r := newAutoRig(t, "muse-spark-1.3-contributor", planWithDetail)
	r.useImageModel(t, "muse-image-1.0")

	model := r.api(r.cookie, "GET", "/auto", "").json(t)["model"].(map[string]any)
	eq(t, model["label"], any("Fake AI / muse-spark-1.3-contributor, and the pictures by Fake AI / muse-image-1.0"), "the agreement names the image model")

	// what the project had before: an exact diagram with a detail picture, and a picture an earlier build kept
	dir := filepath.Join(r.srv.cfg.DocsDir, "alpha")
	_ = os.MkdirAll(dir, 0o755)
	for _, old := range []string{"diagram-20260101T000000Z.svg", "diagram-20260101T000000Z.json", "diagram-20260101T000000Z-1.svg", "picture-20260101T000000Z.webp", "picture-20260101T000000Z.json"} {
		_ = os.WriteFile(filepath.Join(dir, old), []byte("{}"), 0o644)
	}

	r.runDueNow(t, `["alpha","beta"]`)

	// the image model IS called: the overview and the detail picture of each project, four pictures; it gets every word of ITS picture's plan
	eq(t, len(r.images.bodies), 4, "image calls")
	overview, detail := r.images.bodies[0], r.images.bodies[1]
	eq(t, overview["model"], any("muse-image-1.0"), "image model")
	has(t, overview["prompt"].(string), `"Browser" -> "Server", label on the arrow: "HTTPS"`)
	has(t, overview["prompt"].(string), `Column 2 (small heading "APP"): "Server"`)
	has(t, overview["prompt"].(string), "spell every word EXACTLY")
	has(t, detail["prompt"].(string), `"Web portal" -> "GitLab OAuth", label on the arrow: "authorize"`)
	// nothing about colour, and straight lines only
	lacks(t, overview["prompt"].(string), "navy")
	lacks(t, strings.ToLower(overview["prompt"].(string)), "colour")
	has(t, overview["prompt"].(string), "only horizontally or vertically")
	eq(t, len(*r.seen), 4, "the text calls are what they were")

	// stored as the diagram (an image, not an SVG), the detail picture next to it; everything older is gone
	diagram := r.srv.auto.docs.Latest("alpha", "diagram")
	if diagram == nil || diagram.Ext != "png" || len(diagram.Pictures) != 1 || diagram.Pictures[0].Ext != "png" || diagram.Pictures[0].Name != "Sign-in and security" || diagram.Plan == nil {
		t.Fatalf("diagram meta: %+v", diagram)
	}
	eq(t, diagram.Model, "Fake AI / muse-image-1.0, planned by Fake AI / muse-spark-1.3-contributor", "the stamp names the model that painted it")
	bytes, _ := r.srv.auto.docs.Read(*diagram)
	eq(t, string(bytes), string(fakePNG), "the overview as the provider sent it")
	extra, _ := r.srv.auto.docs.ReadExtra(*diagram, 1)
	eq(t, string(extra), string(fakePNG), "the detail picture as the provider sent it")
	files := r.docFiles("alpha")
	eq(t, len(files), 3, "the set's description, the overview and the detail picture: "+strings.Join(files, ","))
	for _, f := range files {
		if strings.Contains(f, "20260101T000000Z") || strings.HasPrefix(f, "picture-") {
			t.Errorf("an older file is still there: %s", f)
		}
	}

	// the run counts them: their own line (no tokens, billed per picture), in the cost and in the audit trail
	run := r.api(r.cookie, "GET", "/auto", "").json(t)["runs"].([]any)[0].(map[string]any)
	eq(t, run["status"], any("completed"), "status")
	eq(t, run["inputTokens"], any(float64(4800)), "tokens in are the text calls'")
	usage := run["usage"].([]any)
	eq(t, len(usage), 3, "TEXT, IMAGES and PICTURES")
	painted := usage[2].(map[string]any)
	eq(t, painted["kind"], any("picture"), "PICTURES")
	eq(t, painted["model"], any("muse-image-1.0"), "model")
	eq(t, painted["calls"], any(float64(4)), "four pictures")
	eq(t, painted["usd"], any(0.04), "four pictures at $0.01")
	eq(t, run["usd"], any(0.0432), "the run cost: text $0.0032 and four pictures")
	trail := r.api(r.cookie, "GET", "/audit?limit=500", "").body
	has(t, trail, "Workflow diagram painted by Fake AI / muse-image-1.0: 2 pictures (Overview, Sign-in and security;")
	has(t, trail, "5 files of the earlier diagrams deleted")
	has(t, trail, "PICTURES $0.0400 in 4 calls (muse-image-1.0)")
}

// The agreement of the owner covers the image model: a run that was agreed to without one must not start spending on one.
func TestChoosingAnImageModelNeedsANewAgreement(t *testing.T) {
	r := newAutoRig(t, "muse-spark-1.3-contributor", planAnswer)
	_, saveBody := r.setup(t, `["alpha"]`)
	eq(t, r.api(r.cookie, "PUT", "/auto", saveBody).status, 200, "saved")
	eq(t, r.api(r.cookie, "GET", "/auto", "").json(t)["agreementOk"], any(true), "agreed")

	r.useImageModel(t, "muse-image-1.0")
	eq(t, r.api(r.cookie, "GET", "/auto", "").json(t)["agreementOk"], any(false), "the agreement no longer matches")

	// and with the image model in the setup, a fresh agreement shows what the run costs with it
	_, again := r.setup(t, `["alpha"]`)
	eq(t, r.api(r.cookie, "PUT", "/auto", again).status, 200, "agreed again")
	eq(t, r.api(r.cookie, "GET", "/auto", "").json(t)["agreementOk"], any(true), "agreed to the new setup")

	// editing what the image model is told costs nothing more: the agreement stays
	r.api(r.cookie, "PUT", "/llm/jobs/image", `{"model":{"providerId":"`+r.provider+`","model":"muse-image-1.0"},"picturePrompt":"Draw {{title}} in pastel colours.\n{{plan}}"}`)
	eq(t, r.api(r.cookie, "GET", "/auto", "").json(t)["agreementOk"], any(true), "a new picture instruction needs no new agreement")
}

// A detail picture that cannot be painted is left out and reported; the overview and the rest are kept.
func TestADetailPictureTheImageModelRefusesIsLeftOutAndReported(t *testing.T) {
	r := newAutoRig(t, "muse-spark-1.3-contributor", planWithDetail)
	r.useImageModel(t, "muse-image-1.0")
	r.images.failFrom = 2 // the second image call of the run: the detail picture

	r.runDueNow(t, `["alpha"]`)

	eq(t, len(r.images.bodies), 2, "both pictures were asked for")
	diagram := r.srv.auto.docs.Latest("alpha", "diagram")
	if diagram == nil || diagram.Ext != "png" || len(diagram.Pictures) != 0 {
		t.Fatalf("the overview is kept, the missing detail picture is not listed: %+v", diagram)
	}
	run := r.api(r.cookie, "GET", "/auto", "").json(t)["runs"].([]any)[0].(map[string]any)
	eq(t, run["status"], any("completed"), "the run is complete")
	eq(t, len(run["failed"].([]any)), 0, "nothing failed")
	warnings := strings.Join(toStrings(run["warnings"]), " | ")
	has(t, warnings, "The workflow diagram was painted, but 1 detail picture(s) could not be painted and are missing: Sign-in and security: The provider answered HTTP 400 for image generation.")
	usage := run["usage"].([]any)
	eq(t, usage[2].(map[string]any)["calls"], any(float64(1)), "only the picture that was painted is billed")
	eq(t, run["usd"], any(0.0116), "text $0.0016 and one picture")
}

// If not even the overview can be painted the project keeps what it had, and the run says why.
func TestAnImageModelThatCannotPaintTheOverviewLeavesTheEarlierDiagramsAlone(t *testing.T) {
	r := newAutoRig(t, "muse-spark-1.3-contributor", planWithDetail)
	r.useImageModel(t, "muse-image-1.0")
	dir := filepath.Join(r.srv.cfg.DocsDir, "alpha")
	_ = os.MkdirAll(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, "diagram-20260101T000000Z.json"), []byte(`{"kind":"diagram","id":"20260101T000000Z","generatedAt":"2026-01-01T00:00:00.000Z","project":"alpha","model":"old","by":"x","ext":"png"}`), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "diagram-20260101T000000Z.png"), fakePNG, 0o644)
	r.images.failFrom = 1

	r.runDueNow(t, `["alpha"]`)

	eq(t, len(*r.seen), 2, "article and plan, no repeat of the plan call")
	eq(t, len(r.images.bodies), 1, "the image model was asked once")
	files := r.docFiles("alpha")
	eq(t, strings.Join(files, ","), "diagram-20260101T000000Z.json,diagram-20260101T000000Z.png", "the earlier diagram is untouched")
	run := r.api(r.cookie, "GET", "/auto", "").json(t)["runs"].([]any)[0].(map[string]any)
	failed := run["failed"].([]any)[0].(map[string]any)
	eq(t, failed["project"], any("alpha"), "project")
	has(t, failed["error"].(string), "could not paint the overview")
	has(t, failed["error"].(string), "The earlier diagrams of this project were kept.")
}

// With no image model chosen Mnemosyne draws the exact diagrams itself, and they replace the old ones too.
func TestWithNoImageModelTheExactDiagramsAreDrawnAndReplaceTheOldOnes(t *testing.T) {
	r := newAutoRig(t, "muse-spark-1.3-contributor", planWithDetail)
	dir := filepath.Join(r.srv.cfg.DocsDir, "alpha")
	_ = os.MkdirAll(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, "diagram-20260101T000000Z.png"), fakePNG, 0o644)
	_ = os.WriteFile(filepath.Join(dir, "diagram-20260101T000000Z-1.png"), fakePNG, 0o644)

	r.runDueNow(t, `["alpha"]`)

	eq(t, len(r.images.bodies), 0, "no image model, no image call")
	diagram := r.srv.auto.docs.Latest("alpha", "diagram")
	if diagram == nil || diagram.Ext != "svg" || diagram.Model != "Mnemosyne, planned by Fake AI / muse-spark-1.3-contributor" || len(diagram.Pictures) != 1 || diagram.Pictures[0].Ext != "" {
		t.Fatalf("diagram meta: %+v", diagram)
	}
	files := r.docFiles("alpha")
	eq(t, len(files), 2, "the SVG and its description: "+strings.Join(files, ","))
	has(t, r.api(r.cookie, "GET", "/audit?limit=500", "").body, "2 files of the earlier diagrams deleted")
}

// The Images card offers the image model and the instruction for the picture, and sends both.
func TestTheImagesCardOffersTheImageModelAndTheInstructionForThePicture(t *testing.T) {
	h := newHarness(t, withLocal(nil))
	cookie, _ := h.localCookie("Admin", "correct horse")
	page := h.do(call{path: "/admin/", cookie: cookie}).body
	a := strings.Index(page, `id="job-image"`)
	b := strings.Index(page[a:], "</form>")
	card := page[a : a+b]
	has(t, card, "<h4>Images</h4>")
	has(t, card, "Step 2: the image model chosen here paints every picture of the plan")
	has(t, card, `<label class="wide">Model<select id="m-image"></select>`)
	has(t, card, `<textarea id="pic-image"`)
	has(t, card, "Instruction for the picture")
	if strings.Contains(card, "hidden") || strings.Contains(card, "There is no model to choose") || strings.Contains(card, "usesAi") {
		t.Error("the Images card is wrong")
	}
	has(t, page, "if(role==='image')body.picturePrompt=$('pic-image').value;")
	has(t, page, "Save Images settings")

	// the API carries the built-in instruction and stores an edited one; one without {{plan}} is refused
	jobsJSON := h.api(cookie, "GET", "/llm/jobs", "").json(t)["jobs"].(map[string]any)["image"].(map[string]any)
	eq(t, jobsJSON["effective"].(map[string]any)["picturePrompt"], any(jobs.Defs[jobs.Image].Defaults.PicturePrompt), "the built-in instruction")
	bad := h.api(cookie, "PUT", "/llm/jobs/image", `{"picturePrompt":"just draw it"}`)
	eq(t, bad.status, 400, "no {{plan}}")
	has(t, bad.body, "must contain {{plan}}")
	bad = h.api(cookie, "PUT", "/llm/jobs/image", `{"picturePrompt":"{{plan}} {{colour}}"}`)
	has(t, bad.body, "Unknown placeholder {{colour}}")
	ok := h.api(cookie, "PUT", "/llm/jobs/image", `{"picturePrompt":"Draw {{title}} in pastel colours.\n{{plan}}"}`)
	eq(t, ok.status, 200, "saved")
	eff := h.api(cookie, "GET", "/llm/jobs", "").json(t)["jobs"].(map[string]any)["image"].(map[string]any)
	eq(t, eff["effective"].(map[string]any)["picturePrompt"], any("Draw {{title}} in pastel colours.\n{{plan}}"), "the edited instruction")
	h.api(cookie, "PUT", "/llm/jobs/image", `{"picturePrompt":""}`)
	eff = h.api(cookie, "GET", "/llm/jobs", "").json(t)["jobs"].(map[string]any)["image"].(map[string]any)
	eq(t, eff["effective"].(map[string]any)["picturePrompt"], any(jobs.Defs[jobs.Image].Defaults.PicturePrompt), "blank = the built-in instruction again")
}

// Every card of Admin -> LLM starts with the summary of its job definition: a card text that drifted from its definition (it once held a piece
// of another job's source code) is caught here.
func TestEveryJobCardStartsWithTheSummaryOfItsDefinition(t *testing.T) {
	h := newHarness(t, withLocal(nil))
	cookie, _ := h.localCookie("Admin", "correct horse")
	page := h.do(call{path: "/admin/", cookie: cookie}).body
	for _, role := range jobs.Roles {
		a := strings.Index(page, `id="job-`+string(role)+`"`)
		p := strings.Index(page[a:], `<p class="sub">`)
		end := strings.Index(page[a+p:], "</p>")
		got := page[a+p+len(`<p class="sub">`) : a+p+end]
		eq(t, got, jobs.Defs[role].Summary, "the card of the "+string(role)+" job")
	}
}
