// Package engine writes the project documentation: it reads the notes, builds the prompts, makes the one AI call per job, draws the
// architecture diagrams itself and stores the results. It is the Go port of docs.ts, docgen.ts, diagram.ts and llm-call-chat.ts and must
// behave exactly like them: the stored articles, their fingerprints and the pictures are shared with the Node server.
package engine

import (
	"bytes"
	"encoding/json"
	"regexp"
	"strings"
	"unicode/utf16"
)

// ws is JavaScript's \s: Go's own \s knows only ASCII white space.
const ws = `[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`

func isJSSpace(r rune) bool {
	switch {
	case r == '\t' || r == '\n' || r == '\v' || r == '\f' || r == '\r' || r == ' ':
		return true
	case r == 0xa0 || r == 0x1680 || (r >= 0x2000 && r <= 0x200a) || r == 0x2028 || r == 0x2029 || r == 0x202f || r == 0x205f || r == 0x3000 || r == 0xfeff:
		return true
	}
	return false
}

// JSTrim is String.prototype.trim.
func JSTrim(s string) string { return strings.TrimFunc(s, isJSSpace) }

// JSLen is the length of s the way JavaScript counts it (UTF-16 code units).
func JSLen(s string) int { return len(utf16.Encode([]rune(s))) }

// JSON is JSON.stringify without indentation: no HTML escaping, and U+2028/U+2029 left as they are.
func JSON(v any) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return "null"
	}
	return unescapeLineSeparators(strings.TrimRight(buf.String(), "\n"))
}

// JSONIndent is JSON.stringify(v, null, 2).
func JSONIndent(v any) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		return "null"
	}
	return unescapeLineSeparators(strings.TrimRight(buf.String(), "\n"))
}

// unescapeLineSeparators turns the \u2028 and \u2029 that Go writes into the characters themselves, as JSON.stringify leaves them. An
// escaped backslash in front of "u2028" is text and stays.
func unescapeLineSeparators(s string) string {
	if !strings.Contains(s, "\\u202") {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+1 < len(s) {
			switch {
			case s[i+1] == '\\':
				b.WriteString("\\\\")
				i++
				continue
			case strings.HasPrefix(s[i+1:], "u2028"):
				b.WriteRune(rune(0x2028))
				i += 5
				continue
			case strings.HasPrefix(s[i+1:], "u2029"):
				b.WriteRune(rune(0x2029))
				i += 5
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// Slug is how a project name or GitLab path is compared and keyed: lower case, letters and digits, one dash between words.
func Slug(s string) string {
	return strings.Trim(regexp.MustCompile(`[^a-z0-9]+`).ReplaceAllString(strings.ToLower(s), "-"), "-")
}

// ---- redact: mask anything that looks like a credential -----------------------------------------------------------------

var (
	rePrivateKey = regexp.MustCompile(`(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----`)
	reToken      = regexp.MustCompile(`\b(glpat-|ghp_|github_pat_|hvs\.|xox[bp]-|sk-)[A-Za-z0-9_-]{16,}`)
	reAWS        = regexp.MustCompile(`\bAKIA[0-9A-Z]{16}\b`)
	reBearer     = regexp.MustCompile(`\b(Bearer|Basic)` + ws + `+[A-Za-z0-9._~+/=-]{20,}`)
	// the prefix of "password: value"; the value (which RE2 cannot describe with a look-ahead and a back-reference) is read by hand
	reSecretKey = regexp.MustCompile("(?i)\\b((?:pass(?:word|wd)?|secret|token|api[_-]?key|private[_-]?key|client[_-]?secret)" + ws + "*[:=]" + ws + "*)([\"'`]?)")
)

// Redact masks private keys, well-known token shapes, cloud keys, Bearer/Basic credentials and "password: value" pairs.
func Redact(text string) string {
	text = rePrivateKey.ReplaceAllString(text, "[redacted private key]")
	text = reToken.ReplaceAllString(text, "[redacted token]")
	text = reAWS.ReplaceAllString(text, "[redacted key]")
	text = reBearer.ReplaceAllString(text, "${1} [redacted]")
	return redactPairs(text)
}

func redactPairs(s string) string {
	var out strings.Builder
	last := 0 // everything before this is already written
	for _, m := range reSecretKey.FindAllStringSubmatchIndex(s, -1) {
		if m[0] < last {
			continue // inside a value that was already replaced
		}
		prefixEnd, quote := m[3], s[m[4]:m[5]]
		rest := s[m[5]:]
		if strings.HasPrefix(rest, "[redacted") {
			continue
		}
		n, runes := 0, 0
		for _, r := range rest {
			if isJSSpace(r) || r == '"' || r == '\'' || r == '`' || r == ',' || r == ';' || r == ')' {
				break
			}
			n += len(string(r))
			runes++
		}
		if runes < 6 || !strings.HasPrefix(rest[n:], quote) {
			continue
		}
		out.WriteString(s[last:m[0]])
		out.WriteString(s[m[2]:prefixEnd])
		out.WriteString("[redacted]")
		last = m[5] + n + len(quote)
	}
	out.WriteString(s[last:])
	return out.String()
}
