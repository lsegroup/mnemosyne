package engine

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"unicode/utf16"

	"github.com/lsegroup/mnemosyne/admin-go/internal/assets"
)

// The architecture diagram of a project. The AI never draws it: the text model reads the article and writes a PLAN (columns of boxes
// and the arrows between them, as JSON); this file validates the plan, lays it out and draws it itself as SVG. Every word in the picture
// is therefore spelled exactly as the plan says and the layout does not change between runs. Port of diagram.ts: the pictures must be the
// same as the Node server draws them (the detail pictures are drawn there, on request, from the stored plan).

// PlanError says why an answer cannot be used as a plan.
type PlanError struct{ Msg string }

func (e *PlanError) Error() string { return e.Msg }

// PlanNode is one box.
type PlanNode struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	Detail string `json:"detail"`
	// Lane is "path" (a request passes through it) or "control" (configures, monitors or signs people in; not in the path).
	Lane string `json:"lane"`
}

// PlanColumn is one column of boxes.
type PlanColumn struct {
	Title string     `json:"title"`
	Nodes []PlanNode `json:"nodes"`
}

// PlanLink is one arrow.
type PlanLink struct {
	From   string `json:"from"`
	To     string `json:"to"`
	Label  string `json:"label"`
	Dashed bool   `json:"dashed"`
}

// DiagramPlan is one picture.
type DiagramPlan struct {
	Title   string       `json:"title"`
	Columns []PlanColumn `json:"columns"`
	Links   []PlanLink   `json:"links"`
	// Dropped lists what was left out of the AI's answer (too many boxes, links to unknown boxes, ...).
	Dropped []string `json:"dropped"`
}

// Picture is one picture of a set. Ext is set when the image model painted it (stored as diagram-<id>-<n>.<ext>); without it the picture is
// drawn from the plan.
type Picture struct {
	Name string      `json:"name"`
	Plan DiagramPlan `json:"plan"`
	Ext  string      `json:"ext,omitempty"`
}

// DiagramSet is the overview and the detail pictures.
type DiagramSet struct {
	Title    string
	Pictures []Picture
	Dropped  []string
}

type limits struct{ nodes, links int }

const (
	maxColumns        = 8
	maxPathPerColumn  = 8
	maxCtrlPerColumn  = 6
	maxTitle          = 60
	maxColTitle       = 32
	maxLabel          = 44
	maxDetail         = 96
	maxLinkLabel      = 48
	maxPictures       = 5
	pictureNodeLimit  = 12
	pictureLinkLimit  = 16
	legacyNodeLimit   = 30
	legacyLinkLimit   = 45
	nodeW             = 208.0
	margin            = 36.0
	rowGapDefault     = 26.0
	pad               = 10.0
	maxCleanTitleName = 40
)

var pictureLimits = limits{pictureNodeLimit, pictureLinkLimit}

// ---- reading the AI's answer ---------------------------------------------------------------------------------------------

var (
	pdfAllowed map[rune]bool
	pdfReplace map[rune]string
	pdfOnce    sync.Once
)

func loadPDFText() {
	var raw struct {
		Allowed []int             `json:"allowed"`
		Replace map[string]string `json:"replace"`
	}
	_ = json.Unmarshal(assets.PDFTextJSON, &raw)
	pdfAllowed = make(map[rune]bool, len(raw.Allowed))
	for _, c := range raw.Allowed {
		pdfAllowed[rune(c)] = true
	}
	pdfReplace = make(map[rune]string, len(raw.Replace))
	for k, v := range raw.Replace {
		if n, err := strconv.Atoi(k); err == nil {
			pdfReplace[rune(n)] = v
		}
	}
}

// PDFText keeps what the PDF fonts can draw and replaces or masks the rest with "?".
func PDFText(s string) string {
	pdfOnce.Do(loadPDFText)
	var b strings.Builder
	for _, r := range s {
		if rep, ok := pdfReplace[r]; ok {
			b.WriteString(rep)
		} else if pdfAllowed[r] {
			b.WriteRune(r)
		} else {
			b.WriteByte('?')
		}
	}
	return b.String()
}

var (
	reControl = regexp.MustCompile(`[\x00-\x1f\x7f]+`)
	reSpaces  = regexp.MustCompile(ws + `+`)
)

// str is JavaScript's String(v) for the values a JSON answer can hold in a text field.
func str(v any) (string, bool) {
	switch t := v.(type) {
	case string:
		return t, true
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64), true
	}
	return "", false
}

// clean is one line of plain text: safe for the PDF fonts, no control characters, credentials masked, shortened to max characters.
func clean(v any, max int) string {
	s, ok := str(v)
	if !ok {
		return ""
	}
	t := Redact(JSTrim(reSpaces.ReplaceAllString(reControl.ReplaceAllString(PDFText(s), " "), " ")))
	if r := []rune(t); len(r) > max {
		return strings.TrimRightFunc(string(r[:max-1]), isJSSpace) + "…"
	}
	return t
}

var (
	reFenceStart = regexp.MustCompile("(?i)^```(?:json)?" + ws + "*")
	reFenceEnd   = regexp.MustCompile(ws + "*```$")
)

func extractJSON(raw string) (any, error) {
	text := reFenceEnd.ReplaceAllString(reFenceStart.ReplaceAllString(JSTrim(raw), ""), "")
	a, b := strings.Index(text, "{"), strings.LastIndex(text, "}")
	if a < 0 || b <= a {
		return nil, &PlanError{fmt.Sprintf("no JSON object in the answer (it begins: “%s”)", clean(string([]rune(text)[:min(90, len([]rune(text)))]), 90))}
	}
	var out any
	if err := json.Unmarshal([]byte(text[a:b+1]), &out); err != nil {
		return nil, &PlanError{fmt.Sprintf("the JSON is not valid (%s)", err.Error())}
	}
	return out, nil
}

