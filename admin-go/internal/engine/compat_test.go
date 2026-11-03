package engine

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/lsegroup/mnemosyne/admin-go/internal/jobs"
)

func nodeRun(t *testing.T, args ...string) []byte {
	t.Helper()
	root, _ := filepath.Abs(filepath.Join("..", ".."))
	dist := os.Getenv("MNEMOSYNE_NODE_DIST")
	if dist == "" {
		dist = filepath.Join(root, "..", "packages", "server", "dist")
	}
	if _, err := os.Stat(filepath.Join(dist, "diagram.js")); err != nil {
		t.Skip("the Node build is not at hand (set MNEMOSYNE_NODE_DIST)")
	}
	bin, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	cmd := exec.Command(bin, append([]string{filepath.Join(root, "testdata", "gen", "engine.mjs")}, args...)...)
	cmd.Env = append(os.Environ(), "MNEMOSYNE_NODE_DIST="+dist)
	out, err := cmd.Output()
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			t.Fatalf("node %v: %v\n%s", args, err, ee.Stderr)
		}
		t.Fatal(err)
	}
	return out
}

// ---- the corpus ---------------------------------------------------------------------------------------------------------------

func TestTheNotesTheirFingerprintsTheMaskingAndThePromptsAreTheNodeServers(t *testing.T) {
	root, _ := filepath.Abs(filepath.Join("..", ".."))
	nodes := filepath.Join(root, "..", "nodes")
	if _, err := os.Stat(nodes); err != nil {
		t.Skip("the notes corpus is not at hand")
	}
	var want struct {
		Count    int `json:"count"`
		Projects []struct {
			Project string  `json:"project"`
			Count   int     `json:"count"`
			Updated *string `json:"updated"`
		} `json:"projects"`
		Notes []struct {
			ID         string   `json:"id"`
			Project    string   `json:"project"`
			Title      string   `json:"title"`
			ObservedAt *string  `json:"observed_at"`
			Components []string `json:"components"`
			Hash       string   `json:"hash"`
			BodyLen    int      `json:"bodyLen"`
			Redacted   string   `json:"redacted"`
		} `json:"notes"`
		Prompts map[string]struct {
			System      string `json:"system"`
			User        string `json:"user"`
			NoteCount   int    `json:"noteCount"`
			InputTokens int    `json:"inputTokens"`
		} `json:"prompts"`
		Order []string `json:"order"`
	}
	if err := json.Unmarshal(nodeRun(t, "corpus", nodes), &want); err != nil {
		t.Fatal(err)
	}

	idx := NewIndex(nodes)
	got := idx.All()
	if len(got) != want.Count || want.Count < 100 {
		t.Fatalf("Go reads %d notes, Node %d", len(got), want.Count)
	}
	bad := 0
	for i, n := range got {
		w := want.Notes[i]
		switch {
		case n.ID != w.ID || want.Order[i] != n.ID:
			t.Fatalf("note %d: order differs (%s, Node %s)", i, n.ID, w.ID)
		case n.Project != w.Project || n.Title != w.Title || !reflect.DeepEqual(n.ObservedAt, w.ObservedAt) || !reflect.DeepEqual(n.Components, w.Components):
			t.Errorf("%s: front matter differs: %+v vs %+v", n.ID, n, w)
			bad++
		case JSLen(n.Body) != w.BodyLen:
			t.Errorf("%s: body length %d, Node %d", n.ID, JSLen(n.Body), w.BodyLen)
			bad++
		case NoteHash(n) != w.Hash:
			t.Errorf("%s: fingerprint %s, Node %s", n.ID, NoteHash(n), w.Hash)
			bad++
		case Redact(n.Body) != w.Redacted:
			t.Errorf("%s: masked text differs", n.ID)
			bad++
		}
		if bad > 5 {
			t.Fatal("too many differences")
		}
	}

	projects := idx.Projects()
	if len(projects) != len(want.Projects) {
		t.Fatalf("projects: %d, Node %d", len(projects), len(want.Projects))
	}
	for i, p := range projects {
		w := want.Projects[i]
		if p.Project != w.Project || p.Count != w.Count || !reflect.DeepEqual(p.Updated, w.Updated) {
			t.Errorf("project %d: %+v, Node %+v", i, p, w)
		}
	}

	d := jobs.Defs[jobs.Text].Defaults
	for project, w := range want.Prompts {
		p := BuildWikiPrompt(project, "", idx.InProject(project), Templates{}, Templates{System: d.SystemPrompt, User: d.UserPrompt})
		if p.System != w.System || p.User != w.User || p.NoteCount != w.NoteCount || p.InputTokens != w.InputTokens {
			t.Errorf("prompt of %s differs (notes %d/%d, tokens %d/%d, user equal %v)", project, p.NoteCount, w.NoteCount, p.InputTokens, w.InputTokens, p.User == w.User)
		}
	}
}

// ---- the diagrams ---------------------------------------------------------------------------------------------------------------

