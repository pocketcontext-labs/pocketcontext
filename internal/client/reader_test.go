package client

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
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
			json.NewEncoder(w).Encode(map[string]string{"app": "pocketcontext", "instance": "project"})
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
	out, err := openRemoteReader(base, true)
	if err != nil {
		t.Fatal(err)
	}
	if out["signInLink"] != returnedLink || out["browserOpened"] != false {
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
	if _, err := openRemoteReader(base, true); err == nil {
		t.Fatal("accepted foreign reader link")
	}
	if err := saveSession(&session{URL: base, Instance: "other-project", Token: "CLI-TOKEN", Refreshed: time.Now()}); err != nil {
		t.Fatal(err)
	}
	if _, err := openRemoteReader(base, true); err == nil {
		t.Fatal("accepted mismatched server")
	}
}
