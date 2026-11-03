package auto

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math"
	"math/big"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata" // the time zones of the schedule, also on a server without a zone database

	"github.com/lsegroup/mnemosyne/admin-go/internal/engine"
)

// DayNames are the weekdays, Sunday first (the numbers of a schedule).
var DayNames = []string{"Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"}

// ---- time: the next run in a time zone (daylight saving safe) ----------------------------------------------------------------

// ValidTimeZone reports whether tz is an IANA time zone name.
func ValidTimeZone(tz string) bool {
	if tz == "" || len(tz) > 64 {
		return false
	}
	_, err := time.LoadLocation(tz)
	return err == nil
}

type wall struct{ year, month, day, hour, minute, second int }

func zoned(ts int64, loc *time.Location) wall {
	t := time.UnixMilli(ts).In(loc)
	return wall{t.Year(), int(t.Month()), t.Day(), t.Hour(), t.Minute(), t.Second()}
}

// offsetMs is how far the wall clock of loc is ahead of UTC at this instant.
func offsetMs(ts int64, loc *time.Location) int64 {
	_, off := time.UnixMilli(ts).In(loc).Zone()
	return int64(off) * 1000
}

// zonedInstant is the instant at which the wall clock of loc shows this date and time.
func zonedInstant(y, m, d, hh, mm int, loc *time.Location) int64 {
	guess := time.Date(y, time.Month(m), d, hh, mm, 0, 0, time.UTC).UnixMilli()
	off := offsetMs(guess, loc)
	t := guess - off
	off2 := offsetMs(t, loc)
	if off2 == off {
		return t
	}
	return guess - off2
}

func clock(hhmm string) (int, int) {
	p := strings.SplitN(hhmm, ":", 2)
	h, _ := strconv.Atoi(p[0])
	m, _ := strconv.Atoi(p[1])
	return h, m
}

// NextRun is the first run strictly after `after`; ok is false when a one-time schedule is over.
func NextRun(s Schedule, after time.Time) (time.Time, bool) {
	loc, err := time.LoadLocation(s.TZ)
	if err != nil {
		return time.Time{}, false
	}
	hh, mm := clock(s.Time)
	if s.Mode == "once" {
		parts := strings.Split(s.Date, "-")
		if len(parts) != 3 {
			return time.Time{}, false
		}
		y, _ := strconv.Atoi(parts[0])
		mo, _ := strconv.Atoi(parts[1])
		d, _ := strconv.Atoi(parts[2])
		t := zonedInstant(y, mo, d, hh, mm, loc)
		if t > after.UnixMilli() {
			return time.UnixMilli(t).UTC(), true
		}
		return time.Time{}, false
	}
	base := zoned(after.UnixMilli(), loc)
	for i := 0; i < 9; i++ {
		day := time.Date(base.year, time.Month(base.month), base.day+i, 0, 0, 0, 0, time.UTC)
		wd := int(day.Weekday())
		on := false
		for _, d := range s.Days {
			if d == wd {
				on = true
			}
		}
		if !on {
			continue
		}
		t := zonedInstant(day.Year(), int(day.Month()), day.Day(), hh, mm, loc)
		if t > after.UnixMilli() {
			return time.UnixMilli(t).UTC(), true
		}
	}
	return time.Time{}, false
}

// DescribeSchedule is the schedule in words.
func DescribeSchedule(s Schedule) string {
	at := s.Time + " " + s.TZ
	if s.Mode == "once" {
		return "once, on " + s.Date + " at " + at
	}
	// in the order of the week, Monday first ("Saturday and Sunday", not "Sunday and Saturday")
	days := append([]int{}, s.Days...)
	sort.SliceStable(days, func(i, j int) bool { return (days[i]+6)%7 < (days[j]+6)%7 })
	var names []string
	for _, d := range days {
		names = append(names, DayNames[d])
	}
	return "every " + joinAnd(names) + " at " + at
}

