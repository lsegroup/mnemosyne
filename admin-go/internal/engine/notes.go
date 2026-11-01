package engine

import (
	"crypto/sha256"
	"encoding/hex"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"

	"gopkg.in/yaml.v3"
)

// Note is one memory node: a markdown file with YAML front matter under nodes/<project>/<id>.md.
type Note struct {
	ID         string
	Title      string
	Type       string
	Status     string
	Project    string
	Components []string
	ObservedAt *string
	Body       string
}

type frontMatter struct {
	ID         string   `yaml:"id"`
	Title      string   `yaml:"title"`
	Type       string   `yaml:"type"`
	Status     string   `yaml:"status"`
	Project    string   `yaml:"project"`
	Components []string `yaml:"components"`
	ObservedAt *string  `yaml:"observed_at"`
}

// ParseNote reads one note file the way the Node server does: front matter between two --- lines, the rest is the body (trimmed).
func ParseNote(raw string) (Note, bool) {
	raw = strings.TrimPrefix(raw, string(rune(0xFEFF)))
	if !strings.HasPrefix(raw, "---") {
		return Note{}, false
	}
	rest := strings.TrimPrefix(raw, "---")
	if strings.HasPrefix(rest, "-") {
		return Note{}, false
	}
	// the closing delimiter is "---" at the start of a line
	end := strings.Index(rest, "\n---")
	if end < 0 {
		return Note{}, false
	}
	var fm frontMatter
	if err := yaml.Unmarshal([]byte(rest[:end]), &fm); err != nil {
		return Note{}, false
	}
	body := rest[end+len("\n---"):]
	if i := strings.IndexByte(body, '\n'); i >= 0 {
		body = body[i+1:]
	} else {
		body = ""
	}
	if fm.ID == "" || fm.Title == "" || fm.Type == "" || fm.Project == "" {
		return Note{}, false
	}
	if fm.Status == "" {
		fm.Status = "n/a"
	}
	if fm.Components == nil {
		fm.Components = []string{}
	}
	return Note{ID: fm.ID, Title: fm.Title, Type: fm.Type, Status: fm.Status, Project: fm.Project, Components: fm.Components, ObservedAt: fm.ObservedAt, Body: JSTrim(body)}, true
}

// NoteHash is the fingerprint of everything the documentation is written from (the first 12 hex digits of a SHA-256).
func NoteHash(n Note) string {
	comps := append([]string{}, n.Components...)
	sort.Strings(comps)
	var observed any
	if n.ObservedAt != nil {
		observed = *n.ObservedAt
	}
	sum := sha256.Sum256([]byte(JSON([]any{n.ID, n.Title, n.Type, n.Status, observed, comps, n.Body})))
	return hex.EncodeToString(sum[:])[:12]
}

// NoteHashes fingerprints every note, by id.
func NoteHashes(notes []Note) map[string]string {
	out := make(map[string]string, len(notes))
	for _, n := range notes {
		out[n.ID] = NoteHash(n)
	}
	return out
}

// ProjectSummary is one project of the corpus.
type ProjectSummary struct {
	Project string
	Count   int
	Updated *string
}

// Index is the notes on disk, re-read at most every 30 seconds (hundreds of small files: reading them per request would be wasteful).
type Index struct {
	dir string
	mu  sync.Mutex
	at  time.Time
	all []Note
	now func() time.Time
}

// NewIndex reads the notes under dir.
func NewIndex(dir string) *Index { return &Index{dir: dir, now: time.Now} }

// All returns every note, in directory order (sorted by name, like the Node server reads them).
func (x *Index) All() []Note {
	x.mu.Lock()
	defer x.mu.Unlock()
	if x.all != nil && x.now().Sub(x.at) < 30*time.Second {
		return x.all
	}
	var notes []Note
	if err := walk(x.dir, &notes); err != nil {
		log.Printf("docs: could not read notes: %v", err)
		if x.all != nil {
			return x.all
		}
	}
	if notes == nil {
		notes = []Note{}
	}
	x.all, x.at = notes, x.now()
	return x.all
}

func walk(dir string, out *[]Note) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	for _, e := range entries {
		full := filepath.Join(dir, e.Name())
		switch {
		case e.IsDir():
			if err := walk(full, out); err != nil {
				return err
			}
		case e.Type().IsRegular() && strings.HasSuffix(e.Name(), ".md"):
			raw, err := os.ReadFile(full)
			if err != nil {
				return err
			}
			if n, ok := ParseNote(string(raw)); ok {
				*out = append(*out, n)
			} else {
				log.Printf("docs: %s is not a valid note, left out", full)
			}
		}
	}
	return nil
}

// Projects lists the projects with their note count and the date of the newest note, sorted by name.
func (x *Index) Projects() []ProjectSummary {
	by := map[string]*ProjectSummary{}
	var order []string
	for _, n := range x.All() {
		s := by[n.Project]
		if s == nil {
			s = &ProjectSummary{Project: n.Project}
			by[n.Project] = s
			order = append(order, n.Project)
		}
		s.Count++
		if n.ObservedAt != nil && (s.Updated == nil || *n.ObservedAt > *s.Updated) {
			d := *n.ObservedAt
			s.Updated = &d
		}
	}
	out := make([]ProjectSummary, 0, len(order))
	for _, p := range order {
		out = append(out, *by[p])
	}
	sort.SliceStable(out, func(i, j int) bool { return LocaleCompare(out[i].Project, out[j].Project) < 0 })
	return out
}

// InProject returns the notes of one project.
func (x *Index) InProject(project string) []Note {
	var out []Note
	for _, n := range x.All() {
		if n.Project == project {
			out = append(out, n)
		}
	}
	return out
}

// LocaleCompare orders names the way String.prototype.localeCompare does for the names used here: punctuation before digits before
// letters, letters without regard to case (lower case first when two names differ only in case).
func LocaleCompare(a, b string) int {
	ra, rb := []rune(a), []rune(b)
	for i := 0; i < len(ra) && i < len(rb); i++ {
		ka, kb := collationKey(ra[i]), collationKey(rb[i])
		if ka != kb {
			if ka < kb {
				return -1
			}
			return 1
		}
	}
	if len(ra) != len(rb) {
		if len(ra) < len(rb) {
			return -1
		}
		return 1
	}
	for i := range ra {
		if ra[i] != rb[i] {
			if unicode.IsLower(ra[i]) {
				return -1
			}
			return 1
		}
	}
	return 0
}

// punctuationOrder is the order of the common punctuation in the Unicode collation: white space, then _ - , ; : ! ? . ' " ( ) [ ] { } @ * / \ & # % ` ^ + < = > | ~ $.
const punctuationOrder = " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$"

func collationKey(r rune) int {
	switch {
	case unicode.IsLetter(r):
		return 1000 + int(unicode.ToLower(r))
	case unicode.IsDigit(r):
		return 500 + int(r-'0')
	}
	if i := strings.IndexRune(punctuationOrder, r); i >= 0 {
		return i + 1
	}
	return 100 + int(r)
}
