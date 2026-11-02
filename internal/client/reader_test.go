package client

import (
	"encoding/json"
	"github.com/pocketcontext-labs/pocketcontext/internal/bundle"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestRemoteReaderUsesOneTimeLinkAndPreservesSession(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CACHE_HOME", dir)
	t.Setenv("HOME", dir)
	t.Setenv("LOCALAPPDATA", dir)
	code := strings.Repeat("a", 48)
	var base, returnedLink string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/bundle/instance":
			json.NewEncoder(w).Encode(map[string]string{"app": "pocketcontext", "version": bundle.Version, "instance": "project"})
		case "/api/bundle/reader-code":
			if r.Method != "POST" || r.Header.Get("Authorization") != "CLI-TOKEN" {
				t.Error("missing authentication")
			}
			json.NewEncoder(w).Encode(map[string]string{"url": returnedLink, "expires": time.Now().Add(2 * time.Minute).Format(time.RFC3339)})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	base = server.URL
	returnedLink = base + "/bundle/login#" + code
	if err := saveSession(&session{URL: base, Instance: "project", Token: "CLI-TOKEN", Refreshed: time.Now()}); err != nil {
		t.Fatal(err)
	}
	out, err := openRemoteReader(base, true, false)
	if err != nil {
		t.Fatal(err)
	}
	if out["signInLink"] != returnedLink || out["browserLaunchRequested"] != false {
		t.Fatalf("unexpected output: %v", out)
	}
	b, _ := json.Marshal(out)
	if strings.Contains(string(b), "CLI-TOKEN") {
		t.Fatal("reusable token disclosed")
	}
	s, err := loadSession(base)
	if err != nil || s.Token != "CLI-TOKEN" {
		t.Fatal("reader handoff changed CLI session")
	}
	returnedLink = "https://evil.example/bundle/login#" + code
	if _, err := openRemoteReader(base, true, false); err == nil {
		t.Fatal("accepted foreign reader link")
	}
	if err := saveSession(&session{URL: base, Instance: "other-project", Token: "CLI-TOKEN", Refreshed: time.Now()}); err != nil {
		t.Fatal(err)
	}
	if _, err := openRemoteReader(base, true, false); err == nil {
		t.Fatal("accepted mismatched server")
	}
}

func TestReaderSkipAvoidsRemoteRequestsAndSessionFiles(t *testing.T) {
	root := t.TempDir()
	t.Setenv("HOME", root)
	t.Setenv("XDG_CACHE_HOME", filepath.Join(root, "cache"))
	t.Setenv("LOCALAPPDATA", filepath.Join(root, "cache"))
	t.Setenv("SSH_CONNECTION", "synthetic remote session")
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		http.Error(w, "reader skip must not contact server", 500)
	}))
	defer server.Close()
	for _, explicit := range []bool{false, true} {
		out, err := openRemoteReader(server.URL, false, explicit)
		if err != nil || out["readerSkipped"] != true || out["browserLaunchRequested"] != false {
			t.Fatalf("skip failed: %v %v", out, err)
		}
		if _, exists := out["signInLink"]; exists {
			t.Fatal("skipped reader returned a sign-in link")
		}
	}
	if requests.Load() != 0 {
		t.Fatal("skipped reader contacted the remote server")
	}
	if _, err := os.Stat(filepath.Join(root, "cache")); !os.IsNotExist(err) {
		t.Fatal("skipped reader created a cache")
	}
}

func TestEnvironmentAndLocalReaderSkipAreOffline(t *testing.T) {
	root := t.TempDir()
	db := filepath.Join(root, "never-created", "pocketcontext.db")
	t.Setenv("POCKETCONTEXT_DB", db)
	t.Setenv("POCKETCONTEXT_URL", "invalid-url-that-must-not-be-used-by-environment")
	t.Setenv("SSH_CONNECTION", "synthetic remote session")
	if err := run([]string{"environment"}); err != nil {
		t.Fatal(err)
	}
	for _, options := range [][]string{{"open", "--db", db}, {"open", "--db", db, "--skip-reader"}} {
		if err := run(options); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := os.Stat(filepath.Dir(db)); !os.IsNotExist(err) {
		t.Fatal("reader preflight created project files")
	}
	if err := run([]string{"open", "--no-browser", "--skip-reader"}); err == nil {
		t.Fatal("accepted conflicting reader options")
	}
	if err := run([]string{"tunnel", "join", "--stdin", "--no-browser", "--skip-reader"}); err == nil || !strings.Contains(err.Error(), "choose") {
		t.Fatalf("conflicting join flags were not rejected before reading stdin: %v", err)
	}
}