// RunsPerMonth is how many runs a month the schedule can make at most (for the monthly ceiling).
func RunsPerMonth(s Schedule) int {
	if s.Mode == "once" {
		return 1
	}
	return int(math.Ceil(float64(len(s.Days)*52) / 12))
}

func triggerName(s Schedule, scheduledFor time.Time) string {
	if s.Mode == "once" {
		return "One-time schedule " + s.Date + " " + s.Time
	}
	loc, _ := time.LoadLocation(s.TZ)
	p := zoned(scheduledFor.UnixMilli(), loc)
	day := time.Date(p.year, time.Month(p.month), p.day, 0, 0, 0, 0, time.UTC).Weekday()
	return DayNames[day] + " " + s.Time + " schedule"
}

// ---- which projects changed ------------------------------------------------------------------------------------------------

// ProjectState is what a run would do for one project.
type ProjectState struct {
	Project     string  `json:"project"`
	Notes       int     `json:"notes"`
	HasArticle  bool    `json:"hasArticle"`
	LastArticle *string `json:"lastArticle"`
	// TextDue: the notes changed since the newest article (or there is none): the article should be rewritten.
	TextDue bool `json:"textDue"`
	// ChartsDue: the newest diagram is missing or was not made from the newest article.
	ChartsDue bool `json:"chartsDue"`
	// Detail is plain words for the list, e.g. "6 notes new or changed".
	Detail string `json:"detail"`
}

func plural(n int, one, many string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, one)
	}
	return fmt.Sprintf("%d %s", n, many)
}

// Inspect works out what a run would do for one project. Articles made with fingerprints are compared note by note. An older article has
// none: it counts as changed when a note is dated after it or the number of notes differs.
func Inspect(project string, notes []engine.Note, wiki, diagram *engine.DocMeta) ProjectState {
	st := ProjectState{Project: project, Notes: len(notes), HasArticle: wiki != nil}
	if wiki == nil {
		st.TextDue, st.ChartsDue, st.Detail = true, true, "no article yet"
		return st
	}
	st.LastArticle = &wiki.GeneratedAt
	changed, how := 0, ""
	if wiki.NoteHashes != nil {
		now := engine.NoteHashes(notes)
		for id, h := range now {
			if wiki.NoteHashes[id] != h {
				changed++
			}
		}
		for id := range wiki.NoteHashes {
			if _, ok := now[id]; !ok {
				changed++
			}
		}
		how = plural(changed, "note new or changed", "notes new or changed")
	} else {
		day := wiki.GeneratedAt[:10]
		newer := 0
		for _, n := range notes {
			if n.ObservedAt != nil && len(*n.ObservedAt) >= 10 && (*n.ObservedAt)[:10] > day {
				newer++
			}
		}
		switch {
		case newer > 0:
			changed = newer
		case wiki.NoteCount != nil && *wiki.NoteCount != len(notes):
			changed = 1
		}
		if newer > 0 {
			how = plural(newer, "note newer than the article", "notes newer than the article")
		} else {
			how = "the number of notes differs"
		}
	}
	if changed > 0 {
		st.TextDue, st.ChartsDue, st.Detail = true, true, how
		return st
	}
	stale := diagram == nil || diagram.BasedOn != wiki.ID
	st.ChartsDue = stale
	switch {
	case !stale:
		st.Detail = "up to date"
	case diagram != nil:
		st.Detail = "charts older than the article"
	default:
		st.Detail = "no charts yet"
	}
	return st
}

// WouldRun is what one run would do for a project with these ticks.
func WouldRun(s ProjectState, cfg Config) (text, charts bool) {
	text = cfg.Text && s.TextDue
	charts = cfg.Charts && (s.ChartsDue || text) && (s.HasArticle || text)
	return
}

// ---- the setup an administrator submits, and the fingerprint the agreement is bound to --------------------------------------------

var (
	reTime = regexp.MustCompile(`^([01]\d|2[0-3]):([0-5]\d)$`)
	reDate = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
)

