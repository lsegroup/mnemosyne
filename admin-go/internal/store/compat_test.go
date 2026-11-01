package store

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"gitlab.globalclouddata.org/gcd-group/mnemosyne-admin/internal/jobs"
	"gitlab.globalclouddata.org/gcd-group/mnemosyne-admin/internal/secrets"
)

const secret = "a-test-secret-with-enough-length"

// node runs testdata/gen/stores.mjs against the real Node code; the test is skipped where Node or its build is not at hand.
func node(t *testing.T, mode, dir string) []byte {
	t.Helper()
	root, _ := filepath.Abs(filepath.Join("..", ".."))
	dist := os.Getenv("MNEMOSYNE_NODE_DIST")
	if dist == "" {
		dist = filepath.Join(root, "..", "packages", "server", "dist")
	}
	if _, err := os.Stat(filepath.Join(dist, "provider-store.js")); err != nil {
		t.Skip("the Node build is not at hand (set MNEMOSYNE_NODE_DIST)")
	}
	bin, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	cmd := exec.Command(bin, filepath.Join(root, "testdata", "gen", "stores.mjs"), mode, dir, secret)
	cmd.Env = append(os.Environ(), "MNEMOSYNE_NODE_DIST="+dist)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("node %s: %v\n%s", mode, err, out)
	}
	return out
}

