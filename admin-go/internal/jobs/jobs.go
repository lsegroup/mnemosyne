// SPDX-License-Identifier: Apache-2.0

// Package jobs holds the AI jobs an administrator can set up (Admin -> LLM, step 4): what each job is for, the built-in defaults
// (limits and prompts), the stored settings, and the validation of the admin form. Port of ai-jobs.ts; the definitions themselves are
// rendered from the Node code (tools/extract-assets.mjs), so the texts and prompts are identical.
package jobs

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"

	"github.com/lsegroup/mnemosyne/admin-go/internal/assets"
)

// Role is a job a model can be assigned to.
type Role string

// The jobs, in the order the admin page shows them.
const (
	Text  Role = "text"
	Image Role = "image"
	PDF   Role = "pdf"
)

// Roles lists every job.
var Roles = []Role{Text, Image, PDF}

// ValidRole reports whether s names a job.
func ValidRole(s string) bool {
	for _, r := range Roles {
		if string(r) == s {
			return true
		}
	}
	return false
}

// ValidationError is a plain message for the person who filled in the form.
type ValidationError struct{ Msg string }

func (e *ValidationError) Error() string { return e.Msg }

// Invalid builds a ValidationError.
func Invalid(format string, a ...any) error { return &ValidationError{Msg: fmt.Sprintf(format, a...)} }

// Settings is everything an administrator can set for one job. Unset fields are not stored: the built-in default applies.
type Settings struct {
	MaxTokens       *int     `json:"maxTokens,omitempty"`
	Temperature     *float64 `json:"temperature,omitempty"`
	TopP            *float64 `json:"topP,omitempty"`
	ReasoningEffort string   `json:"reasoningEffort,omitempty"`
	TimeoutMinutes  *int     `json:"timeoutMinutes,omitempty"`
	SystemPrompt    string   `json:"systemPrompt,omitempty"`
	UserPrompt      string   `json:"userPrompt,omitempty"`
	// PicturePrompt is for the job Images only: what the image model is told for every picture ({{title}} and {{plan}} are filled in).
	PicturePrompt string `json:"picturePrompt,omitempty"`
}

// IsEmpty reports whether nothing is set.
func (s Settings) IsEmpty() bool { return s == Settings{} }

// File is the stored settings of every job.
type File map[Role]Settings

// Placeholder is a {{name}} the server fills in a prompt.
type Placeholder struct {
	Name     string `json:"name"`
	Meaning  string `json:"meaning"`
	Required bool   `json:"required"`
}

// Defaults are the built-in values of a job.
type Defaults struct {
	MaxTokens       int      `json:"maxTokens"`
	TimeoutMinutes  int      `json:"timeoutMinutes"`
	SystemPrompt    string   `json:"systemPrompt"`
	UserPrompt      string   `json:"userPrompt"`
	Temperature     *float64 `json:"temperature,omitempty"`
	TopP            *float64 `json:"topP,omitempty"`
	ReasoningEffort string   `json:"reasoningEffort,omitempty"`
	PicturePrompt   string   `json:"picturePrompt,omitempty"`
}

// Def is the definition of one job.
type Def struct {
	Role         Role          `json:"role"`
	Title        string        `json:"title"`
	Summary      string        `json:"summary"`
	UsesAI       bool          `json:"usesAi"`
	SystemLabel  string        `json:"systemLabel"`
	UserLabel    string        `json:"userLabel"`
	Placeholders []Placeholder `json:"placeholders"`
	Defaults     Defaults      `json:"defaults"`
}

// Defs are the three job definitions.
var Defs map[Role]Def

// MaxOutputTokens is the highest output limit an administrator may set per call.
var MaxOutputTokens int

// ReasoningEfforts are the levels OpenAI-style APIs know for reasoning_effort.
var ReasoningEfforts []string