// toNumber is JavaScript's Number(v) for a JSON value.
func toNumber(v any) float64 {
	switch t := v.(type) {
	case nil:
		return 0
	case bool:
		if t {
			return 1
		}
		return 0
	case float64:
		return t
	case string:
		s := engine.JSTrim(t)
		if s == "" {
			return 0
		}
		f, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return math.NaN()
		}
		return f
	}
	return math.NaN()
}

// Input is a checked setup, ready to be saved.
type Input struct {
	Schedule Schedule
	Projects []string
	Known    []string
	Text     bool
	Charts   bool
	LimitUSD float64
}

// ParseInput checks what the page submitted; it fails with a plain message.
func ParseInput(input any, known []string, now time.Time) (Input, error) {
	b, _ := input.(map[string]any)
	s, _ := b["schedule"].(map[string]any)
	mode := "weekly"
	if s["mode"] == "once" {
		mode = "once"
	}
	t, _ := s["time"].(string)
	t = engine.JSTrim(t)
	if !reTime.MatchString(t) {
		return Input{}, invalid("The start time must be on the 24-hour clock and look like 02:00 or 23:30.")
	}
	tz, _ := s["tz"].(string)
	tz = engine.JSTrim(tz)
	if !ValidTimeZone(tz) {
		return Input{}, invalid("Choose a time zone from the list.")
	}
	sched := Schedule{Mode: mode, Days: []int{}, Time: t, TZ: tz}
	if mode == "weekly" {
		raw, _ := s["days"].([]any)
		seen := map[int]bool{}
		for _, d := range raw {
			n := toNumber(d)
			if n == math.Trunc(n) && n >= 0 && n <= 6 && !seen[int(n)] {
				seen[int(n)] = true
				sched.Days = append(sched.Days, int(n))
			}
		}
		sort.Ints(sched.Days)
		if len(sched.Days) == 0 {
			return Input{}, invalid("Pick at least one weekday.")
		}
	} else {
		date, _ := s["date"].(string)
		date = engine.JSTrim(date)
		// like JavaScript's Date.parse: a month 1-12 and a day 1-31 are accepted (Feb 30 is March 2), which is then found to be in the past
		if !reDate.MatchString(date) || !plausibleDate(date) {
			return Input{}, invalid("Choose the date of the one-time run.")
		}
		sched.Date = date
		if _, ok := NextRun(sched, now); !ok {
			return Input{}, invalid("That date and time is already in the past.")
		}
	}
	wantedRaw, _ := b["projects"].([]any)
	all := map[string]bool{}
	for _, k := range known {
		all[k] = true
	}
	var projects []string
	seen := map[string]bool{}
	for _, p := range wantedRaw {
		if name, ok := p.(string); ok && !seen[name] && all[name] {
			seen[name] = true
			projects = append(projects, name)
		}
	}
	sort.Strings(projects)
	if len(projects) == 0 {
		return Input{}, invalid("Tick at least one project.")
	}
	text, charts := b["text"] == true, b["charts"] == true
	if !text && !charts {
		return Input{}, invalid("Tick TEXT, AI flow charts, or both.")
	}
	var limit float64
	if f, ok := b["limitUsd"].(float64); ok {
		limit = f
	} else {
		var raw string
		if v := b["limitUsd"]; v != nil {
			raw, _ = v.(string)
		}
		limit = toNumber(strings.ReplaceAll(raw, ",", "."))
	}
	if math.IsNaN(limit) || math.IsInf(limit, 0) || limit <= 0 || limit > 100_000 {
		return Input{}, invalid("The spending limit must be a positive amount in US dollars.")
	}
	sortedKnown := append([]string{}, known...)
	sort.Strings(sortedKnown)
	return Input{Schedule: sched, Projects: projects, Known: sortedKnown, Text: text, Charts: charts, LimitUSD: math.Floor(limit*100+0.5) / 100}, nil
}

