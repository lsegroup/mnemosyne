package engine

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/lsegroup/mnemosyne/admin-go/internal/golden"
	"github.com/lsegroup/mnemosyne/admin-go/internal/jobs"
	"github.com/lsegroup/mnemosyne/admin-go/internal/store"
)

// The image model must be told exactly what the Node server tells it: the plan and the words come from the Node build (packages/server/test/
// fixtures/picture-prompt.json is the same file, asserted there too).
func TestThePromptOfTheImageModelIsTheNodeServersPrompt(t *testing.T) {
	var want struct {
		Plan   DiagramPlan `json:"plan"`
		Prompt string      `json:"prompt"`
	}
	if err := json.Unmarshal(golden.Bytes(t, "picture-prompt.json", func() []byte { return nil }), &want); err != nil {
		t.Fatal(err)
	}
	dflt := jobs.Defs[jobs.Image].Defaults.PicturePrompt
	if got := BuildPicturePrompt(want.Plan, "", dflt); got != want.Prompt {
		t.Errorf("the prompt differs from the Node server's:\n--- Go\n%s\n--- Node\n%s", got, want.Prompt)
	}
	if got := BuildPicturePrompt(want.Plan, "  ", dflt); got != want.Prompt {
		t.Error("a blank instruction must mean the built-in one")
	}
	custom := BuildPicturePrompt(want.Plan, "Make \"{{title}}\" in pastel colours.\n{{plan}}\nBye.", dflt)
	if !strings.HasPrefix(custom, "Make \"Shop 'main'\" in pastel colours.\nCOLUMNS AND BOXES:\nColumn 1") || !strings.HasSuffix(custom, "\nBye.") {
		t.Errorf("the administrator's instruction is not used:\n%s", custom)
	}
}

// Owner 2026-11-01: "nowhere did I set a colour, and in a diagram the lines are horizontal or vertical, never curved".
func TestTheBuiltInPictureInstructionNamesNoColourAndAsksForStraightLines(t *testing.T) {
	d := jobs.Defs[jobs.Image].Defaults.PicturePrompt
	if m := regexp.MustCompile(`(?i)\b(navy|dark|light|white|black|teal|violet|purple|blue|red|green|yellow|orange|grey|gray|gradient|glow|neon|colou?r)`).FindString(d); m != "" {
		t.Errorf("the built-in instruction names a colour or a style: %q", m)
	}
	for _, want := range []string{"STRAIGHT line that runs only horizontally or vertically", "never curved, never diagonal", "{{plan}}", "{{title}}", "spell every word EXACTLY"} {
		if !strings.Contains(d, want) {
			t.Errorf("the built-in instruction lacks %q", want)
		}
	}
}

var onePixelPNG = []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52}

func imageProvider(t *testing.T, h http.HandlerFunc) store.Provider {
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return store.Provider{ID: "p1", Label: "Fake AI", Kind: store.OpenAICompatible, BaseURL: srv.URL + "/v1", APIKey: "sk-test-key-1234567890"}
}

func TestOnePictureIsAskedForAndTheTypeIsReadFromTheBytes(t *testing.T) {
	var got map[string]any
	var auth string
	p := imageProvider(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/images/generations" || r.Method != http.MethodPost {
			w.WriteHeader(404)
			return
		}
		auth = r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&got)
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]any{"b64_json": base64.StdEncoding.EncodeToString(onePixelPNG)}}})
	})
	img, err := GenerateImage(p, "muse-image-1.0", "paint it", 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if got["model"] != "muse-image-1.0" || got["prompt"] != "paint it" || got["n"] != float64(1) {
		t.Errorf("request: %v", got)
	}
	if auth != "Bearer sk-test-key-1234567890" {
		t.Errorf("authorization: %q", auth)
	}
	if img.Mime != "image/png" || img.Ext != "png" || string(img.Bytes) != string(onePixelPNG) {
		t.Errorf("image: %s %s %d bytes", img.Mime, img.Ext, len(img.Bytes))
	}
}

func TestAnImageCallFailsWithAPlainMessage(t *testing.T) {
	for name, tc := range map[string]struct {
		status int
		body   string
		want   string
	}{
		"key rejected":      {401, `{}`, "The provider rejected the API key (HTTP 401)."},
		"rate limit":        {429, `{}`, "The provider is rate-limiting this key (HTTP 429)."},
		"server error":      {500, `{}`, "The provider answered HTTP 500 for image generation."},
		"no picture":        {200, `{"data":[]}`, "The provider returned no usable image."},
		"not a picture":     {200, `{"data":[{"b64_json":"` + base64.StdEncoding.EncodeToString([]byte("hello hello hello hello")) + `"}]}`, "not a PNG, JPEG or WebP image"},
		"broken base64":     {200, `{"data":[{"b64_json":"!!!"}]}`, "The provider returned no usable image."},
		"http link refused": {200, `{"data":[{"url":"http://example.invalid/x.png"}]}`, "The provider returned no usable image."},
	} {
		t.Run(name, func(t *testing.T) {
			p := imageProvider(t, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			})
			_, err := GenerateImage(p, "muse-image-1.0", "x", 5*time.Second)
			var ve *jobs.ValidationError
			if err == nil || !asValidation(err, &ve) || !strings.Contains(ve.Msg, tc.want) {
				t.Errorf("got %v, want %q", err, tc.want)
			}
		})
	}
}

func asValidation(err error, target **jobs.ValidationError) bool {
	ve, ok := err.(*jobs.ValidationError)
	if ok {
		*target = ve
	}
	return ok
}

func TestOnlyMuseImageHasAListPrice(t *testing.T) {
	if usd, ok := ImagePriceUSD("muse-image-1.0"); !ok || usd != 0.01 {
		t.Errorf("muse-image-1.0: %v %v", usd, ok)
	}
	if _, ok := ImagePriceUSD("some-other-image-model"); ok {
		t.Error("a model without a list price must stay unpriced")
	}
	if m, e := SniffImage([]byte("RIFF\x00\x00\x00\x00WEBPVP8 ")); m != "image/webp" || e != "webp" {
		t.Errorf("webp: %s %s", m, e)
	}
	if m, _ := SniffImage([]byte{0xff, 0xd8, 0xff, 0xe0}); m != "image/jpeg" {
		t.Errorf("jpeg: %s", m)
	}
}
