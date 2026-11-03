// SPDX-License-Identifier: Apache-2.0

// Package audit is the append-only audit trail of the portal (JSON lines): who signed in or failed to, and every change made in the
// admin page. Same file, same line format and same rotation as the Node server, so both can write to it.
package audit

import (
	"bufio"
	"bytes"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Event is one line of the trail.
type Event struct {
	Time        string  `json:"time"`
	Event       string  `json:"event"`
	EntityType  string  `json:"entityType"`
	EntityID    string  `json:"entityId"`
	EntityName  string  `json:"entityName"`
	User        string  `json:"user"`
	IP          string  `json:"ip"`
	Changes     *string `json:"changes"`
	Description string  `json:"description"`
}

// Input is what a caller says about an event; the time is added.
type Input struct {
	Event       string
	EntityType  string
	EntityID    string
	EntityName  string
	User        string
	IP          string
	Changes     string
	Description string
}

const (
	maxBytes   = 10 * 1024 * 1024
	keepRolled = 3
	// Page is the most events one list call returns.
	Page = 500
)

// Log writes and reads the trail. Safe for concurrent use.
type Log struct {
	file string
	mu   sync.Mutex
}

// New returns a log writing to file.
func New(file string) *Log { return &Log{file: file} }

// Write appends an event. It never fails the caller: an audit problem must not take the portal down.
func (l *Log) Write(in Input) {
	ev := Event{
		Time:        time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Event:       in.Event,
		EntityType:  in.EntityType,
		EntityID:    in.EntityID,
		EntityName:  in.EntityName,
		User:        orDefault(in.User, "anonymous"),
		IP:          in.IP,
		Description: in.Description,
	}
	if in.Changes != "" {
		c := in.Changes
		ev.Changes = &c
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(ev); err != nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(l.file), 0o755); err != nil {
		return
	}
	l.rotateIfNeeded()
	f, err := os.OpenFile(l.file, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.Write(buf.Bytes())
}

func orDefault(v, d string) string {
	if v == "" {
		return d
	}
	return v
}

func (l *Log) rotateIfNeeded() {
	st, err := os.Stat(l.file)
	if err != nil || st.Size() < maxBytes {
		return
	}
	_ = os.Remove(roll(l.file, keepRolled))
	for i := keepRolled - 1; i >= 1; i-- {
		_ = os.Rename(roll(l.file, i), roll(l.file, i+1))
	}
	_ = os.Rename(l.file, roll(l.file, 1))
}

func roll(file string, n int) string { return file + "." + string(rune('0'+n)) }

// read returns every parsable event, oldest first. A torn line must not hide the rest.
func (l *Log) read() ([]Event, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	f, err := os.Open(l.file)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	defer f.Close()
	var out []Event
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var e Event
		if json.Unmarshal(line, &e) == nil {
			out = append(out, e)
		}
	}
	return out, sc.Err()
}

// List returns the events newest first; q matches any text field, case-insensitively. total is the number of matches.
func (l *Log) List(q string, offset, limit int) ([]Event, int, error) {
	all, err := l.read()
	if err != nil {
		return nil, 0, err
	}
	q = strings.ToLower(strings.TrimSpace(q))
	matched := make([]Event, 0, len(all))
	for i := len(all) - 1; i >= 0; i-- {
		e := all[i]
		if q == "" || e.matches(q) {
			matched = append(matched, e)
		}
	}
	if offset < 0 {
		offset = 0
	}
	if limit <= 0 || limit > Page {
		limit = Page
	}
	if offset > len(matched) {
		offset = len(matched)
	}
	end := offset + limit
	if end > len(matched) {
		end = len(matched)
	}
	return matched[offset:end], len(matched), nil
}

func (e Event) matches(q string) bool {
	changes := ""
	if e.Changes != nil {
		changes = *e.Changes
	}
	for _, v := range []string{e.Event, e.EntityType, e.EntityID, e.EntityName, e.User, e.IP, changes, e.Description} {
		if strings.Contains(strings.ToLower(v), q) {
			return true
		}
	}
	return false
}

// CountSince is how many events of this kind were written at or after sinceISO (the daily AI spending cap).
func (l *Log) CountSince(sinceISO, event string) int {
	all, _ := l.read()
	n := 0
	for _, e := range all {
		if e.Event == event && e.Time >= sinceISO {
			n++
		}
	}
	return n
}

// Since returns every event at or after sinceISO, oldest first (the current file only).
func (l *Log) Since(sinceISO string) []Event {
	all, _ := l.read()
	var out []Event
	for _, e := range all {
		if e.Time >= sinceISO {
			out = append(out, e)
		}
	}
	return out
}

// ClientIP is the address of the caller behind our own reverse proxy: the shared gateway adds the real peer as the LAST
// X-Forwarded-For entry, so that one is trusted (a header the client sent can only sit before it) and only when the direct
// peer is local.
func ClientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	peer := strings.TrimPrefix(host, "::ffff:")
	if peer == "127.0.0.1" || peer == "::1" {
		var parts []string
		for _, p := range strings.Split(strings.Join(r.Header.Values("X-Forwarded-For"), ","), ",") {
			if p = strings.TrimSpace(p); p != "" {
				parts = append(parts, p)
			}
		}
		if len(parts) > 0 {
			return strings.TrimPrefix(parts[len(parts)-1], "::ffff:")
		}
	}
	if peer == "" {
		return "unknown"
	}
	return peer
}

// KV is one key and value of a before/after comparison, in the order they should be shown.
type KV struct {
	Key   string
	Value any
}

// DiffLines is `- key: "old"` / `+ key: "new"` for the fields that differ (a value is compared and shown as JSON, like the Node
// server does); keys named in secrets are masked. Empty when nothing differs.
func DiffLines(before, after []KV, secrets ...string) string {
	show := func(k string, v any) string {
		for _, s := range secrets {
			if s == k {
				return `"••••"`
			}
		}
		return jsonOf(v)
	}
	get := func(list []KV, k string) (any, bool) {
		for _, kv := range list {
			if kv.Key == k {
				return kv.Value, true
			}
		}
		return nil, false
	}
	var keys []string
	seen := map[string]bool{}
	for _, list := range [][]KV{before, after} {
		for _, kv := range list {
			if !seen[kv.Key] {
				seen[kv.Key] = true
				keys = append(keys, kv.Key)
			}
		}
	}
	var lines []string
	for _, k := range keys {
		b, bok := get(before, k)
		a, aok := get(after, k)
		if bok && aok && jsonOf(b) == jsonOf(a) {
			continue
		}
		if bok && b != nil && b != "" {
			lines = append(lines, "- "+k+": "+show(k, b))
		}
		if aok && a != nil && a != "" {
			lines = append(lines, "+ "+k+": "+show(k, a))
		}
	}
	return strings.Join(lines, "\n")
}

func jsonOf(v any) string {
	if v == nil {
		return "undefined"
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	return strings.TrimRight(buf.String(), "\n")
}

// JSON is v the way JavaScript's JSON.stringify prints it (no HTML escaping); nil is "undefined".
func JSON(v any) string { return jsonOf(v) }