func answers() []string {
	simple := `{"title":"Shop","diagrams":[{"name":"Overview","columns":[
	  {"title":"clients","nodes":[{"id":"u","label":"Browser","detail":"HTTPS :443"}]},
	  {"title":"app","nodes":[{"id":"a","label":"Web app","detail":"Node 22, port 3000"},{"id":"b","label":"Worker"}]},
	  {"title":"data","nodes":[{"id":"d","label":"PostgreSQL","detail":"orders and users"}]}],
	 "links":[{"from":"u","to":"a","label":"HTTPS"},{"from":"a","to":"d","label":"SQL :5432"},{"from":"b","to":"d","label":"SQL"},{"from":"a","to":"b","label":"queue"}]}]}`

	control := `{"title":"Platform → “core” é","diagrams":[{"name":"Overview","columns":[
	  {"title":"CLIENTS","nodes":[{"id":"n1","label":"VS Code","detail":"MCP client","lane":"path"},{"id":"n2","label":"Admin browser","lane":"path"}]},
	  {"title":"ENTRY","nodes":[{"id":"n3","label":"nginx","detail":"TLS 1.3, VRRP failover, password: hunter2hunter2","lane":"path"},{"id":"n4","label":"GitLab SSO","detail":"OAuth sign-in","lane":"control"}]},
	  {"title":"SERVICES","nodes":[{"id":"n5","label":"Mnemosyne server with a really long name that has to wrap over lines","detail":"MCP and REST on :40001, a long detail text that needs several lines to be written out in full","lane":"path"},{"id":"n6","label":"Indexer","lane":"path"},{"id":"n7","label":"Audit log","lane":"control"}]},
	  {"title":"STORAGE","nodes":[{"id":"n8","label":"Git repo","detail":"nodes/*.md","lane":"path"},{"id":"n9","label":"SQLite","detail":"FTS5 + vec","lane":"path"}]}],
	 "links":[{"from":"n1","to":"n3","label":"MCP over HTTPS :40000"},{"from":"n2","to":"n3","label":"HTTPS"},{"from":"n3","to":"n5","label":"proxy"},{"from":"n5","to":"n6"},{"from":"n6","to":"n9","label":"index"},{"from":"n5","to":"n8","label":"git commit"},{"from":"n4","to":"n5","label":"sign-in"},{"from":"n5","to":"n7","label":"events"},{"from":"n1","to":"n5","label":"direct, skipping the entry layer"},{"from":"n2","to":"n9","label":"never"}]},
	 {"name":"Data and storage","columns":[{"title":"APP","nodes":[{"id":"a","label":"Server"},{"id":"b","label":"Indexer"},{"id":"c","label":"Writer"}]},{"title":"DATA","nodes":[{"id":"d","label":"Git"},{"id":"e","label":"SQLite"}]}],
	 "links":[{"from":"a","to":"d","label":"reads"},{"from":"c","to":"d","label":"writes"},{"from":"b","to":"e"},{"from":"a","to":"c","label":"calls"},{"from":"a","to":"b","label":"index"}]}]}`

	gutter := `{"title":"Stack","diagrams":[{"name":"Overview","columns":[
	  {"title":"A","nodes":[{"id":"a1","label":"One"},{"id":"a2","label":"Two"},{"id":"a3","label":"Three"}]},
	  {"title":"B","nodes":[{"id":"b1","label":"Four"},{"id":"b2","label":"Five"}]},
	  {"title":"C","nodes":[{"id":"c1","label":"Six","lane":"control"},{"id":"c2","label":"Seven","lane":"path"}]},
	  {"title":"D","nodes":[{"id":"d1","label":"Eight"}]}],
	 "links":[{"from":"a1","to":"a3","label":"around the middle one"},{"from":"a1","to":"b1","label":"x"},{"from":"a2","to":"b2"},{"from":"a3","to":"b2","label":"y"},{"from":"b1","to":"c2","label":"to seven"},{"from":"c1","to":"c2","label":"vertical, labelled"},{"from":"a1","to":"d1","label":"skip over everything"},{"from":"b2","to":"c1","label":"cross"},{"from":"d1","to":"b1","label":"back"}]}]}`

	messy := "```json\n" + `{"title":"","diagrams":[
	 {"title":"Dup ids","columns":[{"title":"c","nodes":[{"id":"X","label":"One"},{"id":"x","label":"Two"},{"id":42,"label":"Number id"},{"name":"Via name","description":"from description"},{"label":"","detail":"no label"},{"label":"Odd lane","lane":"CONTROL"}]},
	   {"title":"d","nodes":[{"id":"y","label":"Three","lane":"banana"}]},{"nodes":"not a list"},"not an object"],
	  "links":[{"from":"X","to":"x","label":"same"},{"from":"X","to":"x","label":"same"},{"from":"X","to":"nope","label":"unknown"},{"from":"y","to":"y"},{"from":"x","to":"y","dashed":true,"label":"` + strings.Repeat("long ", 20) + `"}]},
	 {"name":"Too small","columns":[{"nodes":[{"label":"alone"}]}],"links":[]},
	 {"name":"No arrows","columns":[{"nodes":[{"label":"a"},{"label":"b"}]}],"links":[]},
	 {"name":"p4","columns":[{"nodes":[{"id":"1","label":"a"}]},{"nodes":[{"id":"2","label":"b"}]}],"links":[{"from":"1","to":"2"}]},
	 {"name":"p5","columns":[{"nodes":[{"id":"1","label":"a"}]},{"nodes":[{"id":"2","label":"b"}]}],"links":[{"from":"1","to":"2"}]},
	 {"name":"p6","columns":[{"nodes":[{"id":"1","label":"a"}]},{"nodes":[{"id":"2","label":"b"}]}],"links":[{"from":"1","to":"2"}]},
	 {"name":"p7","columns":[{"nodes":[{"id":"1","label":"a"}]},{"nodes":[{"id":"2","label":"b"}]}],"links":[{"from":"1","to":"2"}]}]}` + "\n```"

	var many strings.Builder
	many.WriteString(`{"title":"Many","diagrams":[{"name":"Overview","columns":[`)
	for c := 0; c < 10; c++ {
		if c > 0 {
			many.WriteString(",")
		}
		many.WriteString(`{"title":"column ` + string(rune('A'+c)) + `","nodes":[`)
		for n := 0; n < 4; n++ {
			if n > 0 {
				many.WriteString(",")
			}
			many.WriteString(`{"id":"` + string(rune('a'+c)) + string(rune('0'+n)) + `","label":"Box ` + string(rune('A'+c)) + string(rune('0'+n)) + `","detail":"detail ` + string(rune('0'+n)) + `"}`)
		}
		many.WriteString(`]}`)
	}
	many.WriteString(`],"links":[{"from":"a0","to":"b0"},{"from":"b1","to":"c1"},{"from":"c2","to":"d2"}]}]}`)

	legacy := `{"title":"Legacy","columns":[{"title":"in","nodes":[{"id":"a","label":"Client"}]},{"title":"out","nodes":[{"id":"b","label":"Server"}]}],"links":[{"from":"a","to":"b","label":"HTTP"}]}`
	return []string{simple, control, gutter, messy, many.String(), legacy, "no json here at all", `{"unrelated": true}`, `{"diagrams":[{"columns":[{"nodes":[{"label":"a"},{"label":"b"}]}]}]}`, `[1,2,3]`, `{"title": "broken", "diagrams": [`}
}

