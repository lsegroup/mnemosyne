// SPDX-License-Identifier: Apache-2.0

// Package llm talks to the AI providers: the connection code (with the fixed addresses of Admin -> LLM, step 2), the model list, and
// (see chat.go) the AI calls themselves.
package llm

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/lsegroup/mnemosyne/admin-go/internal/jobs"
	"github.com/lsegroup/mnemosyne/admin-go/internal/store"
)

// ---- fixed addresses ------------------------------------------------------------------------------------------------

// MaxPins is the most fixed addresses an administrator may set.
const MaxPins = 20

// dnsTimeout is how long the lookup of a host that has a fixed address may take before the fixed address is tried (a variable so a test can shorten it).
var dnsTimeout = 5 * time.Second

// primaryTimeout is how long the addresses DNS gave may be tried for a host that has a fixed address, before the fixed address is tried.
var primaryTimeout = 10 * time.Second

// lookupIP asks DNS (replaced in tests to make the lookup fail the way a real EAI_AGAIN does).
var lookupIP = func(ctx context.Context, host string) ([]net.IPAddr, error) {
	return net.DefaultResolver.LookupIPAddr(ctx, host)
}

func normalizeHost(h string) string {
	return strings.TrimSuffix(strings.ToLower(strings.TrimSpace(h)), ".")
}

func validLabel(l string) bool {
	if l == "" || len(l) > 63 || l[0] == '-' || l[len(l)-1] == '-' {
		return false
	}
	for _, c := range l {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
			return false
		}
	}
	return true
}

var unconnectable = regexp.MustCompile(`^(0\.0\.0\.0|255\.255\.255\.255|::)$`)

// ValidatePins checks the list the admin page sent: rows of {host, ip}. The messages say which row is wrong and why.
func ValidatePins(input any) ([]store.HostPin, error) {
	list, ok := input.([]any)
	if !ok {
		return nil, jobs.Invalid("hosts must be a list")
	}
	if len(list) > MaxPins {
		return nil, jobs.Invalid("at most %d fixed addresses", MaxPins)
	}
	seen := map[string]bool{}
	out := make([]store.HostPin, 0, len(list))
	for i, row := range list {
		n := i + 1
		r, _ := row.(map[string]any)
		hostRaw, _ := r["host"].(string)
		ipRaw, _ := r["ip"].(string)
		host := normalizeHost(hostRaw)
		ip := strings.TrimSpace(ipRaw)
		if hostRaw == "" || host == "" {
			return nil, jobs.Invalid("row %d: the host name is empty", n)
		}
		labelsOK := len(host) <= 253
		for _, l := range strings.Split(host, ".") {
			labelsOK = labelsOK && validLabel(l)
		}
		if !labelsOK {
			return nil, jobs.Invalid(`row %d: "%s" is not a host name (letters, digits, dots and dashes only; no http://, no port, no path)`, n, host)
		}
		if net.ParseIP(host) != nil {
			return nil, jobs.Invalid(`row %d: "%s" is already an IP address; put the host name there`, n, host)
		}
		if ip == "" {
			return nil, jobs.Invalid("row %d: the IP address for %s is empty", n, host)
		}
		if net.ParseIP(ip) == nil {
			return nil, jobs.Invalid(`row %d: "%s" is not an IPv4 or IPv6 address`, n, ip)
		}
		if unconnectable.MatchString(ip) {
			return nil, jobs.Invalid("row %d: %s cannot be connected to", n, ip)
		}
		if seen[host] {
			return nil, jobs.Invalid("row %d: %s is listed twice", n, host)
		}
		seen[host] = true
		out = append(out, store.HostPin{Host: host, IP: ip})
	}
	return out, nil
}

var (
	pinMu sync.RWMutex
	pins  = map[string]string{}
)

// fallbackUsed remembers when a fixed address was last needed (DNS failed and the pin was used), per host.
var fallbackUsed = map[string]time.Time{}

// PinFallbackAt is when the fixed address of host was last used because DNS failed; zero when it was not needed since this program started.
func PinFallbackAt(host string) time.Time {
	pinMu.RLock()
	defer pinMu.RUnlock()
	return fallbackUsed[normalizeHost(host)]
}

// SetPins puts the list in force at once, for the next connection.
func SetPins(list []store.HostPin) {
	m := make(map[string]string, len(list))
	for _, p := range list {
		m[normalizeHost(p.Host)] = p.IP
	}
	pinMu.Lock()
	pins = m
	pinMu.Unlock()
}

func pinned(host string) string {
	pinMu.RLock()
	defer pinMu.RUnlock()
	return pins[normalizeHost(host)]
}

// dial connects the normal way: DNS first. A fixed address is only the FALLBACK: when the normal connection fails (typically the lookup,
// EAI_AGAIN) and the host has a pin, the pinned IP is tried and the use is remembered. DNS is never replaced for a host that resolves: a pin
// that has gone stale cannot break a working provider. The certificate is checked against the host name either way.
func dial(ctx context.Context, network, addr string) (net.Conn, error) {
	d := &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}
	host, port, splitErr := net.SplitHostPort(addr)
	if splitErr != nil {
		return d.DialContext(ctx, network, addr)
	}
	pin := pinned(host)
	if pin == "" || net.ParseIP(host) != nil {
		return d.DialContext(ctx, network, addr) // nothing to fall back on
	}
	// DNS gets a limited time of its own: a lookup that hangs must not use up the whole call before the fallback is tried
	lctx, cancel := context.WithTimeout(ctx, dnsTimeout)
	ips, err := lookupIP(lctx, host)
	cancel()
	var conn net.Conn
	if err == nil {
		pctx, pcancel := context.WithTimeout(ctx, primaryTimeout)
		for _, ip := range ips {
			if conn, err = d.DialContext(pctx, network, net.JoinHostPort(ip.String(), port)); err == nil {
				pcancel()
				return conn, nil
			}
		}
		pcancel()
	}
	// DNS failed (or none of its addresses could be connected to): the pin stands in
	conn, pinErr := d.DialContext(ctx, network, net.JoinHostPort(pin, port))
	if pinErr != nil {
		return nil, err // report the first failure: that is what the provider's own address said
	}
	pinMu.Lock()
	fallbackUsed[normalizeHost(host)] = time.Now()
	pinMu.Unlock()
	return conn, nil
}

