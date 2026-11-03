// SPDX-License-Identifier: Apache-2.0

package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/lsegroup/mnemosyne/admin-go/internal/golden"
)

var (
	reUUID = regexp.MustCompile(`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)
	reTime = regexp.MustCompile(`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z`)
	reTok  = regexp.MustCompile(`"token":"[^"]+"`)
	reKey  = regexp.MustCompile(`"key":"[0-9a-f]{64}"`)
	rePull = regexp.MustCompile(`"modelsPulledAt":\d+`)
	reAt   = regexp.MustCompile(`"ip":"[^"]*"`)
	reHost = regexp.MustCompile(`http://127\.0\.0\.1:\d+`)
)

// mask removes what differs between two runs of the same story: ids, times, tokens, the address of the fake provider.
func mask(raw []byte, llmURL string) any {
	s := strings.ReplaceAll(string(raw), llmURL, "<llm>")
	s = reHost.ReplaceAllString(s, "<origin>")
	s = reUUID.ReplaceAllString(s, "<id>")
	s = reTime.ReplaceAllString(s, "<time>")
	s = reTok.ReplaceAllString(s, `"token":"<token>"`)
	s = reKey.ReplaceAllString(s, `"key":"<key>"`)
	s = rePull.ReplaceAllString(s, `"modelsPulledAt":1`)
	s = reAt.ReplaceAllString(s, `"ip":"<ip>"`)
	var out any
	if err := json.Unmarshal([]byte(s), &out); err != nil {
		return s
	}
	return out
}

type nodeAnswer struct {
	Status int             `json:"status"`
	Body   json.RawMessage `json:"body"`
}