func isObj(v any) (map[string]any, bool) {
	m, ok := v.(map[string]any)
	return m, ok
}

// firstNonNil is a ?? b ?? c.
func firstNonNil(vs ...any) any {
	for _, v := range vs {
		if v != nil {
			return v
		}
	}
	return nil
}

func buildPlan(root map[string]any, fallbackTitle string, lim limits) (DiagramPlan, error) {
	cols, ok := root["columns"].([]any)
	if !ok {
		return DiagramPlan{}, &PlanError{`the JSON has no "columns" list`}
	}
	dropped := []string{}
	ids := map[string]string{}
	columns := []PlanColumn{}
	total, auto := 0, 0

	for _, rawCol := range cols {
		col, ok := isObj(rawCol)
		if !ok {
			continue
		}
		rawNodes, ok := col["nodes"].([]any)
		if !ok {
			continue
		}
		if len(columns) >= maxColumns {
			dropped = append(dropped, fmt.Sprintf("column “%s” (more than %d columns)", clean(col["title"], 30), maxColumns))
			continue
		}
		var nodes []PlanNode
		path, control := 0, 0
		for _, rawNode := range rawNodes {
			nd, ok := isObj(rawNode)
			if !ok {
				continue
			}
			label := clean(firstNonNil(nd["label"], nd["name"], nd["title"]), maxLabel)
			if label == "" {
				continue
			}
			lane := "path"
			if l, ok := str(orEmpty(nd["lane"])); ok && strings.ToLower(l) == "control" {
				lane = "control"
			}
			count, per := path, maxPathPerColumn
			if lane == "control" {
				count, per = control, maxCtrlPerColumn
			}
			if total >= lim.nodes || count >= per {
				dropped = append(dropped, fmt.Sprintf("box “%s” (too many boxes)", label))
				continue
			}
			id := clean(nd["id"], 24)
			if id == "" {
				auto++
				id = fmt.Sprintf("n%d", auto)
			}
			for {
				if _, taken := ids[strings.ToLower(id)]; !taken {
					break
				}
				auto++
				id = fmt.Sprintf("%s_%d", id, auto)
			}
			ids[strings.ToLower(id)] = id
			nodes = append(nodes, PlanNode{ID: id, Label: label, Detail: clean(firstNonNil(nd["detail"], nd["description"]), maxDetail), Lane: lane})
			if lane == "path" {
				path++
			} else {
				control++
			}
			total++
		}
		if len(nodes) > 0 {
			columns = append(columns, PlanColumn{Title: clean(col["title"], maxColTitle), Nodes: nodes})
		}
	}
	if total < 2 {
		return DiagramPlan{}, &PlanError{"the plan has fewer than two boxes"}
	}

	laneOf := map[string]string{}
	for _, c := range columns {
		for _, n := range c.Nodes {
			laneOf[n.ID] = n.Lane
		}
	}
	links := []PlanLink{}
	seen := map[string]bool{}
	rawLinks, _ := root["links"].([]any)
	for _, rawLink := range rawLinks {
		l, ok := isObj(rawLink)
		if !ok {
			continue
		}
		from, okF := ids[strings.ToLower(clean(l["from"], 24))]
		to, okT := ids[strings.ToLower(clean(l["to"], 24))]
		if !okF || !okT || from == to {
			dropped = append(dropped, fmt.Sprintf("arrow “%s -> %s” (unknown or identical boxes)", clean(l["from"], 24), clean(l["to"], 24)))
			continue
		}
		label := clean(l["label"], maxLinkLabel)
		key := from + ">" + to + ">" + label
		if seen[key] || len(links) >= lim.links {
			continue
		}
		seen[key] = true
		dashed := l["dashed"] == true || laneOf[from] == "control" || laneOf[to] == "control"
		links = append(links, PlanLink{From: from, To: to, Label: label, Dashed: dashed})
	}
	if len(links) == 0 {
		return DiagramPlan{}, &PlanError{"the plan has no arrows between its boxes"}
	}
	title := clean(root["title"], maxTitle)
	if title == "" {
		title = clean(fallbackTitle, maxTitle)
	}
	if title == "" {
		title = "Architecture"
	}
	return DiagramPlan{Title: title, Columns: columns, Links: links, Dropped: dropped}, nil
}

func orEmpty(v any) any {
	if v == nil {
		return ""
	}
	return v
}

