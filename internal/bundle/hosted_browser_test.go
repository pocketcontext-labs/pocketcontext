package bundle

import (
	"context"
	"encoding/json"
	"html"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sync"
	"testing"
	"time"

	"ganigeorgiev.com/pocketbase/pocketbase/apis"
	"ganigeorgiev.com/pocketbase/pocketbase/core"
)

func TestHostedEmailBrowser(t *testing.T) {
	if os.Getenv("POCKETCONTEXT_HOSTED_BROWSER_TEST") != "1" {
		t.Skip("opt-in hosted email browser test")
	}
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	a := newTestApp(t)
	const email = "owner@example.test"
	a.user.SetEmail(email)
	if err = a.app.Save(a.user); err != nil {
		t.Fatal(err)
	}
	cfg := &HostedConfig{OwnerEmail: email, From: "login@example.test", SMTP: core.SMTPConfig{Enabled: true, Host: "smtp.example.test", Port: 465, TLS: true, Username: "resend", Password: "synthetic"}}
	if err = configureHosted(a.app, "knowledge.example.com", cfg, false); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	mailURL := ""
	count := 0
	link := regexp.MustCompile(`href="([^"]+)"`)
	a.app.OnMailerRecordOTPSend("users").BindFunc(func(e *core.MailerRecordEvent) error {
		match := link.FindStringSubmatch(e.Message.HTML)
		mu.Lock()
		defer mu.Unlock()
		if len(match) == 2 {
			mailURL = html.UnescapeString(match[1])
			count++
		}
		return nil // capture only: synthetic test never sends mail
	})
	p := &Project{Cache: t.TempDir(), Config: Config{Port: 8096, Instance: "synthetic-hosted"}}
	router, err := apis.NewRouter(a.app)
	if err != nil {
		t.Fatal(err)
	}
	local := &localRoutes{p: p, publicURL: "https://knowledge.example.com", mcp: true, hosted: true}
	local.register(&core.ServeEvent{App: a.app, Router: router})
	registerReader(&core.ServeEvent{App: a.app, Router: router}, filepath.Join(root, "ui", "dist"))
	if err = a.app.OnServe().Trigger(&core.ServeEvent{App: a.app, Router: router}); err != nil {
		t.Fatal(err)
	}
	handler, err := router.BuildMux()
	if err != nil {
		t.Fatal(err)
	}
	oauth, err := newMCPOAuth(a.app, p, "knowledge.example.com", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		oauthJSON(w, 200, map[string]bool{"authenticated": MCPAuthToken(r.Context()) != ""})
	}))
	if err != nil {
		t.Fatal(err)
	}
	oauth.hosted = true
	hosted := publicHandlerMode(a.app, "knowledge.example.com", handler, true, oauth)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/__test/mailbox" {
			mu.Lock()
			defer mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"url": mailURL, "count": count})
			return
		}
		// Simulate TLS termination upstream of the hosted plaintext listener.
		r.TLS = nil
		hosted.ServeHTTP(w, r)
	}))
	defer server.Close()
	_, port, _ := net.SplitHostPort(server.Listener.Addr().String())
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "node", filepath.Join(root, "tests", "hosted_email_browser.mjs"))
	cmd.Env = append(os.Environ(), "POCKETCONTEXT_SYNTHETIC_PORT="+port, "POCKETCONTEXT_SYNTHETIC_EMAIL="+email)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("hosted browser: %v\n%s", err, out)
	}
	t.Log(string(out))
}
