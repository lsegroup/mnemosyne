// SPDX-License-Identifier: Apache-2.0

// Package assets holds what the Go binary serves that comes from the browser side of Mnemosyne: the admin page and the admin sign-in
// page (HTML, CSS and JavaScript, with @@PLACEHOLDERS@@ the server fills in) and the AI job definitions. They are rendered from the
// Node code by tools/extract-assets.mjs and embedded, so the binary needs no files next to it.
package assets

import (
	_ "embed"
	"encoding/json"
)

//go:embed admin.html
var AdminHTML string

//go:embed login.html
var LoginHTML string

//go:embed jobdefs.json
var JobDefsJSON []byte

//go:embed meta.json
var metaJSON []byte

// Meta is the version the pages show in their footer.
type Meta struct {
	Version string `json:"version"`
	Shown   string `json:"shown"`
}

// Version returns the version of the Mnemosyne build the pages were rendered from.
func Version() Meta {
	var m Meta
	_ = json.Unmarshal(metaJSON, &m)
	return m
}

//go:embed afm.json
var AFMJSON []byte

//go:embed pdftext.json
var PDFTextJSON []byte
