package web

import (
	"strings"
	"testing"

	"gitlab.globalclouddata.org/gcd-group/mnemosyne-admin/internal/auto"
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

// Owner order 2026-10-29: the workflow diagram is an IMAGE made by the image model chosen in Admin -> LLM -> Images. Since 2026-10-30 the exact
// diagrams are drawn by Mnemosyne from a plan, and the image model paints the picture from that same plan.
func TestAnAutomaticRunLetsTheImageModelPaintTheWorkflowDiagram(t *testing.T) {
	r := newAutoRig(t, "muse-spark-1.3-contributor", planAnswer)
	r.useImageModel(t, "muse-image-1.0")

	model := r.api(r.cookie, "GET", "/auto", "").json(t)["model"].(map[string]any)
	eq(t, model["label"], any("Fake AI / muse-spark-1.3-contributor, and the pictures by Fake AI / muse-image-1.0"), "the agreement names the image model")

	r.runDueNow(t, `["alpha","beta"]`)

	// the image model IS called, once per diagram job, and gets every word of the plan
	eq(t, len(r.images.bodies), 2, "image calls")
	body := r.images.bodies[0]
	eq(t, body["model"], any("muse-image-1.0"), "image model")
	prompt := body["prompt"].(string)
	has(t, prompt, `"Browser" -> "Server", label on the arrow: "HTTPS"`)
	has(t, prompt, `Column 2 (small heading "APP"): "Server"`)
	has(t, prompt, "spell every word EXACTLY")
	eq(t, len(*r.seen), 4, "the text calls are what they were")

	// stored next to the diagram, with the same stamp, and shown / put into the PDF by the Node server
	diagram := r.srv.auto.docs.Latest("alpha", "diagram")
	pic := r.srv.auto.docs.Latest("alpha", "picture")
	if diagram == nil || pic == nil || pic.ID != diagram.ID || pic.BasedOn != diagram.ID || pic.Ext != "png" || pic.Model != "Fake AI / muse-image-1.0" || pic.By != "auto (agreed by Admin)" {
		t.Fatalf("picture meta: %+v (diagram %+v)", pic, diagram)
	}
	bytes, _ := r.srv.auto.docs.Read(*pic)
	eq(t, string(bytes), string(fakePNG), "the picture as the provider sent it")

	// the run counts it: its own line (no tokens, billed per picture), in the cost and in the audit trail
	run := r.api(r.cookie, "GET", "/auto", "").json(t)["runs"].([]any)[0].(map[string]any)
	eq(t, run["status"], any("completed"), "status")
	eq(t, run["inputTokens"], any(float64(4800)), "tokens in are the text calls'")
	usage := run["usage"].([]any)
	eq(t, len(usage), 3, "TEXT, IMAGES and PICTURES")
	painted := usage[2].(map[string]any)
	eq(t, painted["kind"], any("picture"), "PICTURES")
	eq(t, painted["model"], any("muse-image-1.0"), "model")
	eq(t, painted["calls"], any(float64(2)), "two pictures")
	eq(t, painted["usd"], any(0.02), "two pictures at $0.01")
	eq(t, run["usd"], any(0.0232), "the run cost: text $0.0032 and two pictures")
	trail := r.api(r.cookie, "GET", "/audit?limit=500", "").body
	has(t, trail, "Workflow diagram painted by Fake AI / muse-image-1.0 from the plan (")
	has(t, trail, "PICTURES $0.0200 in 2 calls (muse-image-1.0)")
	has(t, trail, "cost $0.0232")
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
}

// The exact diagrams are the work; a refusing image model costs the picture only, the job is not repeated and not failed.
func TestAnImageModelThatRefusesCostsOnlyThePicture(t *testing.T) {
	r := newAutoRig(t, "muse-spark-1.3-contributor", planAnswer)
	r.useImageModel(t, "muse-image-1.0")
	r.images.fail = true

	r.runDueNow(t, `["alpha"]`)

	eq(t, len(*r.seen), 2, "article and plan, no repeat of the plan call")
	eq(t, len(r.images.bodies), 1, "the image model was asked once")
	if r.srv.auto.docs.Latest("alpha", "diagram") == nil {
		t.Error("the exact diagram must be saved")
	}
	if p := r.srv.auto.docs.Latest("alpha", "picture"); p != nil {
		t.Errorf("no picture was painted: %+v", p)
	}
	run := r.api(r.cookie, "GET", "/auto", "").json(t)["runs"].([]any)[0].(map[string]any)
	eq(t, run["status"], any("completed"), "the run is complete")
	eq(t, len(run["failed"].([]any)), 0, "nothing failed")
	eq(t, len(run["usage"].([]any)), 2, "no PICTURES line: nothing was billed")
	eq(t, run["usd"], any(0.0016), "text only")
	warnings := strings.Join(toStrings(run["warnings"]), " | ")
	has(t, warnings, "The exact diagrams were saved, but the image model muse-image-1.0 could not paint the workflow diagram: The provider answered HTTP 500 for image generation.")
	has(t, r.api(r.cookie, "GET", "/audit?limit=500", "").body, "Workflow diagram by Fake AI / muse-image-1.0 failed: The provider answered HTTP 500 for image generation.")
}

// The page of the Images job offers the image model again and sends the choice.
func TestTheImagesCardOffersTheImageModelAndSavesTheChoice(t *testing.T) {
	h := newHarness(t, withLocal(nil))
	cookie, _ := h.localCookie("Admin", "correct horse")
	page := h.do(call{path: "/admin/", cookie: cookie}).body
	a := strings.Index(page, `id="job-image"`)
	b := strings.Index(page[a:], "</form>")
	card := page[a : a+b]
	has(t, card, "<h4>Images</h4>")
	has(t, card, "Step 2: the image model chosen here paints the workflow diagram")
	has(t, card, `<label class="wide">Model<select id="m-image"></select>`)
	if strings.Contains(card, "hidden") || strings.Contains(card, "There is no model to choose") || strings.Contains(card, "No image model is called") {
		t.Error("the Images card must offer the image model")
	}
	has(t, page, "var body={},v=$('m-'+role).value;")
	has(t, page, "Save Images settings")
}
