// SPDX-License-Identifier: Apache-2.0

package web

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/lsegroup/mnemosyne/admin-go/internal/config"
	"github.com/lsegroup/mnemosyne/admin-go/internal/supervisor"
)

func freePort(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	_, port, _ := net.SplitHostPort(l.Addr().String())
	return port
}

// TestTheRealNodeServerBehindTheGoAdmin starts the REAL Node server (the build of the Mnemosyne repository) as a child of the Go admin's
// supervisor, with the admin switched off there, and talks to it only through the Go server: that is the shape of the cut-over.
func TestTheRealNodeServerBehindTheGoAdmin(t *testing.T) {
	root, _ := filepath.Abs(filepath.Join("..", ".."))
	dist := os.Getenv("MNEMOSYNE_NODE_DIST")
	if dist == "" {
		dist = filepath.Join(root, "..", "packages", "server", "dist")
	}
	entry := filepath.Join(dist, "bin", "mnemosyne.js")
	if _, err := os.Stat(entry); err != nil {
		t.Skip("the Node build is not at hand (set MNEMOSYNE_NODE_DIST)")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}

	dir := t.TempDir()
	writeNote(t, dir, "alpha", "alpha-one", "2026-10-20", "Alpha runs on port 3000 and nothing else.")
	nodePort := freePort(t)

	ts := httptest.NewUnstartedServer(nil)
	origin := "http://" + ts.Listener.Addr().String()
	env := map[string]string{
		"MNEMOSYNE_REPO": dir, "MNEMOSYNE_SECRET": testSecret, "MNEMOSYNE_PUBLIC_URL": origin,
		"MNEMOSYNE_UPSTREAM":         "http://127.0.0.1:" + nodePort,
		"MNEMOSYNE_LOCAL_ADMIN_USER": "Admin", "MNEMOSYNE_LOCAL_ADMIN_PASSWORD": "correct horse",
	}
	cfg, err := config.Load(func(k string) string { return env[k] }, dir)
	if err != nil {
		t.Fatal(err)
	}
	srv, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ts.Config.Handler = srv
	ts.Start()
	defer ts.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sup := supervisor.Start(ctx, supervisor.Spec{
		Command: []string{node, entry, "serve", "--http"},
		Dir:     dir,
		Env: []string{
			"MNEMOSYNE_REPO=" + dir, "MNEMOSYNE_SECRET=" + testSecret, "MNEMOSYNE_PUBLIC_URL=" + origin,
			"MNEMOSYNE_ADMIN_EXTERNAL=1", "MNEMOSYNE_HTTP_HOST=127.0.0.1", "MNEMOSYNE_HTTP_PORT=" + nodePort,
			"MNEMOSYNE_GIT=false", "MNEMOSYNE_EMBED_BACKEND=hash", "MNEMOSYNE_EMBED_DIM=256",
		},
		Stdout: nil, Stderr: nil,
	})
	defer func() { cancel(); sup.Wait() }()

	client := &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	get := func(url string, headers map[string]string) (int, string, http.Header) {
		req, _ := http.NewRequest(http.MethodGet, url, nil)
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		res, err := client.Do(req)
		if err != nil {
			return 0, err.Error(), nil
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b), res.Header
	}
	base := ts.URL + cfg.BasePath
	up := false
	for i := 0; i < 120 && !up; i++ {
		if code, _, _ := get(base+"/health", nil); code == 200 {
			up = true
		} else {
			time.Sleep(250 * time.Millisecond)
		}
	}
	if !up {
		t.Fatal("the Node server did not come up behind the Go admin")
	}

	// everything that is not the admin reaches the real Node server through the Go program
	code, body, _ := get(base+"/health", nil)
	eq(t, code, 200, "health")
	has(t, body, `"service":"mnemosyne"`)
	code, body, _ = get(base+"/", nil)
	eq(t, code, 200, "the public sign-in page")
	has(t, body, "Mnemosyne")
	code, _, _ = get(base+"/assets/logo.webp", nil)
	eq(t, code, 200, "the logo")

	// the admin is the Go program's: its own sign-in page, and the Node server itself no longer knows /admin
	code, body, _ = get(base+"/admin/", nil)
	eq(t, code, 200, "the admin sign-in")
	has(t, body, "Administration")
	code, body, _ = get("http://127.0.0.1:"+nodePort+cfg.BasePath+"/admin/", nil)
	eq(t, code, 404, "Node itself on /admin")
	has(t, body, "The admin is not part of this server.")

	// REST and MCP go through unchanged
	search := func() (int, string) {
		req, _ := http.NewRequest(http.MethodPost, base+"/search", strings.NewReader(`{"query":"port 3000"}`))
		req.Header.Set("Content-Type", "application/json")
		res, err := client.Do(req)
		if err != nil {
			return 0, err.Error()
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}
	code2, found := search()
	eq(t, code2, 200, "REST search")
	_ = found

	mcp := func(session, payload string) (*http.Response, string) {
		req, _ := http.NewRequest(http.MethodPost, base+"/mcp", strings.NewReader(payload))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		if session != "" {
			req.Header.Set("Mcp-Session-Id", session)
		}
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res, string(b)
	}
	res, answer := mcp("", `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"e2e","version":"0"}}}`)
	eq(t, res.StatusCode, 200, "MCP initialize")
	session := res.Header.Get("Mcp-Session-Id")
	if session == "" {
		t.Fatalf("no MCP session through the proxy: %s", answer)
	}
	has(t, answer, "serverInfo")
	_, _ = mcp(session, `{"jsonrpc":"2.0","method":"notifications/initialized"}`)
	res, answer = mcp(session, `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	eq(t, res.StatusCode, 200, "MCP tools/list in the same session")
	var tools struct {
		Result struct {
			Tools []struct{ Name string } `json:"tools"`
		} `json:"result"`
	}
	if err := json.Unmarshal([]byte(answer), &tools); err != nil || len(tools.Result.Tools) != 9 {
		t.Errorf("the nine tools come through the Go program: %v %.200s", err, answer)
	}

	// the supervisor really runs the Node server, and it ends with the Go program
	pid := sup.PID()
	if pid == 0 {
		t.Fatal("the supervisor holds the child")
	}
	cancel()
	sup.Wait()
	waitFor(t, "the Node server to be gone", func() bool { return syscallAlive(pid) == false })
}

func syscallAlive(pid int) bool { return pid > 0 && syscall.Kill(pid, 0) == nil }

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for i := 0; i < 200; i++ {
		if ok() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}