// ParsePlanSet reads the AI's answer: {title, diagrams:[{name, columns, links}, ...]} - an overview and detail pictures by topic, each
// within the strict limits. The older single-picture answer is read as one picture. A picture that cannot be used is left out and reported;
// when none can be used the answer is refused.
func ParsePlanSet(raw, fallbackTitle string) (DiagramSet, error) {
	rootAny, err := extractJSON(raw)
	if err != nil {
		return DiagramSet{}, err
	}
	root, ok := isObj(rootAny)
	if !ok {
		return DiagramSet{}, &PlanError{"the answer is not a JSON object"}
	}
	title := clean(root["title"], maxTitle)
	if title == "" {
		title = clean(fallbackTitle, maxTitle)
	}
	if title == "" {
		title = "Architecture"
	}
	dropped := []string{}
	pictures := []Picture{}

	add := func(src map[string]any, index int) {
		name := clean(firstNonNil(src["name"], src["title"]), maxCleanTitleName)
		if name == "" {
			if index == 0 {
				name = "Overview"
			} else {
				name = fmt.Sprintf("Detail %d", index)
			}
		}
		if len(pictures) >= maxPictures {
			dropped = append(dropped, fmt.Sprintf("picture “%s” (more than %d pictures)", name, maxPictures))
			return
		}
		plan, err := buildPlan(src, title, pictureLimits)
		if err != nil {
			dropped = append(dropped, fmt.Sprintf("picture “%s” (%s)", name, err.Error()))
			return
		}
		if len(pictures) == 0 {
			plan.Title = title
		} else {
			plan.Title = clean(title+" - "+name, maxTitle)
		}
		picName := name
		if len(pictures) == 0 {
			picName = "Overview"
		}
		pictures = append(pictures, Picture{Name: picName, Plan: plan})
		for _, d := range plan.Dropped {
			dropped = append(dropped, name+": "+d)
		}
	}

	if diagrams, ok := root["diagrams"].([]any); ok {
		for i, d := range diagrams {
			if m, ok := isObj(d); ok {
				add(m, i)
			}
		}
	} else if _, ok := root["columns"].([]any); ok {
		add(root, 0)
	} else {
		return DiagramSet{}, &PlanError{`the JSON has no "diagrams" list`}
	}
	if len(pictures) == 0 {
		more := ""
		if len(dropped) > 0 {
			more = " (" + strings.Join(dropped[:min(2, len(dropped))], "; ") + ")"
		}
		return DiagramSet{}, &PlanError{"none of the pictures in the plan could be used" + more}
	}
	return DiagramSet{Title: title, Pictures: pictures, Dropped: dropped}, nil
}

// ---- measuring text -------------------------------------------------------------------------------------------------------

type afmFont struct {
	GlyphOf map[string]string             `json:"glyphOf"`
	Widths  map[string]float64            `json:"widths"`
	Kern    map[string]map[string]float64 `json:"kern"`
}

var (
	afmFonts map[string]afmFont
	afmOnce  sync.Once
)

// TextWidth is the width of s in the same Helvetica metrics the PDF library uses (kerning included).
func TextWidth(s string, size float64, bold bool) float64 {
	afmOnce.Do(func() { _ = json.Unmarshal(assets.AFMJSON, &afmFonts) })
	f := afmFonts["Helvetica"]
	if bold {
		f = afmFonts["Helvetica-Bold"]
	}
	units := utf16.Encode([]rune(s))
	glyphs := make([]string, len(units))
	for i, u := range units {
		glyphs[i] = f.GlyphOf[strconv.Itoa(int(u))]
		if glyphs[i] == "" {
			glyphs[i] = ".notdef"
		}
	}
	total := 0.0
	for i, g := range glyphs {
		total += f.Widths[g]
		if i+1 < len(glyphs) {
			total += f.Kern[g][glyphs[i+1]]
		}
	}
	return total * (size / 1000)
}

func fit(s string, maxW, size float64, bold bool) string {
	if TextWidth(s, size, bold) <= maxW {
		return s
	}
	t := []rune(s)
	for len(t) > 1 && TextWidth(string(t)+"…", size, bold) > maxW {
		t = t[:len(t)-1]
	}
	return strings.TrimRightFunc(string(t), isJSSpace) + "…"
}

func wrapText(text string, maxW, size float64, bold bool, maxLines int) []string {
	var lines []string
	cur := ""
	for _, word := range strings.Split(text, " ") {
		if word == "" {
			continue
		}
		next := word
		if cur != "" {
			next = cur + " " + word
		}
		if cur == "" || TextWidth(next, size, bold) <= maxW {
			cur = next
		} else {
			lines = append(lines, cur)
			cur = word
		}
	}
	if cur != "" {
		lines = append(lines, cur)
	}
	n := min(len(lines), maxLines)
	out := make([]string, n)
	for i := 0; i < n; i++ {
		out[i] = fit(lines[i], maxW, size, bold)
	}
	if len(lines) > maxLines {
		out[maxLines-1] = fit(strings.TrimSuffix(out[maxLines-1], "…")+"…", maxW, size, bold)
	}
	return out
}

// ---- laying out -----------------------------------------------------------------------------------------------------------

// Op is one drawing instruction.
type Op struct {
	T      string // rect, path, arrow, text
	X, Y   float64
	W, H   float64
	R      float64
	Fill   string
	Stroke string
	SW     float64
	Pts    [][2]float64
	Dash   bool
	Color  string
	Text   string
	Size   float64
	Bold   bool
	Anchor string
}

// Scene is a laid-out picture.
type Scene struct {
	Width, Height int
	Title         string
	Ops           []Op
}

const (
	cInk    = "#14213d"
	cViolet = "#6d57d6"
	cTeal   = "#17a3ad"
	cMuted  = "#5b6480"
	cSoft   = "#4b5470"
	cBand   = "#f4f5fa"
	cLine   = "#d8dbe6"
	cGrey   = "#9aa3bd"
	cWhite  = "#ffffff"
)

type box struct {
	node          PlanNode
	col           int
	x, y, w, h    float64
	label, detail []string
}

type rect struct{ x, y, w, h float64 }

func overlaps(a, b rect) bool {
	return a.x < b.x+b.w && b.x < a.x+a.w && a.y < b.y+b.h && b.y < a.y+a.h
}

type edge struct {
	link           PlanLink
	a, b           *box
	kind           string // vert, gutter, cross, near, skip
	lines          []string
	sa, sb         string
	blockA, blockB bool
	atSource       bool
}

func jsRound(v float64) float64 { return math.Floor(v + 0.5) }

func sign(v float64) float64 {
	switch {
	case v > 0:
		return 1
	case v < 0:
		return -1
	}
	return 0
}

