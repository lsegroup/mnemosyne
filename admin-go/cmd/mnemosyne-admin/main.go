// Command mnemosyne-admin is the Go admin of Mnemosyne: it serves /mnemosyne/admin itself and passes everything else on to the Node
// server behind it. Configure it with the same environment the Node server uses (see internal/config).
package main

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"gitlab.globalclouddata.org/gcd-group/mnemosyne-admin/internal/config"
	"gitlab.globalclouddata.org/gcd-group/mnemosyne-admin/internal/supervisor"
	"gitlab.globalclouddata.org/gcd-group/mnemosyne-admin/internal/web"
)

// version is set at build time (-ldflags "-X main.version=...").
var version = "dev"

func main() {
	if len(os.Args) > 1 && (os.Args[1] == "--version" || os.Args[1] == "version") {
		println(version)
		return
	}
	cwd, _ := os.Getwd()
	cfg, err := config.Load(config.Getenv, cwd)
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	cfg.Version = version
	srv, err := web.New(cfg)
	if err != nil {
		log.Fatalf("start: %v", err)
	}
	if !cfg.Configured() {
		log.Printf("the portal is not configured (MNEMOSYNE_SECRET of at least 16 characters and MNEMOSYNE_PUBLIC_URL): sign-in is switched off")
	}
	srv.StartAuto()

	// MNEMOSYNE_NODE_CMD: this program starts the Node server itself, behind it, and ends it when it ends. Without it the Node server
	// is started by something else (a second service, a developer's terminal).
	ctx, cancelNode := context.WithCancel(context.Background())
	srv.StartLicense(ctx)
	var node *supervisor.Supervisor
	if cmd := strings.Fields(os.Getenv("MNEMOSYNE_NODE_CMD")); len(cmd) > 0 {
		host, port := "127.0.0.1", "40002"
		if u, err := url.Parse(cfg.Upstream); err == nil && u.Host != "" {
			if h, p, err := net.SplitHostPort(u.Host); err == nil {
				host, port = h, p
			}
		}
		node = supervisor.Start(ctx, supervisor.Spec{
			Command: cmd,
			Dir:     os.Getenv("MNEMOSYNE_NODE_DIR"),
			Env:     []string{"MNEMOSYNE_ADMIN_EXTERNAL=1", "MNEMOSYNE_HTTP_HOST=" + host, "MNEMOSYNE_HTTP_PORT=" + port},
		})
	}
	httpSrv := &http.Server{Addr: cfg.Listen, Handler: srv, ReadHeaderTimeout: 15 * time.Second}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-stop
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shutdown)
		cancelNode()
	}()

	log.Printf("mnemosyne-admin %s listening on %s, upstream %s, base path %q", version, cfg.Listen, cfg.Upstream, cfg.BasePath)
	if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		cancelNode()
		log.Fatal(err)
	}
	if node != nil {
		node.Wait()
	}
}