// runNodeAdminStory plays the story against a Node build that still has the old admin (record mode only).
func runNodeAdminStory(t *testing.T) []byte {
	t.Helper()
	root, _ := filepath.Abs(filepath.Join("..", ".."))
	dist := os.Getenv("MNEMOSYNE_NODE_DIST")
	if dist == "" {
		t.Fatal("recording needs MNEMOSYNE_NODE_DIST: a Node build that still has the old admin")
	}
	bin, err := exec.LookPath("node")
	if err != nil {
		t.Fatal("node is not installed")
	}
	cmd := exec.Command(bin, filepath.Join(root, "testdata", "gen", "api.mjs"), t.TempDir())
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

// TestTheAdminAPIAnswersTheBrowserPageLikeTheOldNodeAdminDid plays one story (connect a provider, fetch its models, set the jobs, pin an
// address, change the SSO, set up and switch Auto, refuse bad input) against the Go admin and compares every answer with what the old Node
// admin answered (recorded from its last build, testdata/golden): the admin page is that page, so the Go server must send what it expects.
func TestTheAdminAPIAnswersTheBrowserPageLikeTheOldNodeAdminDid(t *testing.T) {
	outRaw := golden.Bytes(t, "admin-api.json", func() []byte { return runNodeAdminStory(t) })
	var node struct {
		LLM string                `json:"llm"`
		Out map[string]nodeAnswer `json:"out"`
	}
	if err := json.Unmarshal(outRaw, &node); err != nil {
		t.Fatal(err)
	}

	// the same story in Go
	h := newHarness(t, withLocal(map[string]string{"MNEMOSYNE_GITLAB_URL": "https://gitlab.example.com", "MNEMOSYNE_GITLAB_CLIENT_ID": "cid", "MNEMOSYNE_GITLAB_CLIENT_SECRET": "csecret-value-0123456789"}))
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/models" {
			_, _ = w.Write([]byte(`{"data":[{"id":"muse-spark-1.3-contributor"},{"id":"models/other-model"}]}`))
			return
		}
		w.WriteHeader(404)
	}))
	defer provider.Close()
	writeNote(t, h.dir, "alpha", "alpha-one", "2026-10-20", "Alpha runs on :3000.")
	writeNote(t, h.dir, "alpha", "alpha-two", "2026-10-21", "More about alpha.")
	writeNote(t, h.dir, "beta", "beta-one", "2026-10-22", "Beta.")
	cookie, _ := h.localCookie("Admin", "correct horse")

	got := map[string]reply{}
	step := func(name, method, path, body string) reply {
		r := h.api(cookie, method, path, body)
		got[name] = r
		return r
	}
	create := step("create provider", "POST", "/providers", `{"label":"Fake LLM","kind":"openai-compatible","baseUrl":"`+provider.URL+`/v1/","apiKey":"sk-test-key-1234567890"}`)
	id := create.json(t)["id"].(string)
	q := func(s string) string { return `"` + s + `"` }
	step("models", "POST", "/providers/"+id+"/models", "")
	step("list", "GET", "/providers", "")
	step("job text", "PUT", "/llm/jobs/text", `{"model":{"providerId":`+q(id)+`,"model":"muse-spark-1.3-contributor"},"maxTokens":12345,"temperature":0.2,"reasoningEffort":"low","timeoutMinutes":7,"userPrompt":"Write about {{project}}:\n{{notes}}"}`)
	step("job image", "PUT", "/llm/jobs/image", `{"model":{"providerId":`+q(id)+`,"model":"other-model"},"topP":0.9}`)
	step("jobs", "GET", "/llm/jobs", "")
	step("assignments", "PUT", "/llm/assignments", `{"text":{"providerId":`+q(id)+`,"model":"muse-spark-1.3-contributor"}}`)
	step("hosts", "PUT", "/llm/hosts", `{"hosts":[{"host":"API.example.com.","ip":"203.0.113.9"}]}`)
	step("hosts get", "GET", "/llm/hosts", "")
	step("settings", "GET", "/settings", "")
	step("settings put", "PUT", "/settings", `{"gitlabUrl":"https://gl.example.org/","clientId":"app-id","clientSecret":"a-long-secret-value-0123456789"}`)
	step("settings after", "GET", "/settings", "")
	step("auto", "GET", "/auto", "")
	plan := `{"config":{"schedule":{"mode":"weekly","days":[1,3,5],"time":"02:00","tz":"Europe/Zurich"},"projects":["beta","alpha"],"text":true,"charts":true,"limitUsd":1.5}`
	est := step("estimate", "POST", "/auto/estimate", plan+`}`)
	step("save", "PUT", "/auto", plan+`,"token":`+q(est.json(t)["token"].(string))+`}`)
	step("status", "GET", "/auto/status", "")
	step("switch off", "PUT", "/auto/switch", `{"enabled":false}`)
	step("switch on", "PUT", "/auto/switch", `{"enabled":true}`)
	step("refusal", "PUT", "/llm/jobs/text", `{"maxTokens":"many"}`)
	step("audit", "GET", "/audit", "")

	var names []string
	for n := range node.Out {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, name := range names {
		w, g := node.Out[name], got[name]
		if g.status != w.Status {
			t.Errorf("%s: status %d, Node %d\n Go:   %.300s\n Node: %.300s", name, g.status, w.Status, g.body, w.Body)
			continue
		}
		wantV, gotV := mask(w.Body, node.LLM), mask([]byte(g.body), provider.URL)
		// the audit trail of the Go story has one more entry (the sign-in), and the server clocks differ: compare what was written, not when
		if name == "audit" {
			wantV, gotV = auditStory(wantV), auditStory(gotV)
		}
		if !reflect.DeepEqual(gotV, wantV) {
			gj, _ := json.MarshalIndent(gotV, "", " ")
			wj, _ := json.MarshalIndent(wantV, "", " ")
			t.Errorf("%s: the answers differ\n--- Go\n%.1800s\n--- Node\n%.1800s", name, gj, wj)
		}
	}
}

// auditStory keeps what the story wrote: event, what it was about, the changes and the words (the sign-in and the times are not compared).
func auditStory(v any) any {
	m, ok := v.(map[string]any)
	if !ok {
		return v
	}
	var out []any
	for _, e := range m["events"].([]any) {
		ev := e.(map[string]any)
		if ev["event"] == "login" {
			continue
		}
		out = append(out, map[string]any{"event": ev["event"], "entityType": ev["entityType"], "entityName": ev["entityName"], "user": ev["user"], "changes": ev["changes"], "description": ev["description"]})
	}
	return map[string]any{"events": out, "total": len(out)}
}