// Layout turns a plan into drawing instructions. Columns run left to right in the plan's order; boxes of the "control" lane sit in a
// band below.
func Layout(plan DiagramPlan) Scene {
	n := len(plan.Columns)
	boxes := map[string]*box{}
	var boxList []*box // creation order = drawing order
	order := map[string]int{}
	laneByID := map[string]string{}
	colByID := map[string]int{}
	for i, c := range plan.Columns {
		for _, nd := range c.Nodes {
			laneByID[nd.ID] = nd.Lane
			colByID[nd.ID] = i
		}
	}
	crossing := map[string]bool{}
	for _, l := range plan.Links {
		if laneByID[l.From] != laneByID[l.To] && colByID[l.From] != colByID[l.To] {
			crossing[l.From], crossing[l.To] = true, true
		}
	}
	type stack struct{ path, control []*box }
	stacks := make([]stack, n)
	for col, c := range plan.Columns {
		mk := func(lane string) []*box {
			var nodes []PlanNode
			for _, nd := range c.Nodes {
				if nd.Lane == lane {
					nodes = append(nodes, nd)
				}
			}
			dir := 1
			if lane != "path" {
				dir = -1
			}
			cv := func(id string) int {
				if crossing[id] {
					return 1
				}
				return 0
			}
			sort.SliceStable(nodes, func(i, j int) bool { return (cv(nodes[i].ID)-cv(nodes[j].ID))*dir < 0 })
			var out []*box
			for _, nd := range nodes {
				label := wrapText(nd.Label, nodeW-2*pad-4, 15, true, 3)
				var detail []string
				if nd.Detail != "" {
					detail = wrapText(nd.Detail, nodeW-2*pad-4, 12, false, 4)
				}
				h := pad + 12 + float64(len(label)-1)*18 + 4 + pad
				if len(detail) > 0 {
					h = pad + 12 + float64(len(label)-1)*18 + (17 + float64(len(detail)-1)*15) + 4 + pad
				}
				h = math.Max(48, h)
				b := &box{node: nd, col: col, w: nodeW, h: h, label: label, detail: detail}
				boxes[nd.ID] = b
				boxList = append(boxList, b)
				out = append(out, b)
			}
			return out
		}
		path := mk("path")
		control := mk("control")
		for i, b := range append(append([]*box{}, path...), control...) {
			order[b.node.ID] = i
		}
		stacks[col] = stack{path, control}
	}
	lw := func(lines []string) float64 {
		w := 0.0
		for _, l := range lines {
			w = math.Max(w, TextWidth(l, 11.5, false))
		}
		return w + 10
	}
	lh := func(lines []string) float64 { return float64(len(lines))*14 + 6 }

	// ---- classify the arrows
	edges := make([]*edge, len(plan.Links))
	blocked := func(bx *box) bool {
		list := stacks[bx.col].control
		if bx.node.Lane == "path" {
			list = stacks[bx.col].path
		}
		idx := 0
		for i, x := range list {
			if x == bx {
				idx = i
			}
		}
		if bx.node.Lane == "path" {
			return idx < len(list)-1
		}
		return idx > 0
	}
	for i, link := range plan.Links {
		a, b := boxes[link.From], boxes[link.To]
		var kind string
		switch {
		case a.col == b.col:
			if abs(order[a.node.ID]-order[b.node.ID]) > 1 {
				kind = "gutter"
			} else {
				kind = "vert"
			}
		case a.node.Lane != b.node.Lane:
			kind = "cross"
		case abs(a.col-b.col) == 1:
			kind = "near"
		default:
			kind = "skip"
		}
		var sa, sb string
		switch kind {
		case "vert":
			if order[a.node.ID] < order[b.node.ID] {
				sa = "B"
			} else {
				sa = "T"
			}
			sb = opposite(sa)
		case "gutter":
			sa, sb = "L", "L"
		case "cross":
			if a.node.Lane == "path" {
				sa = "B"
			} else {
				sa = "T"
			}
			sb = opposite(sa)
		default:
			if b.col > a.col {
				sa = "R"
			} else {
				sa = "L"
			}
			sb = opposite(sa)
		}
		blockA := kind == "cross" && blocked(a)
		blockB := kind == "cross" && blocked(b)
		if blockA {
			sa = "L"
			if a.col < n-1 {
				sa = "R"
			}
		}
		if blockB {
			sb = "L"
			if b.col < n-1 {
				sb = "R"
			}
		}
		var lines []string
		if link.Label != "" {
			lines = wrapText(link.Label, 150, 11.5, false, 3)
		}
		edges[i] = &edge{link: link, a: a, b: b, kind: kind, lines: lines, sa: sa, sb: sb, blockA: blockA, blockB: blockB, atSource: true}
	}
	skipGaps := func(e *edge) (int, int) {
		if e.b.col > e.a.col {
			return e.a.col, e.b.col - 1
		}
		return e.a.col - 1, e.b.col
	}

	// Neighbouring boxes of a column that are joined by a LABELLED vertical arrow are spread apart so the label fits between them.
	rowGaps := map[string]float64{}
	for _, e := range edges {
		if e.kind != "vert" || len(e.lines) == 0 {
			continue
		}
		up, low := e.b, e.a
		if order[e.a.node.ID] < order[e.b.node.ID] {
			up, low = e.a, e.b
		}
		k := up.node.ID + "|" + low.node.ID
		cur, ok := rowGaps[k]
		if !ok {
			cur = rowGapDefault
		}
		rowGaps[k] = math.Max(cur, lh(e.lines)+18)
	}
	rowGap := func(up, low *box) float64 {
		if g, ok := rowGaps[up.node.ID+"|"+low.node.ID]; ok {
			return g
		}
		return rowGapDefault
	}
	stackH := func(l []*box) float64 {
		if len(l) == 0 {
			return 0
		}
		s := 0.0
		for _, b := range l {
			s += b.h
		}
		for i := 1; i < len(l); i++ {
			s += rowGap(l[i-1], l[i])
		}
		return s
	}
	pathH, ctrlH := 48.0, 0.0
	for _, s := range stacks {
		pathH = math.Max(pathH, stackH(s.path))
		ctrlH = math.Max(ctrlH, stackH(s.control))
	}
	hasControl := ctrlH > 0

	// ---- gaps between columns: wide enough for the widest label and for one lane per arrow
	gapCount := make([]int, max(0, n-1))
	gapLabel := make([]float64, max(0, n-1))
	for _, e := range edges {
		switch {
		case e.kind == "near":
			g := min(e.a.col, e.b.col)
			gapCount[g]++
			gapLabel[g] = math.Max(gapLabel[g], lw(e.lines))
		case e.kind == "skip":
			g1, g2 := skipGaps(e)
			gapCount[g1]++
			gapCount[g2]++
		case e.kind == "gutter" && e.a.col > 0:
			gapCount[e.a.col-1]++
			gapLabel[e.a.col-1] = math.Max(gapLabel[e.a.col-1], lw(e.lines))
		case e.kind == "cross":
			if e.blockA {
				gapCount[ifInt(e.sa == "R", e.a.col, e.a.col-1)]++
			}
			if e.blockB {
				gapCount[ifInt(e.sb == "R", e.b.col, e.b.col-1)]++
			}
		}
	}
	gaps := make([]float64, len(gapCount))
	for g, cnt := range gapCount {
		base := 30.0
		if gapLabel[g] != 0 {
			base = gapLabel[g] + 34
		}
		gaps[g] = math.Min(260, math.Max(64, base+9*float64(cnt)))
	}
	colX := make([]float64, n)
	for i := 0; i < n; i++ {
		if i == 0 {
			colX[i] = margin
		} else {
			colX[i] = colX[i-1] + nodeW + gaps[i-1]
		}
	}
	width := colX[n-1] + nodeW + margin

	skipPath, skipCtrl := 0, 0
	for _, e := range edges {
		if e.kind == "skip" && e.a.node.Lane == "path" {
			skipPath++
		}
		if e.kind == "skip" && e.a.node.Lane == "control" {
			skipCtrl++
		}
	}
	titleY := margin + 24
	headY := titleY + 34
	pathTop := headY + 18
	if skipPath > 0 {
		pathTop += 16 + 26*float64(skipPath)
	} else {
		pathTop += 8
	}
	pathBottom := pathTop + pathH
	var crossSteps []float64
	for _, e := range edges {
		if e.kind == "cross" {
			if len(e.lines) > 0 {
				crossSteps = append(crossSteps, lh(e.lines)+8)
			} else {
				crossSteps = append(crossSteps, 12)
			}
		}
	}
	bandGap := 0.0
	if hasControl {
		sum := 0.0
		for _, s := range crossSteps {
			sum += s
		}
		bandGap = 74 + sum
	}
	ctrlTop := pathBottom + bandGap
	ctrlBottom := ctrlTop + ctrlH
	height := pathBottom + margin
	if hasControl {
		height = ctrlBottom + 16 + margin
		if skipCtrl > 0 {
			height += 16 + 26*float64(skipCtrl)
		}
	}

	// ---- positions
	for c := 0; c < n; c++ {
		place := func(list []*box, top, bandH float64) {
			y := top + (bandH-stackH(list))/2
			for i, b := range list {
				b.x, b.y = colX[c], y
				y += b.h
				if i+1 < len(list) {
					y += rowGap(b, list[i+1])
				}
			}
		}
		place(stacks[c].path, pathTop, pathH)
		place(stacks[c].control, ctrlTop, ctrlH)
	}

	// ---- ports: arrows on one side of a box leave in the order of where they go, so they do not cross each other
	type portItem struct {
		e     int
		end   string
		other float64
	}
	type group struct {
		box   *box
		side  string
		items []portItem
	}
	groups := map[string]*group{}
	var groupOrder []string
	gkey := func(b *box, s string) string { return b.node.ID + "\x00" + s }
	addPort := func(bx *box, side string, e int, end string, other *box) {
		k := gkey(bx, side)
		g := groups[k]
		if g == nil {
			g = &group{box: bx, side: side}
			groups[k] = g
			groupOrder = append(groupOrder, k)
		}
		pos := other.x + other.w/2
		if side == "L" || side == "R" {
			pos = other.y + other.h/2
		}
		g.items = append(g.items, portItem{e, end, pos})
	}
	for i, e := range edges {
		addPort(e.a, e.sa, i, "a", e.b)
		if e.kind != "vert" {
			addPort(e.b, e.sb, i, "b", e.a)
		}
	}
	ports := map[string][2]float64{}
	for _, k := range groupOrder {
		g := groups[k]
		sort.SliceStable(g.items, func(i, j int) bool {
			if g.items[i].other != g.items[j].other {
				return g.items[i].other < g.items[j].other
			}
			return g.items[i].e < g.items[j].e
		})
		horizontal := g.side == "L" || g.side == "R"
		dim := g.box.w
		if horizontal {
			dim = g.box.h
		}
		span := dim/2 - 10
		step := 0.0
		if len(g.items) > 1 {
			lim := 14.0
			if horizontal {
				lim = 10
			}
			step = math.Min(lim, (2*span)/float64(len(g.items)-1))
		}
		b := g.box
		for idx, it := range g.items {
			off := (float64(idx) - float64(len(g.items)-1)/2) * step
			var pos [2]float64
			switch g.side {
			case "L":
				pos = [2]float64{b.x, b.y + b.h/2 + off}
			case "R":
				pos = [2]float64{b.x + b.w, b.y + b.h/2 + off}
			case "T":
				pos = [2]float64{b.x + b.w/2 + off, b.y}
			default:
				pos = [2]float64{b.x + b.w/2 + off, b.y + b.h}
			}
			ed := edges[it.e]
			if ed.kind == "cross" && (g.side == "T" || g.side == "B") {
				if ed.a.node.Lane == "path" {
					pos[0] += 14
				} else {
					pos[0] -= 14
				}
			}
			ports[fmt.Sprintf("%d:%s", it.e, it.end)] = pos
		}
	}
	P := func(e int, end string) [2]float64 { return ports[fmt.Sprintf("%d:%s", e, end)] }
	for _, e := range edges {
		if e.kind == "near" || e.kind == "skip" {
			e.atSource = len(groups[gkey(e.a, e.sa)].items) <= len(groups[gkey(e.b, e.sb)].items)
		}
	}

	// ---- vertical runs inside the gaps: one lane per arrow; the arrow that travels furthest takes the lane nearest its home end
	type vreq struct {
		e    int
		tag  string
		g    int
		home string
		dy   float64
	}
	var reqs []vreq
	for i, e := range edges {
		fwd := e.b.col > e.a.col
		switch e.kind {
		case "near":
			dy := math.Abs(P(i, "a")[1] - P(i, "b")[1])
			if dy >= 0.5 {
				home := "L"
				if (fwd && e.atSource) || (!fwd && !e.atSource) {
					home = "R"
				}
				reqs = append(reqs, vreq{i, "v", min(e.a.col, e.b.col), home, dy})
			}
		case "skip":
			g1, g2 := skipGaps(e)
			h1, h2 := "R", "L"
			if fwd {
				h1, h2 = "L", "R"
			}
			reqs = append(reqs, vreq{i, "v1", g1, h1, 1e6}, vreq{i, "v2", g2, h2, 1e6})
		case "gutter":
			if e.a.col > 0 {
				reqs = append(reqs, vreq{i, "v", e.a.col - 1, "R", 2e6})
			}
		case "cross":
			if e.blockA {
				g, home := e.a.col-1, "R"
				if e.sa == "R" {
					g, home = e.a.col, "L"
				}
				reqs = append(reqs, vreq{i, "va", g, home, 1e6})
			}
			if e.blockB {
				g, home := e.b.col-1, "R"
				if e.sb == "R" {
					g, home = e.b.col, "L"
				}
				reqs = append(reqs, vreq{i, "vb", g, home, 1e6})
			}
		}
	}
	vx := map[string]float64{}
	lanes := map[string][]vreq{}
	var laneOrder []string
	for _, r := range reqs {
		k := fmt.Sprintf("%d%s", r.g, r.home)
		if _, ok := lanes[k]; !ok {
			laneOrder = append(laneOrder, k)
		}
		lanes[k] = append(lanes[k], r)
	}
	for _, k := range laneOrder {
		list := lanes[k]
		sort.SliceStable(list, func(i, j int) bool {
			if list[i].dy != list[j].dy {
				return list[i].dy > list[j].dy
			}
			return list[i].e < list[j].e
		})
		for s, r := range list {
			left := colX[r.g] + nodeW
			if r.home == "R" {
				vx[fmt.Sprintf("%d:%s", r.e, r.tag)] = left + gaps[r.g] - 18 - float64(s)*9
			} else {
				vx[fmt.Sprintf("%d:%s", r.e, r.tag)] = left + 18 + float64(s)*9
			}
		}
	}
	VX := func(e int, tag string) float64 { return vx[fmt.Sprintf("%d:%s", e, tag)] }

	// ---- route every arrow
	var lines, arrows, halos, halotexts []Op
	var placed []rect
	crossSlot, topSlot, botSlot, leftSlot := 0, 0, 0, 0
	obstacles := make([]rect, 0, len(boxList))
	for _, b := range boxList {
		obstacles = append(obstacles, rect{b.x, b.y, b.w, b.h})
	}

	// A label sits on its arrow. If that spot is taken it slides along the arrow, then moves just beside the arrow; only if nothing
	// is free it stays put.
	put := func(center [2]float64, text []string, along string, lo, hi float64) {
		w, h := lw(text), lh(text)
		commit := func(cx, cy float64) {
			r := rect{cx - w/2, cy - h/2, w, h}
			placed = append(placed, r)
			halos = append(halos, Op{T: "rect", X: r.x, Y: r.y, W: r.w, H: r.h, R: 3, Fill: cWhite})
			for i, l := range text {
				halotexts = append(halotexts, Op{T: "text", X: cx, Y: r.y + 3 + 11 + float64(i)*14, Text: l, Size: 11.5, Anchor: "middle", Color: cInk})
			}
		}
		free := func(cx, cy float64) bool {
			r := rect{cx - w/2, cy - h/2, w, h}
			for _, p := range placed {
				if overlaps(p, r) {
					return false
				}
			}
			for _, o := range obstacles {
				if overlaps(o, r) {
					return false
				}
			}
			return true
		}
		var tries [][2]float64
		for _, k := range []float64{0, 1, -1, 2, -2} {
			span := w
			if along == "y" {
				span = h
			}
			d := k * (span + 4)
			cx, cy := center[0], center[1]
			if along == "x" {
				cx += d
			} else {
				cy += d
			}
			v := cy
			if along == "x" {
				v = cx
			}
			if k != 0 && v < lo {
				continue
			}
			if k != 0 && v > hi {
				continue
			}
			tries = append(tries, [2]float64{cx, cy})
		}
		for _, k := range []float64{1, -1, 2, -2} {
			if along == "x" {
				tries = append(tries, [2]float64{center[0], center[1] + k*(h/2+6)})
			} else {
				tries = append(tries, [2]float64{center[0] + k*(w/2+8), center[1]})
			}
		}
		for _, t := range tries {
			if free(t[0], t[1]) {
				commit(t[0], t[1])
				return
			}
		}
		commit(center[0], center[1])
	}

	for i, e := range edges {
		pa := P(i, "a")
		var pts [][2]float64
		switch e.kind {
		case "vert":
			yb := e.b.y + e.b.h
			if e.sb == "T" {
				yb = e.b.y
			}
			pts = [][2]float64{pa, {pa[0], yb}}
			if len(e.lines) > 0 {
				put([2]float64{pa[0] + 8 + lw(e.lines)/2, (pa[1] + yb) / 2}, e.lines, "y", math.Min(pa[1], yb), math.Max(pa[1], yb))
			}
		case "gutter":
			pb := P(i, "b")
			var xg float64
			if e.a.col > 0 {
				xg = VX(i, "v")
			} else {
				xg = math.Max(8, margin-14-9*float64(leftSlot))
				leftSlot++
			}
			pts = [][2]float64{pa, {xg, pa[1]}, {xg, pb[1]}, pb}
			if len(e.lines) > 0 && e.a.col > 0 {
				w := lw(e.lines)
				gl := colX[e.a.col-1] + nodeW
				put([2]float64{math.Max(gl+w/2+2, math.Min(colX[e.a.col]-w/2-2, xg)), (pa[1] + pb[1]) / 2}, e.lines, "y", math.Min(pa[1], pb[1]), math.Max(pa[1], pb[1]))
			}
		case "cross":
			pb := P(i, "b")
			before := 0.0
			for _, s := range crossSteps[:crossSlot] {
				before += s
			}
			yc := pathBottom + 14 + before + crossSteps[crossSlot]/2
			crossSlot++
			xa, xb := pa[0], pb[0]
			if e.blockA {
				xa = VX(i, "va")
			}
			if e.blockB {
				xb = VX(i, "vb")
			}
			pts = [][2]float64{pa}
			if e.blockA {
				pts = append(pts, [2]float64{xa, pa[1]})
			}
			pts = append(pts, [2]float64{xa, yc}, [2]float64{xb, yc})
			if e.blockB {
				pts = append(pts, [2]float64{xb, pb[1]})
			}
			pts = append(pts, pb)
			if len(e.lines) > 0 {
				put([2]float64{(xa + xb) / 2, yc}, e.lines, "x", math.Min(xa, xb), math.Max(xa, xb))
			}
		case "near":
			pb := P(i, "b")
			if math.Abs(pa[1]-pb[1]) < 0.5 {
				pts = [][2]float64{pa, {pb[0], pa[1]}}
				if len(e.lines) > 0 {
					put([2]float64{(pa[0] + pb[0]) / 2, pa[1]}, e.lines, "x", math.Min(pa[0], pb[0]), math.Max(pa[0], pb[0]))
				}
			} else {
				xv := VX(i, "v")
				pts = [][2]float64{pa, {xv, pa[1]}, {xv, pb[1]}, pb}
				if len(e.lines) > 0 {
					from, to, y := xv, pb[0], pb[1]
					if e.atSource {
						from, to, y = pa[0], xv, pa[1]
					}
					put([2]float64{(from + to) / 2, y}, e.lines, "x", math.Min(from, to), math.Max(from, to))
				}
			}
		default: // skip
			pb := P(i, "b")
			x1, x2 := VX(i, "v1"), VX(i, "v2")
			var yc float64
			if e.a.node.Lane == "path" {
				yc = pathTop - 22 - 26*float64(topSlot)
				topSlot++
			} else {
				yc = ctrlBottom + 24 + 26*float64(botSlot)
				botSlot++
			}
			pts = [][2]float64{pa, {x1, pa[1]}, {x1, yc}, {x2, yc}, {x2, pb[1]}, pb}
			if len(e.lines) > 0 {
				put([2]float64{(x1 + x2) / 2, yc}, e.lines, "x", math.Min(x1, x2), math.Max(x1, x2))
			}
		}
		end, prev := pts[len(pts)-1], pts[len(pts)-2]
		dx, dy := sign(end[0]-prev[0]), sign(end[1]-prev[1])
		arrows = append(arrows, Op{T: "arrow", Color: cInk, Pts: [][2]float64{end, {end[0] - dx*10 - dy*5, end[1] - dy*10 + dx*5}, {end[0] - dx*10 + dy*5, end[1] - dy*10 - dx*5}}})
		body := append([][2]float64{}, pts[:len(pts)-1]...)
		body = append(body, [2]float64{end[0] - dx*9, end[1] - dy*9})
		lines = append(lines, Op{T: "path", Pts: body, Dash: e.link.Dashed, Color: cInk})
	}

	// a label that sticks out beyond the last column widens the picture instead of being cut off
	far := 0.0
	for _, r := range placed {
		far = math.Max(far, r.x+r.w)
	}
	width = math.Max(width, math.Ceil(far+16))

	// ---- assemble in drawing order: band, arrows, labels, boxes, text
	var scene []Op
	if hasControl {
		scene = append(scene, Op{T: "rect", X: margin - 14, Y: ctrlTop - 28, W: width - 2*margin + 28, H: ctrlH + 28 + 14, R: 12, Fill: cBand, Stroke: cLine, SW: 1})
		scene = append(scene, Op{T: "text", X: margin, Y: ctrlTop - 11, Text: "MANAGEMENT AND CONTROL", Size: 10.5, Bold: true, Anchor: "start", Color: cMuted})
	}
	scene = append(scene, lines...)
	scene = append(scene, arrows...)
	scene = append(scene, halos...)
	for _, b := range boxList {
		accent := cViolet
		if b.node.Lane == "control" {
			accent = cGrey
		} else if b.col%2 == 0 {
			accent = cTeal
		}
		scene = append(scene, Op{T: "rect", X: b.x, Y: b.y, W: b.w, H: b.h, R: 10, Fill: cWhite, Stroke: cInk, SW: 2})
		scene = append(scene, Op{T: "rect", X: b.x + b.w*0.29, Y: b.y - 3, W: b.w * 0.42, H: 6, R: 3, Fill: accent})
	}
	scene = append(scene, Op{T: "text", X: margin, Y: titleY, Text: fit(plan.Title, width-2*margin, 26, true), Size: 26, Bold: true, Anchor: "start", Color: cInk})
	for i, c := range plan.Columns {
		if c.Title != "" {
			gi := min(i, len(gaps)-1)
			extra := 60.0
			if gi >= 0 && gi < len(gaps) {
				extra = gaps[gi]
			}
			scene = append(scene, Op{T: "text", X: colX[i] + nodeW/2, Y: headY, Text: fit(strings.ToUpper(c.Title), nodeW+extra*0.5, 11, true), Size: 11, Bold: true, Anchor: "middle", Color: cMuted})
		}
	}
	for _, b := range boxList {
		y := b.y + pad + 12
		for _, l := range b.label {
			scene = append(scene, Op{T: "text", X: b.x + b.w/2, Y: y, Text: l, Size: 15, Bold: true, Anchor: "middle", Color: cInk})
			y += 18
		}
		y += -18 + 17
		for _, l := range b.detail {
			scene = append(scene, Op{T: "text", X: b.x + b.w/2, Y: y, Text: l, Size: 12, Anchor: "middle", Color: cSoft})
			y += 15
		}
	}
	scene = append(scene, halotexts...)
	return Scene{Width: int(jsRound(width)), Height: int(jsRound(height)), Title: plan.Title, Ops: scene}
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

func ifInt(c bool, a, b int) int {
	if c {
		return a
	}
	return b
}

func opposite(side string) string {
	switch side {
	case "B":
		return "T"
	case "T":
		return "B"
	case "R":
		return "L"
	}
	return "R"
}

// ---- drawing ----------------------------------------------------------------------------------------------------------------

// f is String(Math.round(v * 10) / 10).
func f(v float64) string {
	r := jsRound(v*10) / 10
	if r == 0 {
		r = 0
	}
	return strconv.FormatFloat(r, 'f', -1, 64)
}

func xmlEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;").Replace(s)
}

