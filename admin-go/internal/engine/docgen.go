// SPDX-License-Identifier: Apache-2.0

package engine

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// ---- price list (US dollars per million tokens): what a call costs is counted from the tokens the provider reports ---------------

// Price is the list price of a model.
type Price struct{ In, Out float64 }

// Prices is Meta's published list prices; a model that is not here has no known price.
var Prices = map[string]Price{
	"muse-spark-1.3":             {1.25, 4.25},
	"muse-spark-1.2":             {1.25, 4.25},
	"muse-spark-1.3-contributor": {0.1, 0.2},
	"muse-wonder-1.0":            {4.0, 20.0},
}

// ApproxTokens is the rough token count of a text of this many characters.
func ApproxTokens(chars int) int { return int(math.Ceil(float64(chars) / 4)) }

// EstimateUSD is what a call of this size costs; ok is false when the model has no list price.
func EstimateUSD(model string, inputTokens, outputTokens int) (usd float64, ok bool) {
	p, known := Prices[model]
	if !known {
		return 0, false
	}
	return (float64(inputTokens)*p.In + float64(outputTokens)*p.Out) / 1_000_000, true
}

// ---- prompts --------------------------------------------------------------------------------------------------------------

// maxNoteChars is about 750k tokens: stays inside a 1M-token context.
const maxNoteChars = 3_000_000

// Templates are the prompts an administrator set; an empty value means the built-in default.
type Templates struct{ System, User string }

// WikiPrompt is what the AI is asked to write a project's page.
type WikiPrompt struct {
	System, User string
	NoteCount    int
	InputTokens  int
}

var placeholderRe = regexp.MustCompile(`\{\{(\w+)\}\}`)

// FillTemplate replaces {{name}} placeholders; values are inserted as they are and never scanned again.
func FillTemplate(tpl string, vars map[string]string) string {
	return placeholderRe.ReplaceAllStringFunc(tpl, func(m string) string {
		if v, ok := vars[m[2:len(m)-2]]; ok {
			return v
		}
		return m
	})
}

func orDefault(custom, dflt string) string {
	if JSTrim(custom) != "" {
		return custom
	}
	return dflt
}

// BuildWikiPrompt writes the prompt from a project's notes, newest first; the notes are masked (credentials) before they leave this server.
func BuildWikiPrompt(project, gitlabName string, notes []Note, tpl Templates, defaults Templates) WikiPrompt {
	ordered := append([]Note{}, notes...)
	date := func(n Note) string {
		if n.ObservedAt == nil {
			return ""
		}
		return *n.ObservedAt
	}
	sort.SliceStable(ordered, func(i, j int) bool { return date(ordered[i]) > date(ordered[j]) })
	used := 0
	var parts []string
	for _, n := range ordered {
		observed := "unknown"
		if n.ObservedAt != nil {
			observed = *n.ObservedAt
		}
		lines := []string{
			"### NOTE " + n.ID,
			"title: " + n.Title,
			fmt.Sprintf("type: %s   status: %s   observed: %s", n.Type, n.Status, observed),
		}
		if len(n.Components) > 0 {
			lines = append(lines, "components: "+strings.Join(n.Components, ", "))
		}
		lines = append(lines, "", Redact(n.Body))
		var kept []string
		for _, l := range lines {
			if l != "" {
				kept = append(kept, l)
			}
		}
		block := strings.Join(kept, "\n")
		if used+JSLen(block) > maxNoteChars {
			break
		}
		used += JSLen(block)
		parts = append(parts, block)
	}
	system := orDefault(tpl.System, defaults.System)
	name := project
	if gitlabName != "" {
		name = gitlabName
	}
	user := FillTemplate(orDefault(tpl.User, defaults.User), map[string]string{"project": name, "notes_count": fmt.Sprint(len(parts)), "notes": strings.Join(parts, "\n\n")})
	return WikiPrompt{System: system, User: user, NoteCount: len(parts), InputTokens: ApproxTokens(JSLen(system) + JSLen(user))}
}

// BuildDiagramPlanPrompt asks for the plan of the architecture diagrams (data only; Mnemosyne draws the pictures).
func BuildDiagramPlanPrompt(project, article string, tpl Templates, defaults Templates) (system, user string) {
	cut := article
	if u := []rune(article); len(u) > 60_000 { // 60,000 UTF-16 units; the articles are BMP text
		cut = string(u[:60_000])
	}
	return orDefault(tpl.System, defaults.System), FillTemplate(orDefault(tpl.User, defaults.User), map[string]string{"project": project, "article": cut})
}

var sectionChecks = []struct {
	name string
	re   *regexp.Regexp
}{
	{"Features and how it works", regexp.MustCompile(`(?im)^##\s+Features and how it works\b`)},
	{"Specifications", regexp.MustCompile(`(?im)^##\s+Specifications\b`)},
	{"Hardware and software requirements", regexp.MustCompile(`(?im)^##\s+Hardware and software requirements\b`)},
	{"Disaster recovery", regexp.MustCompile(`(?im)^##\s+Disaster recovery\b`)},
	{"Installation / rebuild steps", regexp.MustCompile(`(?im)^###\s+Installation`)},
	{"Access", regexp.MustCompile(`(?im)^###\s+Access\b`)},
	{"Testing and verification", regexp.MustCompile(`(?im)^###\s+Testing`)},
}

// MissingSections lists the sections the owner's layout requires that the AI left out.
func MissingSections(markdown string) []string {
	var out []string
	for _, c := range sectionChecks {
		if !c.re.MatchString(markdown) {
			out = append(out, c.name)
		}
	}
	return out
}

