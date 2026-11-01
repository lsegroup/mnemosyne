package engine

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"gitlab.globalclouddata.org/gcd-group/mnemosyne-admin/internal/golden"
	"gitlab.globalclouddata.org/gcd-group/mnemosyne-admin/internal/jobs"
	"gitlab.globalclouddata.org/gcd-group/mnemosyne-admin/internal/store"
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
	if got := BuildPicturePrompt(want.Plan); got != want.Prompt {
		t.Errorf("the prompt differs from the Node server's:\n--- Go\n%s\n--- Node\n%s", got, want.Prompt)
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
