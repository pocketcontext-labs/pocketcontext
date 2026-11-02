package client

import (
	"encoding/json"
	"github.com/pocketcontext-labs/pocketcontext/internal/bundle"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
)

func TestInvitationChecksIdentityBeforeSendingCode(t *testing.T) {
	var redemptions atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/bundle/instance" {
			json.NewEncoder(w).Encode(map[string]string{"app": "pocketcontext", "version": bundle.Version, "instance": "other-project"})
			return
		}
		redemptions.Add(1)
		t.Error("sent request beyond identity probe")
		http.Error(w, "unexpected", 500)
	}))
	defer server.Close()
	_, err := redeemCode(server.URL, "SECRET-CODE", "expected-project")
	if err == nil || !strings.Contains(err.Error(), "identity mismatch") || strings.Contains(err.Error(), "SECRET") {
		t.Fatalf("identity mismatch: %v", err)
	}
	if redemptions.Load() != 0 {
		t.Fatal("invitation code sent before identity verification")
	}
}
func TestInvitationSuccessStoresTokenNotCode(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CACHE_HOME", dir)
	t.Setenv("HOME", dir)
	t.Setenv("LOCALAPPDATA", dir)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/bundle/instance":
			json.NewEncoder(w).Encode(map[string]string{"app": "pocketcontext", "version": bundle.Version, "instance": "expected-project"})
		case "/api/bundle/redeem":
			var body map[string]string
			json.NewDecoder(r.Body).Decode(&body)
			if body["code"] != "SECRET-CODE" {
				t.Error("wrong code")
			}
			json.NewEncoder(w).Encode(map[string]string{"token": "TOKEN"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	if _, err := redeemCode(server.URL, "SECRET-CODE", "expected-project"); err != nil {
		t.Fatal(err)
	}
	p, err := sessionPath(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "SECRET-CODE") || !strings.Contains(string(b), "TOKEN") {
		t.Fatalf("session persisted wrong credentials")
	}
}