// AgreementKey is the fingerprint of everything the agreement covers. modelKey stands for the model and the token limits and prompts of
// the jobs.
func AgreementKey(cfg Config, modelKey string) string {
	projects := append([]string{}, cfg.Projects...)
	sort.Strings(projects)
	days := cfg.Schedule.Days
	if days == nil {
		days = []int{}
	}
	var date any
	if cfg.Schedule.Date != "" {
		date = cfg.Schedule.Date
	}
	type sched struct {
		Mode string `json:"mode"`
		Days []int  `json:"days"`
		Date any    `json:"date"`
		Time string `json:"time"`
		TZ   string `json:"tz"`
	}
	doc := struct {
		P []string `json:"p"`
		T bool     `json:"t"`
		C bool     `json:"c"`
		L float64  `json:"l"`
		S sched    `json:"s"`
		M string   `json:"m"`
	}{projects, cfg.Text, cfg.Charts, cfg.LimitUSD, sched{cfg.Schedule.Mode, days, date, cfg.Schedule.Time, cfg.Schedule.TZ}, modelKey}
	sum := sha256.Sum256([]byte(engine.JSON(doc)))
	return hex.EncodeToString(sum[:])
}

// ---- cost summary shown live and in the agreement popup ------------------------------------------------------------------------

// Estimate is the cost of one project's calls: typical and worst case; nil when the model has no list price.
type Estimate struct {
	TextTypical, TextWorst, ChartsTypical, ChartsWorst *float64
}

// ToFixed2 is Number.prototype.toFixed(2): the closest value to the exact number, the larger one when two are equally close.
func ToFixed2(x float64) string {
	r := new(big.Rat)
	if r.SetFloat64(math.Abs(x)) == nil {
		return "NaN"
	}
	r.Mul(r, big.NewRat(100, 1))
	r.Add(r, big.NewRat(1, 2))
	n := new(big.Int).Div(r.Num(), r.Denom())
	s := n.String()
	for len(s) < 3 {
		s = "0" + s
	}
	out := s[:len(s)-2] + "." + s[len(s)-2:]
	if x < 0 && out != "0.00" {
		out = "-" + out
	}
	return out
}

// USD is the amount the way the page writes it: $12.34, or $<0.01.
func USD(n float64) string {
	if n < 0.01 {
		return "$<0.01"
	}
	return "$" + ToFixed2(n)
}

func sum(xs []*float64) *float64 {
	total := 0.0
	for _, x := range xs {
		if x == nil {
			return nil
		}
		total += *x
	}
	return &total
}

func zero() *float64 { z := 0.0; return &z }

// Summary is what the Auto tab shows.
type Summary struct {
	// Live are the rows for the Auto tab, step 4.
	Live [][2]string `json:"live"`
	// Agree are the rows for the agreement popup.
	Agree [][2]string `json:"agree"`
	// WorstRun is the worst case of one run, in US dollars.
	WorstRun *float64 `json:"worstRun"`
}

// Row is one selected project with its state and its estimate.
type Row struct {
	State ProjectState
	Est   Estimate
}

