package bundle

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"ganigeorgiev.com/pocketbase/pocketbase/apis"
	"ganigeorgiev.com/pocketbase/pocketbase/core"
	"ganigeorgiev.com/pocketbase/pocketbase/tools/filesystem"
	contextserver "github.com/pocketcontext-labs/pocketcontext/internal/pocketcontext/server"
)

// Opt-in integration check: ordinary Go tests do not require Node or browsers.
// Build ui/dist and install ui's Playwright Chromium first, then run:
// POCKETCONTEXT_HTTPS_BROWSER_TEST=1 go test -tags "$(cat build-tags.txt)" ./internal/bundle -run TestPublicHTTPSPhoneBrowser -count=1
func TestPublicHTTPSPhoneBrowser(t *testing.T) {
	if os.Getenv("POCKETCONTEXT_HTTPS_BROWSER_TEST") != "1" {
		t.Skip("opt-in Playwright phone browser test")
	}
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	reader := filepath.Join(root, "ui", "dist")
	if _, err := os.Stat(filepath.Join(reader, "index.html")); err != nil {
		t.Fatal("build the reader before this test:", err)
	}
	a := newTestApp(t)
	spaces, err := a.app.FindRecordsByFilter("spaces", "", "", 1, 0)
	if err != nil {
		t.Fatal(err)
	}
	collection, err := a.app.FindCollectionByNameOrId("sources")
	if err != nil {
		t.Fatal(err)
	}
	source := core.NewRecord(collection)
	source.Set("space", spaces[0].Id)
	source.Set("title", "Synthetic phone evidence")
	source.Set("original_name", "phone.txt")
	source.Set("media_type", "text/plain")
	source.Set("revision", 1)
	file, err := filesystem.NewFileFromBytes([]byte("Synthetic phone reader evidence."), "phone.txt")
	if err != nil {
		t.Fatal(err)
	}
	source.Set("original", file)
	if err := a.app.Save(source); err != nil {
		t.Fatal(err)
	}
	contextserver.RegisterDatabase(a.app, filepath.Join(root, "server.json"), filepath.Join(a.app.DataDir(), "data.db"))
	router, err := apis.NewRouter(a.app)
	if err != nil {
		t.Fatal(err)
	}
	local := &localRoutes{p: &Project{Config: Config{Port: 8096}}, publicURL: "https://knowledge.example.com"}
	local.register(&core.ServeEvent{App: a.app, Router: router})
	registerReader(&core.ServeEvent{App: a.app, Router: router}, reader)
	if err := a.app.OnServe().Trigger(&core.ServeEvent{App: a.app, Router: router}); err != nil {
		t.Fatal(err)
	}
	handler, err := router.BuildMux()
	if err != nil {
		t.Fatal(err)
	}
	certServer := httptest.NewTLSServer(http.NotFoundHandler())
	tlsConfig := certServer.TLS.Clone()
	certServer.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	servers, err := startPublicListeners(ctx, publicHandler(a.app, "knowledge.example.com", handler), publicHTTPHandler("knowledge.example.com", func(h http.Handler) http.Handler { return h }), tlsConfig, "127.0.0.1:0", "127.0.0.1:0", make(chan error, 2))
	if err != nil {
		t.Fatal("phone test HTTPS listener:", err)
	}
	defer servers.close()
	code, _ := local.codes.issue(a.user.Id, 2*time.Minute)
	commandCtx, done := context.WithTimeout(context.Background(), 90*time.Second)
	defer done()
	command := exec.CommandContext(commandCtx, "node", filepath.Join(root, "tests", "https_reader_browser.mjs"))
	_, port, err := net.SplitHostPort(servers.tlsListener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	command.Env = append(os.Environ(), "POCKETCONTEXT_SYNTHETIC_SIGNIN=https://knowledge.example.com/bundle/login#"+code, "POCKETCONTEXT_SYNTHETIC_PORT="+port)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("HTTPS phone browser: %v\n%s", err, output)
	}
	t.Log(string(output))
	cancel()
	shutdown, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	if err := servers.shutdown(shutdown); err != nil {
		t.Fatal(err)
	}
}