func init() {
	var raw struct {
		Defs             map[Role]Def `json:"defs"`
		MaxOutputTokens  int          `json:"maxOutputTokens"`
		ReasoningEfforts []string     `json:"reasoningEfforts"`
	}
	if err := json.Unmarshal(assets.JobDefsJSON, &raw); err != nil {
		panic("jobdefs.json: " + err.Error())
	}
	Defs, MaxOutputTokens, ReasoningEfforts = raw.Defs, raw.MaxOutputTokens, raw.ReasoningEfforts
}

// Effective is the stored settings over the defaults, as a call uses them.
type Effective struct {
	MaxTokens       int      `json:"maxTokens"`
	Temperature     *float64 `json:"temperature,omitempty"`
	TopP            *float64 `json:"topP,omitempty"`
	ReasoningEffort string   `json:"reasoningEffort,omitempty"`
	TimeoutMinutes  int      `json:"timeoutMinutes"`
	SystemPrompt    string   `json:"systemPrompt"`
	UserPrompt      string   `json:"userPrompt"`
	PicturePrompt   string   `json:"picturePrompt,omitempty"`
}

// Effect works out what a job really uses; a blank prompt means the default.
func Effect(role Role, s Settings) Effective {
	d := Defs[role].Defaults
	e := Effective{
		MaxTokens:       d.MaxTokens,
		Temperature:     d.Temperature,
		TopP:            d.TopP,
		ReasoningEffort: d.ReasoningEffort,
		TimeoutMinutes:  d.TimeoutMinutes,
		SystemPrompt:    d.SystemPrompt,
		UserPrompt:      d.UserPrompt,
		PicturePrompt:   d.PicturePrompt,
	}
	if s.MaxTokens != nil {
		e.MaxTokens = *s.MaxTokens
	}
	if s.Temperature != nil {
		e.Temperature = s.Temperature
	}
	if s.TopP != nil {
		e.TopP = s.TopP
	}
	if s.ReasoningEffort != "" {
		e.ReasoningEffort = s.ReasoningEffort
	}
	if s.TimeoutMinutes != nil {
		e.TimeoutMinutes = *s.TimeoutMinutes
	}
	if strings.TrimSpace(s.SystemPrompt) != "" {
		e.SystemPrompt = s.SystemPrompt
	}
	if strings.TrimSpace(s.UserPrompt) != "" {
		e.UserPrompt = s.UserPrompt
	}
	if strings.TrimSpace(s.PicturePrompt) != "" {
		e.PicturePrompt = s.PicturePrompt
	}
	return e
}

// JSLen is the length of s the way JavaScript counts it (UTF-16 code units), which is what the stored limits and messages mean.
func JSLen(s string) int { return len(utf16.Encode([]rune(s))) }

// JSSlice is s.slice(0, n) in JavaScript.
func JSSlice(s string, n int) string {
	u := utf16.Encode([]rune(s))
	if len(u) > n {
		u = u[:n]
	}
	return string(utf16.Decode(u))
}

// number reads a form value like the Node server does: empty means "not set"; text may use a decimal comma.
func number(v any, field string, min, max float64, integer bool) (*float64, error) {
	var n float64
	switch t := v.(type) {
	case nil:
		return nil, nil
	case string:
		if t == "" {
			return nil, nil
		}
		f, err := strconv.ParseFloat(strings.ReplaceAll(strings.TrimSpace(t), ",", "."), 64)
		if err != nil || math.IsInf(f, 0) || math.IsNaN(f) {
			return nil, Invalid("%s must be a number", field)
		}
		n = f
	case float64:
		n = t
	default:
		return nil, Invalid("%s must be a number", field)
	}
	if math.IsInf(n, 0) || math.IsNaN(n) {
		return nil, Invalid("%s must be a number", field)
	}
	if integer && n != math.Trunc(n) {
		return nil, Invalid("%s must be a whole number", field)
	}
	if n < min || n > max {
		return nil, Invalid("%s must be between %s and %s", field, jsNum(min), jsNum(max))
	}
	return &n, nil
}

// jsNum prints a number the way JavaScript's String() does for the plain cases used in messages (1000000, 0.01).
func jsNum(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }

var placeholderRe = regexp.MustCompile(`\{\{(\w+)\}\}`)