func TestTheDiagramsAreReadLaidOutAndDrawnLikeTheNodeServerDoes(t *testing.T) {
	in := answers()
	file := filepath.Join(t.TempDir(), "answers.json")
	raw, _ := json.Marshal(in)
	if err := os.WriteFile(file, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	var want []struct {
		OK    bool            `json:"ok"`
		Error string          `json:"error"`
		Set   json.RawMessage `json:"set"`
		SVGs  []string        `json:"svgs"`
	}
	if err := json.Unmarshal(nodeRun(t, "diagrams", file), &want); err != nil {
		t.Fatal(err)
	}
	for i, answer := range in {
		w := want[i]
		set, err := ParsePlanSet(answer, "My Project")
		if !w.OK {
			if err == nil {
				t.Errorf("answer %d: Node refuses (%s), Go accepts", i, w.Error)
			} else if !strings.HasPrefix(w.Error, strings.SplitN(err.Error(), " (", 2)[0]) && !strings.Contains(w.Error, strings.SplitN(err.Error(), " (", 2)[0]) {
				t.Errorf("answer %d: refused differently:\n Go:   %s\n Node: %s", i, err, w.Error)
			}
			continue
		}
		if err != nil {
			t.Errorf("answer %d: Go refuses (%v), Node accepts", i, err)
			continue
		}
		var wantSet, gotSet any
		_ = json.Unmarshal(w.Set, &wantSet)
		gotRaw, _ := json.Marshal(struct {
			Title    string    `json:"title"`
			Pictures []Picture `json:"pictures"`
			Dropped  []string  `json:"dropped"`
		}{set.Title, set.Pictures, set.Dropped})
		_ = json.Unmarshal(gotRaw, &gotSet)
		if !reflect.DeepEqual(gotSet, wantSet) {
			t.Errorf("answer %d: the plans differ\n Go:   %s\n Node: %s", i, gotRaw, w.Set)
			continue
		}
		for p, pic := range set.Pictures {
			svg := RenderSVG(Layout(pic.Plan), pic.Plan)
			if svg != w.SVGs[p] {
				a, b := svg, w.SVGs[p]
				at := 0
				for at < len(a) && at < len(b) && a[at] == b[at] {
					at++
				}
				from := max(0, at-120)
				t.Errorf("answer %d picture %d (%s): the SVG differs at byte %d\n Go:   …%s\n Node: …%s", i, p, pic.Name, at, a[from:min(len(a), at+160)], b[from:min(len(b), at+160)])
			}
		}
	}
}