func keys(t *testing.T) secrets.Keys {
	k, err := secrets.DeriveKeys(secret)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func TestGoReadsTheFilesTheNodeServerWrote(t *testing.T) {
	dir := t.TempDir()
	var made struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(node(t, "write", dir), &made); err != nil {
		t.Fatal(err)
	}
	k := keys(t)
	providers := NewProviders(filepath.Join(dir, "providers.enc"), k.Enc)

	list, err := providers.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(list.Providers) != 1 {
		t.Fatalf("providers: %+v", list.Providers)
	}
	p := list.Providers[0]
	if p.ID != made.ID || p.Label != "Node LLM" || p.Kind != OpenAICompatible || p.BaseURL != "https://api.example.com/v1" || !p.HasKey || p.KeyHint != "••••6789" || len(p.Models) != 2 || p.ModelsPulledAt == 0 {
		t.Errorf("provider: %+v", p)
	}
	if a := list.Assignments[jobs.Text]; a.ProviderID != made.ID || a.Model != "m-b" {
		t.Errorf("assignment: %+v", a)
	}
	if _, ok := list.Assignments[jobs.Image]; ok {
		t.Error("the image job has no model")
	}
	text := list.Jobs[jobs.Text]
	if text.MaxTokens == nil || *text.MaxTokens != 4242 || text.Temperature == nil || *text.Temperature != 0.3 || text.ReasoningEffort != "low" || text.TimeoutMinutes == nil || *text.TimeoutMinutes != 7 || text.UserPrompt != "Write {{notes}} now" {
		t.Errorf("job settings: %+v", text)
	}
	if e := jobs.Effect(jobs.Text, text); e.MaxTokens != 4242 || e.SystemPrompt == "" {
		t.Errorf("effective: %+v", e)
	}
	full, err := providers.Full(made.ID)
	if err != nil || full.APIKey != "sk-from-node-0123456789" {
		t.Errorf("full: %+v, %v", full, err)
	}
	if hosts, _ := providers.Hosts(); len(hosts) != 1 || hosts[0] != (HostPin{Host: "api.example.com", IP: "203.0.113.4"}) {
		t.Errorf("hosts: %+v", hosts)
	}
	assigned, model, err := providers.Assigned(jobs.Text)
	if err != nil || assigned == nil || assigned.ID != made.ID || model != "m-b" {
		t.Errorf("assigned: %+v %q %v", assigned, model, err)
	}

	st, err := NewSettings(filepath.Join(dir, "settings.enc"), k.Enc).Get()
	if err != nil || st.GitLab == nil || st.GitLab.URL != "https://gl.example.com" || st.GitLab.ClientID != "cid" || st.GitLab.ClientSecret != "csecret-from-node" || st.SSOLiveAt != 1760000000 {
		t.Errorf("settings: %+v, %v", st, err)
	}
}

func TestTheNodeServerReadsTheFilesGoWrote(t *testing.T) {
	dir := t.TempDir()
	k := keys(t)
	providers := NewProviders(filepath.Join(dir, "providers.enc"), k.Enc)
	p, err := providers.Upsert(Input{Label: "Go LLM", Kind: AnthropicMessages, BaseURL: "https://api.example.org/", APIKey: "sk-from-go-9876543210"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := providers.SetModels(p.ID, []string{"c-1", "c-2"}); err != nil {
		t.Fatal(err)
	}
	four, eff := 4242, 0.4
	if _, _, err := providers.SetJob(jobs.Text, &ModelChoice{ProviderID: p.ID, Model: "c-2"}, jobs.Settings{MaxTokens: &four, Temperature: &eff, ReasoningEffort: "high", UserPrompt: "Go writes {{notes}}"}); err != nil {
		t.Fatal(err)
	}
	if err := providers.SetHosts([]HostPin{{Host: "api.example.org", IP: "198.51.100.8"}}); err != nil {
		t.Fatal(err)
	}
	settings := NewSettings(filepath.Join(dir, "settings.enc"), k.Enc)
	if _, err := settings.Update(func(s *Portal) error {
		if err := ApplyPortalInput(s, map[string]any{"gitlabUrl": "https://gl.example.org/", "clientId": "go-id", "clientSecret": "go-secret"}); err != nil {
			return err
		}
		s.SSOLiveAt = 1761000000
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	var seen struct {
		List struct {
			Providers []struct {
				ID, Label, Kind, BaseURL, KeyHint string
				Models                            []string
				HasKey                            bool
			}
			Assignments map[string]struct{ ProviderID, Model string }
			Jobs        map[string]struct {
				MaxTokens       int
				Temperature     float64
				ReasoningEffort string
				UserPrompt      string
			}
		}
		APIKey   string
		Hosts    []HostPin
		Settings struct {
			Gitlab    struct{ Url, ClientId, ClientSecret string }
			SsoLiveAt int64
		}
	}
	if err := json.Unmarshal(node(t, "read", dir), &seen); err != nil {
		t.Fatal(err)
	}
	if len(seen.List.Providers) != 1 {
		t.Fatalf("Node sees %+v", seen.List)
	}
	np := seen.List.Providers[0]
	if np.ID != p.ID || np.Label != "Go LLM" || np.Kind != AnthropicMessages || np.BaseURL != "https://api.example.org" || !np.HasKey || np.KeyHint != "••••3210" || len(np.Models) != 2 {
		t.Errorf("Node sees the provider as %+v", np)
	}
	if a := seen.List.Assignments["text"]; a.ProviderID != p.ID || a.Model != "c-2" {
		t.Errorf("Node sees the assignment as %+v", a)
	}
	if j := seen.List.Jobs["text"]; j.MaxTokens != 4242 || j.Temperature != 0.4 || j.ReasoningEffort != "high" || j.UserPrompt != "Go writes {{notes}}" {
		t.Errorf("Node sees the job as %+v", j)
	}
	if seen.APIKey != "sk-from-go-9876543210" {
		t.Errorf("Node decrypts the key as %q", seen.APIKey)
	}
	if len(seen.Hosts) != 1 || seen.Hosts[0] != (HostPin{Host: "api.example.org", IP: "198.51.100.8"}) {
		t.Errorf("Node sees the hosts as %+v", seen.Hosts)
	}
	if g := seen.Settings.Gitlab; g.Url != "https://gl.example.org" || g.ClientId != "go-id" || g.ClientSecret != "go-secret" || seen.Settings.SsoLiveAt != 1761000000 {
		t.Errorf("Node sees the settings as %+v", seen.Settings)
	}
}
