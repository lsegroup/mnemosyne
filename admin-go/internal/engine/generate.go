package engine

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"gitlab.globalclouddata.org/gcd-group/mnemosyne-admin/internal/audit"
	"gitlab.globalclouddata.org/gcd-group/mnemosyne-admin/internal/jobs"
	"gitlab.globalclouddata.org/gcd-group/mnemosyne-admin/internal/store"
)

// Kind is what one AI job writes: the article ("wiki", TEXT) or the diagrams ("diagram", the AI flow charts).
type Kind string

// The two kinds of AI job, and Painted: the usage line of the image model's call inside a Diagram job (it is not a job of its own).
const (
	Wiki    Kind = "wiki"
	Diagram Kind = "diagram"
	Painted Kind = "picture"
)

// PictureOutcome is the workflow diagram the image model painted inside a Diagram job.
type PictureOutcome struct {
	// Model is the image model (its id, e.g. "muse-image-1.0").
	Model string
	// USD is the list price of one picture; zero when the model has no list price.
	USD float64
	// MS is how long the call took.
	MS int64
}

// Outcome is what one AI job used.
type Outcome struct {
	// Model is the model that answered (its id, e.g. "muse-spark-1.3-contributor").
	Model           string
	InputTokens     int
	OutputTokens    int
	ReasoningTokens *int
	// USD is counted from the reported tokens; nil when the model has no list price.
	USD     *float64
	Warning string
	// Picture is set when the image model painted the workflow diagram; its cost is NOT in USD.
	Picture *PictureOutcome
}

// Generator runs ONE AI job for one project.
type Generator struct {
	Providers *store.Providers
	Notes     *Index
	Docs      *DocStore
}

var reFence = regexp.MustCompile("(?is)^```(?:markdown|md)?\n(.*?)\n```$")

func stripFence(t string) string {
	t = JSTrim(t)
	if m := reFence.FindStringSubmatch(t); m != nil {
		t = m[1]
	}
	return JSTrim(t)
}

func commas(n int) string {
	s := fmt.Sprint(n)
	var out []byte
	for i, c := range []byte(s) {
		if i > 0 && (len(s)-i)%3 == 0 {
			out = append(out, ',')
		}
		out = append(out, c)
	}
	return string(out)
}

func thinking(r *int) string {
	if r == nil {
		return ""
	}
	return fmt.Sprintf(", %d of it reasoning", *r)
}