func num(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }

// RenderSVG is the picture the page shows. Pure drawing instructions: no scripts, no links, no external files.
func RenderSVG(scene Scene, plan DiagramPlan) string {
	var desc []string
	for _, c := range plan.Columns {
		title := c.Title
		if title == "" {
			title = "Column"
		}
		var labels []string
		for _, nd := range c.Nodes {
			labels = append(labels, nd.Label)
		}
		desc = append(desc, title+": "+strings.Join(labels, ", "))
	}
	var body []string
	for _, o := range scene.Ops {
		switch o.T {
		case "rect":
			s := fmt.Sprintf(`<rect x="%s" y="%s" width="%s" height="%s" rx="%s" fill="%s"`, f(o.X), f(o.Y), f(o.W), f(o.H), num(o.R), o.Fill)
			if o.Stroke != "" {
				sw := o.SW
				if sw == 0 {
					sw = 1
				}
				s += fmt.Sprintf(` stroke="%s" stroke-width="%s"`, o.Stroke, num(sw))
			}
			body = append(body, s+"/>")
		case "path":
			var pts []string
			for _, p := range o.Pts {
				pts = append(pts, f(p[0])+" "+f(p[1]))
			}
			s := fmt.Sprintf(`<path d="M%s" fill="none" stroke="%s" stroke-width="2" stroke-linejoin="round"`, strings.Join(pts, " L"), o.Color)
			if o.Dash {
				s += ` stroke-dasharray="7 5"`
			}
			body = append(body, s+"/>")
		case "arrow":
			var pts []string
			for _, p := range o.Pts {
				pts = append(pts, f(p[0])+","+f(p[1]))
			}
			body = append(body, fmt.Sprintf(`<polygon points="%s" fill="%s"/>`, strings.Join(pts, " "), o.Color))
		default:
			s := fmt.Sprintf(`<text x="%s" y="%s" font-size="%s"`, f(o.X), f(o.Y), num(o.Size))
			if o.Bold {
				s += ` font-weight="700"`
			}
			if o.Anchor == "middle" {
				s += ` text-anchor="middle"`
			}
			body = append(body, fmt.Sprintf(`%s fill="%s">%s</text>`, s, o.Color, xmlEscape(o.Text)))
		}
	}
	out := []string{
		fmt.Sprintf(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" width="%d" height="%d" role="img" aria-labelledby="t d" font-family="Helvetica, Arial, 'Liberation Sans', sans-serif">`, scene.Width, scene.Height, scene.Width, scene.Height),
		fmt.Sprintf(`<title id="t">%s - architecture diagram</title><desc id="d">%s</desc>`, xmlEscape(plan.Title), xmlEscape(strings.Join(desc, ". "))),
		fmt.Sprintf(`<rect width="%d" height="%d" fill="#ffffff"/>`, scene.Width, scene.Height),
	}
	out = append(out, body...)
	out = append(out, "</svg>", "")
	return strings.Join(out, "\n")
}