// ---- the document store -----------------------------------------------------------------------------------------------------

// DocMeta describes one stored document (the article, the diagram, the PDF) next to its file.
type DocMeta struct {
	Kind         string            `json:"kind"`
	ID           string            `json:"id"`
	GeneratedAt  string            `json:"generatedAt"`
	Project      string            `json:"project"`
	Model        string            `json:"model"`
	By           string            `json:"by"`
	NoteCount    *int              `json:"noteCount,omitempty"`
	NoteHashes   map[string]string `json:"noteHashes,omitempty"`
	InputTokens  *int              `json:"inputTokens,omitempty"`
	OutputTokens *int              `json:"outputTokens,omitempty"`
	BasedOn      string            `json:"basedOn,omitempty"`
	Diagram      string            `json:"diagram,omitempty"`
	Plan         *DiagramPlan      `json:"plan,omitempty"`
	Pictures     []Picture         `json:"pictures,omitempty"`
	Ext          string            `json:"ext"`
}

// Stamp is the compact UTC timestamp that is also the version id: 20261029T170500Z.
func Stamp(t time.Time) string { return t.UTC().Format("20060102T150405Z") }

var unsafeName = regexp.MustCompile(`(?i)[^a-z0-9._-]`)

func safeName(s string) string {
	if out := strings.ToLower(unsafeName.ReplaceAllString(s, "-")); out != "" {
		return out
	}
	return "misc"
}

// DocStore keeps every generated artefact with its date stamp, so earlier versions stay available.
type DocStore struct {
	root string
	now  func() time.Time
}

// NewDocStore stores under root.
func NewDocStore(root string) *DocStore { return &DocStore{root: root, now: time.Now} }

func (s *DocStore) dir(project string) string { return filepath.Join(s.root, safeName(project)) }

// Save writes the document and its description and returns the description.
func (s *DocStore) Save(meta DocMeta, content []byte) (DocMeta, error) {
	now := s.now().UTC()
	if meta.ID == "" {
		meta.ID = Stamp(now)
	}
	meta.GeneratedAt = now.Format("2006-01-02T15:04:05.000Z")
	dir := s.dir(meta.Project)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return meta, err
	}
	base := filepath.Join(dir, meta.Kind+"-"+meta.ID)
	if err := os.WriteFile(base+"."+meta.Ext, content, 0o640); err != nil {
		return meta, err
	}
	return meta, os.WriteFile(base+".json", []byte(JSONIndent(meta)), 0o640)
}

// SaveExtra writes the file of one more picture of a diagram set (diagram-<id>-<n>.<ext>); the set's own Save comes last and makes it count.
func (s *DocStore) SaveExtra(project, kind, id string, n int, ext string, content []byte) error {
	if err := os.MkdirAll(s.dir(project), 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(s.dir(project), fmt.Sprintf("%s-%s-%d.%s", kind, id, n, ext)), content, 0o640)
}

var reExt = regexp.MustCompile(`^[a-z0-9]{2,5}$`)

// ReadExtra is the stored file of picture n (1 = the first detail picture) of a set the image model painted; nil when there is none.
func (s *DocStore) ReadExtra(m DocMeta, n int) ([]byte, error) {
	if n < 1 || n > len(m.Pictures) || !reExt.MatchString(m.Pictures[n-1].Ext) {
		return nil, nil
	}
	return os.ReadFile(filepath.Join(s.dir(m.Project), fmt.Sprintf("%s-%s-%d.%s", m.Kind, m.ID, n, m.Pictures[n-1].Ext)))
}

// PruneDiagrams deletes every diagram of the project except the set with this id (its detail pictures and the picture-* files an earlier build
// kept included): a new diagram replaces everything the project had before. Only call it after the new set was saved completely. It returns
// how many files were removed.
func (s *DocStore) PruneDiagrams(project, keepID string) int {
	entries, err := os.ReadDir(s.dir(project))
	if err != nil {
		return 0
	}
	removed := 0
	for _, e := range entries {
		n := e.Name()
		old := strings.HasPrefix(n, "picture-") ||
			(strings.HasPrefix(n, "diagram-") && n != "diagram-"+keepID && !strings.HasPrefix(n, "diagram-"+keepID+".") && !strings.HasPrefix(n, "diagram-"+keepID+"-"))
		if old && os.Remove(filepath.Join(s.dir(project), n)) == nil {
			removed++
		}
	}
	return removed
}

// List returns the documents of a kind, newest first.
func (s *DocStore) List(project, kind string) []DocMeta {
	entries, err := os.ReadDir(s.dir(project))
	if err != nil {
		return nil
	}
	var metas []DocMeta
	for _, e := range entries {
		if !strings.HasPrefix(e.Name(), kind+"-") || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(s.dir(project), e.Name()))
		if err != nil {
			continue
		}
		var m DocMeta
		if json.Unmarshal(raw, &m) == nil {
			metas = append(metas, m)
		}
	}
	sort.SliceStable(metas, func(i, j int) bool { return metas[i].GeneratedAt > metas[j].GeneratedAt })
	return metas
}

// Latest is the newest document of a kind, or nil.
func (s *DocStore) Latest(project, kind string) *DocMeta {
	if l := s.List(project, kind); len(l) > 0 {
		return &l[0]
	}
	return nil
}

// Read returns the document itself.
func (s *DocStore) Read(m DocMeta) ([]byte, error) {
	return os.ReadFile(filepath.Join(s.dir(m.Project), m.Kind+"-"+m.ID+"."+m.Ext))
}