// Generate builds the prompt, makes the ONE model call, stores the result and tells the audit trail. It fails with a plain message
// (jobs.ValidationError) or, when the connection itself failed, with an UnreachableError.
func (g *Generator) Generate(project string, kind Kind, user, glName string, log func(audit.Input)) (Outcome, error) {
	provider, model, err := g.Providers.Assigned(jobs.Text)
	if err != nil {
		return Outcome{}, err
	}
	if provider == nil {
		return Outcome{}, jobs.Invalid("Choose a model for Text in Admin → LLM first.")
	}
	stored, err := g.Providers.Jobs()
	if err != nil {
		return Outcome{}, err
	}
	label := provider.Label + " / " + model
	var used ChatResult
	warning := ""
	var picture *PictureOutcome

	opts := func(e jobs.Effective) ChatOptions {
		return ChatOptions{MaxTokens: e.MaxTokens, Temperature: e.Temperature, TopP: e.TopP, ReasoningEffort: e.ReasoningEffort, Timeout: time.Duration(e.TimeoutMinutes) * time.Minute}
	}

	if kind == Wiki {
		tj := jobs.Effect(jobs.Text, stored[jobs.Text])
		notes := g.Notes.InProject(project)
		d := jobs.Defs[jobs.Text].Defaults
		prompt := BuildWikiPrompt(project, glName, notes, Templates{System: tj.SystemPrompt, User: tj.UserPrompt}, Templates{System: d.SystemPrompt, User: d.UserPrompt})
		out, err := Chat(*provider, model, prompt.System, prompt.User, opts(tj))
		if err != nil {
			return Outcome{}, err
		}
		used = out
		noteCount, in, outTok := prompt.NoteCount, out.InputTokens, out.OutputTokens
		meta, err := g.Docs.Save(DocMeta{Kind: "wiki", Project: project, Model: label, By: user, NoteCount: &noteCount, NoteHashes: NoteHashes(notes), InputTokens: &in, OutputTokens: &outTok, Ext: "md"}, []byte(Redact(stripFence(out.Text))))
		if err != nil {
			return Outcome{}, err
		}
		missing := MissingSections(out.Text)
		tail := ""
		if len(missing) > 0 {
			warning = fmt.Sprintf("The article was saved, but the AI left out: %s. Click “Regenerate documentation” to try again.", strings.Join(missing, ", "))
			tail = "; MISSING SECTIONS: " + strings.Join(missing, ", ")
		}
		log(audit.Input{Event: "ai_done", EntityID: meta.ID, Description: fmt.Sprintf("Article written by %s from %d notes (%d tokens in, %d out%s)%s", meta.Model, prompt.NoteCount, out.InputTokens, out.OutputTokens, thinking(out.ReasoningTokens), tail)})
	} else {
		// one AI call writes the PLAN (data); Mnemosyne draws the picture itself, so no word in it is misspelled by a model
		wiki := g.Docs.Latest(project, "wiki")
		if wiki == nil {
			return Outcome{}, jobs.Invalid("Generate the documentation first.")
		}
		article, err := g.Docs.Read(*wiki)
		if err != nil {
			return Outcome{}, err
		}
		ij := jobs.Effect(jobs.Image, stored[jobs.Image])
		d := jobs.Defs[jobs.Image].Defaults
		system, userPrompt := BuildDiagramPlanPrompt(project, string(article), Templates{System: ij.SystemPrompt, User: ij.UserPrompt}, Templates{System: d.SystemPrompt, User: d.UserPrompt})
		out, err := Chat(*provider, model, system, userPrompt, opts(ij))
		if err != nil {
			return Outcome{}, err
		}
		used = out
		fallback := project
		if glName != "" {
			fallback = glName
		}
		set, err := ParsePlanSet(out.Text, fallback)
		if err != nil {
			var pe *PlanError
			if !errors.As(err, &pe) {
				return Outcome{}, err
			}
			return Outcome{}, jobs.Invalid("The AI answered, but not with a usable diagram plan: %s. Nothing was drawn (%s tokens in, %s out were used). If you changed the instruction in Admin → LLM → Images, press “Reset to defaults” there: it must ask for the JSON plan.", pe.Msg, commas(out.InputTokens), commas(out.OutputTokens))
		}
		overview, details := set.Pictures[0], set.Pictures[1:]
		boxes, arrows := 0, 0
		var names []string
		for _, p := range set.Pictures {
			names = append(names, p.Name)
			for _, c := range p.Plan.Columns {
				boxes += len(c.Nodes)
			}
			arrows += len(p.Plan.Links)
		}
		in, outTok := out.InputTokens, out.OutputTokens
		plan := overview.Plan
		meta, err := g.Docs.Save(DocMeta{Kind: "diagram", Project: project, Model: "Mnemosyne, planned by " + label, By: user, BasedOn: wiki.ID, InputTokens: &in, OutputTokens: &outTok, Ext: "svg", Plan: &plan, Pictures: details}, []byte(RenderSVG(Layout(plan), plan)))
		if err != nil {
			return Outcome{}, err
		}
		tail := ""
		if len(set.Dropped) > 0 {
			shown := set.Dropped[:min(3, len(set.Dropped))]
			more := ""
			if len(set.Dropped) > 3 {
				more = "; ..."
			}
			warning = fmt.Sprintf("The diagrams were drawn, but %d item(s) of the AI's plan could not be used and were left out: %s%s.", len(set.Dropped), strings.Join(shown, "; "), more)
			tail = fmt.Sprintf("; left out of the plan: %d", len(set.Dropped))
		}
		plural := ""
		if len(set.Pictures) > 1 {
			plural = "s"
		}
		log(audit.Input{Event: "ai_done", EntityID: meta.ID, Description: fmt.Sprintf("Architecture diagrams drawn by Mnemosyne from a plan written by %s (%d picture%s: %s; %d boxes, %d arrows; %d tokens in, %d out%s)%s", model, len(set.Pictures), plural, strings.Join(names, ", "), boxes, arrows, out.InputTokens, out.OutputTokens, thinking(out.ReasoningTokens), tail)})

		// The image model chosen in Admin -> LLM -> Images paints the workflow diagram as a picture, from the exact plan above (every word is
		// given to it). The exact diagrams are saved already, so a failure here costs only the picture and never fails (or repeats) the job.
		ip, im, aerr := g.Providers.Assigned(jobs.Image)
		if aerr == nil && ip != nil {
			began := time.Now()
			pic, perr := GenerateImage(*ip, im, BuildPicturePrompt(plan), 0)
			imgLabel := ip.Label + " / " + im
			if perr == nil {
				var pm DocMeta
				if pm, perr = g.Docs.Save(DocMeta{Kind: "picture", ID: meta.ID, Project: project, Model: imgLabel, By: user, BasedOn: meta.ID, Ext: pic.Ext}, pic.Bytes); perr == nil {
					usd, _ := ImagePriceUSD(im)
					picture = &PictureOutcome{Model: im, USD: usd, MS: time.Since(began).Milliseconds()}
					log(audit.Input{Event: "ai_done", EntityType: "docs_picture", EntityID: pm.ID, Description: fmt.Sprintf("Workflow diagram painted by %s from the plan (%d KB %s)", imgLabel, len(pic.Bytes)/1024, strings.TrimPrefix(pic.Mime, "image/"))})
				}
			}
			if perr != nil {
				why := perr.Error()
				var ve *jobs.ValidationError
				var ue *UnreachableError
				switch {
				case errors.As(perr, &ve):
					why = ve.Msg
				case errors.As(perr, &ue):
					why = ue.Msg
				default:
					why = "the picture could not be stored (" + why + ")"
				}
				if warning != "" {
					warning += " "
				}
				warning += fmt.Sprintf("The exact diagrams were saved, but the image model %s could not paint the workflow diagram: %s", im, why)
				log(audit.Input{Event: "ai_failed", EntityType: "docs_picture", Description: fmt.Sprintf("Workflow diagram by %s failed: %s", imgLabel, why)})
			}
		}
	}
	o := Outcome{Model: model, InputTokens: used.InputTokens, OutputTokens: used.OutputTokens, ReasoningTokens: used.ReasoningTokens, Warning: warning, Picture: picture}
	if usd, ok := EstimateUSD(model, used.InputTokens, used.OutputTokens); ok {
		o.USD = &usd
	}
	return o, nil
}
