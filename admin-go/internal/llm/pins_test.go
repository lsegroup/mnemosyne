// SPDX-License-Identifier: Apache-2.0

package llm

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/lsegroup/mnemosyne/admin-go/internal/store"
)

// A fixed address is the FALLBACK: DNS is asked first, the pin only stands in when the connection fails.
func TestAFixedAddressIsOnlyUsedWhenDNSFails(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("ok")) }))
	defer srv.Close()
	u, _ := url.Parse(srv.URL)
	get := func(host string) error {
		res, err := Client(15 * time.Second).Get("http://" + host + ":" + u.Port() + "/")
		if err == nil {
			res.Body.Close()
		}
		return err
	}
	oldLookup, oldDNS := lookupIP, dnsTimeout
	defer func() { lookupIP, dnsTimeout = oldLookup, oldDNS; SetPins(nil) }()
	dnsTimeout = time.Second

	// DNS does not answer ("temporary failure in name resolution"): with a pin the call goes through the pinned address
	lookupIP = func(context.Context, string) ([]net.IPAddr, error) {
		return nil, &net.DNSError{Err: "temporary failure in name resolution", Name: "api.example.test", IsTemporary: true}
	}
	SetPins([]store.HostPin{{Host: "api.example.test", IP: "127.0.0.1"}})
	if err := get("api.example.test"); err != nil {
		t.Fatalf("the pin should stand in when DNS fails: %v", err)
	}
	if PinFallbackAt("api.example.test").IsZero() {
		t.Error("the use of the fallback is remembered")
	}

	// DNS answers: a pin - even a wrong one - is NOT used, so a stale pin cannot break a working provider
	lookupIP = func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("127.0.0.1")}}, nil
	}
	SetPins([]store.HostPin{{Host: "other.example.test", IP: "203.0.113.9"}})
	if err := get("other.example.test"); err != nil {
		t.Fatalf("DNS answers, the (wrong) pin must not be used: %v", err)
	}
	if !PinFallbackAt("other.example.test").IsZero() {
		t.Error("the pin was not needed")
	}

}