// Client is an HTTP client for provider calls: the fixed addresses apply, and one call may take at most timeout.
func Client(timeout time.Duration) *http.Client {
	return &http.Client{Timeout: timeout, Transport: &http.Transport{DialContext: dial, ForceAttemptHTTP2: true, TLSHandshakeTimeout: 15 * time.Second}}
}

// PinCheck is the answer of a fixed-address check.
type PinCheck struct {
	OK     bool   `json:"ok"`
	MS     int64  `json:"ms"`
	Detail string `json:"detail"`
}

// CheckPin opens a TLS connection to ip:port as host and checks the certificate. It sends no request, so it costs nothing and needs no key.
func CheckPin(host, ip string, timeout time.Duration, port string) PinCheck {
	started := time.Now()
	done := func(ok bool, detail string) PinCheck {
		return PinCheck{OK: ok, MS: time.Since(started).Milliseconds(), Detail: detail}
	}
	conn, err := tls.DialWithDialer(&net.Dialer{Timeout: timeout}, "tcp", net.JoinHostPort(ip, port), &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12})
	if err != nil {
		if ne, ok := err.(net.Error); ok && ne.Timeout() {
			return done(false, fmt.Sprintf("no answer from %s:%s within %d seconds", ip, port, int(timeout.Seconds())))
		}
		return done(false, "error: "+err.Error())
	}
	defer conn.Close()
	issuer := "unknown issuer"
	if certs := conn.ConnectionState().PeerCertificates; len(certs) > 0 {
		if o := certs[0].Issuer.Organization; len(o) > 0 {
			issuer = o[0]
		} else if cn := certs[0].Issuer.CommonName; cn != "" {
			issuer = cn
		}
	}
	return done(true, fmt.Sprintf("connected and the certificate is valid for %s (issued by %s)", host, issuer))
}

// ---- the model list -------------------------------------------------------------------------------------------------

const (
	modelsTimeout = 15 * time.Second
	maxBody       = 2_000_000
	maxModels     = 500
)

var versionSuffix = regexp.MustCompile(`/v\d+$`)

// ModelsURL is where the model list lives for each API format.
func ModelsURL(kind, baseURL string) string {
	base := strings.TrimRight(baseURL, "/")
	if kind == store.AnthropicMessages && !versionSuffix.MatchString(base) {
		return base + "/v1/models"
	}
	return base + "/models"
}

// ParseModelIDs pulls model ids out of the shapes providers use: {data:[{id}]}, {models:[{name}]}, [...] or plain strings.
func ParseModelIDs(body any) []string {
	var list []any
	switch t := body.(type) {
	case []any:
		list = t
	case map[string]any:
		if d, ok := t["data"].([]any); ok {
			list = d
		} else if m, ok := t["models"].([]any); ok {
			list = m
		}
	}
	seen := map[string]bool{}
	var ids []string
	for _, item := range list {
		var raw string
		switch t := item.(type) {
		case string:
			raw = t
		case map[string]any:
			if s, ok := t["id"].(string); ok {
				raw = s
			} else if s, ok := t["name"].(string); ok {
				raw = s
			}
		}
		raw = strings.TrimPrefix(strings.TrimSpace(raw), "models/")
		if raw != "" && !seen[raw] {
			seen[raw] = true
			ids = append(ids, raw)
		}
	}
	sort.SliceStable(ids, func(i, j int) bool {
		a, b := strings.ToLower(ids[i]), strings.ToLower(ids[j])
		if a != b {
			return a < b
		}
		return ids[i] > ids[j] // lower case first, like localeCompare
	})
	if len(ids) > maxModels {
		ids = ids[:maxModels]
	}
	return ids
}

// FetchModels asks the provider which models its API key may use (the list call only: no inference, no cost).
func FetchModels(p store.Provider) ([]string, error) {
	req, err := http.NewRequest(http.MethodGet, ModelsURL(p.Kind, p.BaseURL), nil)
	if err != nil {
		return nil, jobs.Invalid("Could not reach the provider (check the base URL and network).")
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.APIKey)
	if p.Kind == store.AnthropicMessages {
		req.Header.Set("x-api-key", p.APIKey)
		req.Header.Set("anthropic-version", "2023-06-01")
	}
	res, err := Client(modelsTimeout).Do(req)
	if err != nil {
		return nil, jobs.Invalid("Could not reach the provider (check the base URL and network).")
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden {
		return nil, jobs.Invalid("The provider rejected the API key (HTTP %d).", res.StatusCode)
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, jobs.Invalid("The provider answered HTTP %d for its model list.", res.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, maxBody+1))
	if err != nil {
		return nil, jobs.Invalid("Could not reach the provider (check the base URL and network).")
	}
	if len(raw) > maxBody {
		return nil, jobs.Invalid("The provider returned an unexpectedly large model list.")
	}
	var body any
	if json.Unmarshal(raw, &body) != nil {
		return nil, jobs.Invalid("The provider did not return a JSON model list.")
	}
	ids := ParseModelIDs(body)
	if len(ids) == 0 {
		return nil, jobs.Invalid("The provider returned no models for this key.")
	}
	return ids, nil
}