// Validate checks what the admin form sent; values equal to the default are not stored, so later improvements of the defaults
// still apply.
func Validate(role Role, input map[string]any) (Settings, error) {
	def := Defs[role]
	var out Settings
	if n, err := number(input["maxTokens"], "Max output tokens", 256, float64(MaxOutputTokens), true); err != nil {
		return out, err
	} else if n != nil && int(*n) != def.Defaults.MaxTokens {
		v := int(*n)
		out.MaxTokens = &v
	}
	if n, err := number(input["temperature"], "Temperature", 0, 2, false); err != nil {
		return out, err
	} else if n != nil {
		out.Temperature = n
	}
	if n, err := number(input["topP"], "Top-p", 0.01, 1, false); err != nil {
		return out, err
	} else if n != nil {
		out.TopP = n
	}
	if effort := input["reasoningEffort"]; effort != nil && effort != "" {
		s, ok := effort.(string)
		valid := false
		for _, e := range ReasoningEfforts {
			if ok && s == e {
				valid = true
			}
		}
		if !valid {
			return out, Invalid("Reasoning effort must be one of %s, or empty for the provider's default", strings.Join(ReasoningEfforts, ", "))
		}
		out.ReasoningEffort = s
	}
	if n, err := number(input["timeoutMinutes"], "Time limit", 1, 60, true); err != nil {
		return out, err
	} else if n != nil && int(*n) != def.Defaults.TimeoutMinutes {
		v := int(*n)
		out.TimeoutMinutes = &v
	}

	prompts := []struct {
		key, label, dflt string
		set              func(string)
	}{
		{"systemPrompt", "System prompt", def.Defaults.SystemPrompt, func(t string) { out.SystemPrompt = t }},
		{"userPrompt", "Instruction", def.Defaults.UserPrompt, func(t string) { out.UserPrompt = t }},
	}
	if def.Defaults.PicturePrompt != "" { // the job Images also tells the image model what to paint
		prompts = append(prompts, struct {
			key, label, dflt string
			set              func(string)
		}{"picturePrompt", "Instruction for the picture", def.Defaults.PicturePrompt, func(t string) { out.PicturePrompt = t }})
	}
	for _, f := range prompts {
		v, present := input[f.key]
		if !present || v == nil {
			continue
		}
		s, ok := v.(string)
		if !ok {
			return out, Invalid("%s must be text", f.label)
		}
		t := strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", "\n"), "\r", "\n")
		if JSLen(t) > 30_000 {
			return out, Invalid("%s is too long (30,000 characters at most)", f.label)
		}
		if strings.TrimSpace(t) == "" || strings.TrimSpace(t) == strings.TrimSpace(f.dflt) {
			continue // blank or unchanged = the built-in default
		}
		f.set(t)
	}
	if out.UserPrompt != "" {
		for _, p := range def.Placeholders {
			if p.Required && !strings.Contains(out.UserPrompt, "{{"+p.Name+"}}") {
				return out, Invalid("The instruction must contain {{%s}} - it is replaced by %s", p.Name, p.Meaning)
			}
		}
		known := map[string]bool{}
		var names []string
		for _, p := range def.Placeholders {
			known[p.Name] = true
			names = append(names, "{{"+p.Name+"}}")
		}
		for _, m := range placeholderRe.FindAllStringSubmatch(out.UserPrompt, -1) {
			if !known[m[1]] {
				return out, Invalid("Unknown placeholder {{%s}} (known: %s)", m[1], strings.Join(names, ", "))
			}
		}
	}
	if out.PicturePrompt != "" {
		if !strings.Contains(out.PicturePrompt, "{{plan}}") {
			return out, Invalid("The instruction for the picture must contain {{plan}} - it is replaced by the boxes and arrows of the picture, with their exact words")
		}
		for _, m := range placeholderRe.FindAllStringSubmatch(out.PicturePrompt, -1) {
			if m[1] != "plan" && m[1] != "title" {
				return out, Invalid("Unknown placeholder {{%s}} in the instruction for the picture (known: {{title}}, {{plan}})", m[1])
			}
		}
	}
	return out, nil
}