// Summarize is the cost summary of a setup.
func Summarize(cfg Config, rows []Row, modelLabel string) Summary {
	n := len(rows)
	pick := func(use bool, v *float64) *float64 {
		if !use {
			return zero()
		}
		return v
	}
	var typicalOne, worstOne []*float64
	for _, r := range rows {
		typicalOne = append(typicalOne, sum([]*float64{pick(cfg.Text, r.Est.TextTypical), pick(cfg.Charts, r.Est.ChartsTypical)}))
		worstOne = append(worstOne, sum([]*float64{pick(cfg.Text, r.Est.TextWorst), pick(cfg.Charts, r.Est.ChartsWorst)}))
	}
	var nowCost []*float64
	changed := 0
	for _, r := range rows {
		text, charts := WouldRun(r.State, cfg)
		if text || charts {
			changed++
		}
		nowCost = append(nowCost, sum([]*float64{pick(text, r.Est.TextTypical), pick(charts, r.Est.ChartsTypical)}))
	}
	typicalNow := sum(nowCost)
	worstRun := sum(worstOne)
	var avgTypical *float64
	if t := sum(typicalOne); t != nil {
		v := *t / math.Max(1, float64(n))
		avgTypical = &v
	}
	var maxWorst *float64
	if worstRun != nil {
		m := 0.0
		for _, w := range worstOne {
			m = math.Max(m, *w)
		}
		maxWorst = &m
	}
	avg := func(f func(Estimate) *float64) *float64 {
		var list []*float64
		for _, r := range rows {
			list = append(list, f(r.Est))
		}
		if v := sum(list); v != nil {
			a := *v / math.Max(1, float64(n))
			return &a
		}
		return nil
	}
	var parts []string
	t, c := avg(func(e Estimate) *float64 { return e.TextTypical }), avg(func(e Estimate) *float64 { return e.ChartsTypical })
	q := func(v *float64) string {
		if v == nil {
			return "?"
		}
		return USD(*v)
	}
	if cfg.Text {
		parts = append(parts, "text "+q(t))
	}
	if cfg.Charts {
		parts = append(parts, "charts "+q(c))
	}
	runs := RunsPerMonth(cfg.Schedule)
	ceiling := cfg.LimitUSD * float64(runs)
	var creates []string
	if cfg.Text {
		creates = append(creates, "TEXT")
	}
	if cfg.Charts {
		creates = append(creates, "AI flow charts")
	}
	names := strings.Join(cfg.Projects, ", ")
	if len(cfg.Projects) > 12 {
		names = fmt.Sprintf("%s and %d more", strings.Join(cfg.Projects[:12], ", "), len(cfg.Projects)-12)
	}
	unknown := func(v *float64, f func(float64) string, none string) string {
		if v == nil {
			return none
		}
		return f(*v)
	}
	runWord := "runs"
	if runs == 1 {
		runWord = "run"
	}
	estimate := "unknown"
	if typicalNow != nil && worstRun != nil {
		estimate = fmt.Sprintf("about %s now, at most %s", USD(*typicalNow), USD(*worstRun))
	}
	return Summary{
		WorstRun: worstRun,
		Live: [][2]string{
			{"Model for TEXT and charts", modelLabel},
			{"One project, typical", unknown(avgTypical, func(v float64) string { return fmt.Sprintf("about %s (%s)", USD(v), strings.Join(parts, " + ")) }, "unknown (no list price for this model)")},
			{"One project, worst case", unknown(maxWorst, func(v float64) string { return fmt.Sprintf("at most %s (every token limit fully used)", USD(v)) }, "unknown")},
			{"This run if started now", unknown(typicalNow, func(v float64) string {
				return fmt.Sprintf("about %s for the %d selected projects, %d of them with changes", USD(v), n, changed)
			}, "unknown")},
			{"Worst case of one run", unknown(worstRun, func(v float64) string {
				return fmt.Sprintf("at most %s (all %d selected projects change)", USD(v), n)
			}, "unknown")},
		},
		Agree: [][2]string{
			{"Schedule", DescribeSchedule(cfg.Schedule)},
			{"Provider / model", modelLabel},
			{"Projects", fmt.Sprintf("%d selected (%s)", n, names)},
			{"Creates", strings.Join(creates, " and ") + ", only for projects whose notes changed"},
			{"Estimated cost of one run", estimate},
			{"Your spending limit", fmt.Sprintf("a run stops at %s → at most %s a month (%d %s)", USD(cfg.LimitUSD), USD(ceiling), runs, runWord)},
		},
	}
}

// FormatDuration is "67 min 19 s", "2 h 17 min", "42 s".
func FormatDuration(ms int64) string {
	s := int64(math.Max(0, math.Floor(float64(ms)/1000+0.5)))
	if s < 60 {
		return fmt.Sprintf("%d s", s)
	}
	m := s / 60
	if m < 60 {
		return fmt.Sprintf("%d min %d s", m, s%60)
	}
	return fmt.Sprintf("%d h %d min", m/60, m%60)
}

func plausibleDate(date string) bool {
	m, _ := strconv.Atoi(date[5:7])
	d, _ := strconv.Atoi(date[8:10])
	return m >= 1 && m <= 12 && d >= 1 && d <= 31
}
