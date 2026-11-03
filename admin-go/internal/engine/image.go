// SPDX-License-Identifier: Apache-2.0

package engine

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/lsegroup/mnemosyne/admin-go/internal/jobs"
	"github.com/lsegroup/mnemosyne/admin-go/internal/llm"
	"github.com/lsegroup/mnemosyne/admin-go/internal/store"
)

// LLM CALL - image generation. *** COSTS MONEY ***
// The provider and model are the ones an administrator assigned to the "Images" job in Admin -> LLM (Meta Model API: muse-image-1.0, about
// $0.01 per picture). One picture per call. Called only by the documentation generator, after the plan of the diagrams was drawn: by the
// Auto scheduler after an administrator agreed to a setup, or (in the Node server) after a person pressed "Create workflow diagram" and
// confirmed the cost. Port of llm-call-image.ts.

// ImagePrices is the list price of one picture; a model that is not here has no known price.
var ImagePrices = map[string]float64{"muse-image-1.0": 0.01}

// ImagePriceUSD is what one picture of this model costs; ok is false when the model has no list price.
func ImagePriceUSD(model string) (usd float64, ok bool) {
	usd, ok = ImagePrices[model]
	return
}

// Image is a picture the provider returned.
type Image struct {
	Bytes []byte
	// Mime is sniffed from the bytes, not trusted from the provider.
	Mime string
	// Ext is the file extension it is stored with.
	Ext string
}

const maxImageBytes = 15 * 1024 * 1024

// SniffImage names the type of a PNG, JPEG or WebP picture from its first bytes; "" for anything else.
func SniffImage(b []byte) (mime, ext string) {
	switch {
	case len(b) > 12 && bytes.Equal(b[:8], []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}):
		return "image/png", "png"
	case len(b) > 3 && b[0] == 0xff && b[1] == 0xd8 && b[2] == 0xff:
		return "image/jpeg", "jpg"
	case len(b) > 12 && string(b[:4]) == "RIFF" && string(b[8:12]) == "WEBP":
		return "image/webp", "webp"
	}
	return "", ""
}

// GenerateImage asks the provider for ONE picture (POST {base}/images/generations {model, prompt, n: 1}).
func GenerateImage(p store.Provider, model, prompt string, timeout time.Duration) (Image, error) {
	if timeout == 0 {
		timeout = 4 * time.Minute
	}
	body, _ := json.Marshal(map[string]any{"model": model, "prompt": prompt, "n": 1})
	headers := map[string]string{"Content-Type": "application/json", "Accept": "application/json", "Authorization": "Bearer " + p.APIKey}
	res, err := postWithRetry(strings.TrimRight(p.BaseURL, "/")+"/images/generations", headers, body, timeout, "the provider for image generation")
	if err != nil {
		return Image{}, err
	}
	defer res.Body.Close()
	switch {
	case res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden:
		return Image{}, jobs.Invalid("The provider rejected the API key (HTTP %d).", res.StatusCode)
	case res.StatusCode == http.StatusTooManyRequests:
		return Image{}, jobs.Invalid("The provider is rate-limiting this key (HTTP 429). Try again in a minute.")
	case res.StatusCode < 200 || res.StatusCode > 299:
		return Image{}, jobs.Invalid("The provider answered HTTP %d for image generation.", res.StatusCode)
	}
	var ans struct {
		Data []struct {
			B64 string `json:"b64_json"`
			URL string `json:"url"`
		} `json:"data"`
	}
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 4*maxImageBytes))
	_ = json.Unmarshal(raw, &ans)
	var pic []byte
	if len(ans.Data) > 0 {
		item := ans.Data[0]
		switch {
		case item.B64 != "":
			pic, _ = base64.StdEncoding.DecodeString(item.B64)
		case strings.HasPrefix(item.URL, "https://"):
			if got, err := llm.Client(60 * time.Second).Get(item.URL); err == nil {
				pic, _ = io.ReadAll(io.LimitReader(got.Body, maxImageBytes+1))
				got.Body.Close()
				if got.StatusCode != http.StatusOK {
					pic = nil
				}
			}
		}
	}
	if len(pic) == 0 || len(pic) > maxImageBytes {
		return Image{}, jobs.Invalid("The provider returned no usable image.")
	}
	mime, ext := SniffImage(pic)
	if mime == "" {
		return Image{}, jobs.Invalid("The provider returned something that is not a PNG, JPEG or WebP image.")
	}
	return Image{Bytes: pic, Mime: mime, Ext: ext}, nil
}

// PlanWords is the boxes and arrows of one picture of the plan with the exact words in quotation marks: what {{plan}} stands for in the
// instruction for the picture. Port of planWords (docgen.ts).
func PlanWords(plan DiagramPlan) string {
	q := func(t string) string { return `"` + strings.ReplaceAll(t, `"`, "'") + `"` }
	label := map[string]string{}
	for _, c := range plan.Columns {
		for _, n := range c.Nodes {
			label[n.ID] = n.Label
		}
	}
	name := func(id string) string {
		if l, ok := label[id]; ok {
			return l
		}
		return id
	}
	lines := []string{"COLUMNS AND BOXES:"}
	for i, c := range plan.Columns {
		var path, control []string
		for _, n := range c.Nodes {
			if n.Lane == "control" {
				control = append(control, q(n.Label))
			} else {
				path = append(path, q(n.Label))
			}
		}
		main := strings.Join(path, ", ")
		if main == "" {
			main = "(no box in the main row)"
		}
		tail := ""
		if len(control) > 0 {
			tail = "; in a band below the main row, drawn with dashed arrows: " + strings.Join(control, ", ")
		}
		lines = append(lines, fmt.Sprintf("Column %d (small heading %s): %s%s", i+1, q(c.Title), main, tail))
	}
	lines = append(lines, "", "ARROWS (each one starts at the first box and its arrowhead points at the second):")
	for _, l := range plan.Links {
		s := q(name(l.From)) + " -> " + q(name(l.To))
		if l.Label != "" {
			s += ", label on the arrow: " + q(l.Label)
		}
		if l.Dashed {
			s += " (dashed)"
		}
		lines = append(lines, s)
	}
	return strings.Join(lines, "\n")
}

// BuildPicturePrompt is what the IMAGE MODEL is told for one picture: the instruction an administrator wrote (blank = the built-in one) with
// {{title}} and {{plan}} filled in. The text model has already planned the system as data, so the picture is described box by box and arrow by
// arrow with the exact words: an image model draws text as pixels and spells badly when it has to invent the words. Port of buildPicturePrompt
// (docgen.ts); the same plan gives the same words in both.
func BuildPicturePrompt(plan DiagramPlan, tpl, defaultTpl string) string {
	return FillTemplate(orDefault(tpl, defaultTpl), map[string]string{"title": strings.ReplaceAll(plan.Title, `"`, "'"), "plan": PlanWords(plan)})
}
