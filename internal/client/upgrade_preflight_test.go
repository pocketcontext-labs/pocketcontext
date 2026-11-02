package client

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/pocketcontext-labs/pocketcontext/internal/bundle"
)

func incompatibleLocalProject(t *testing.T) *bundle.Project {
	t.Helper()
	root := t.TempDir()
	t.Setenv("HOME", root)
	t.Setenv("XDG_CACHE_HOME", root)
	t.Setenv("LOCALAPPDATA", root)
	p, err := bundle.Resolve(filepath.Join(root, "pocketcontext.db"))
	if err != nil {
		t.Fatal(err)
	}
	p.Config.Name, p.Config.Instance = "Original", "expected-project"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/bundle/instance" {
			t.Error("unexpected authenticated operation")
			http.Error(w, "unexpected", 500)
			return
		}
		_ = json.NewEncoder(w).Encode(bundle.Instance{App: "pocketcontext", Version: "old-release", Instance: p.Config.Instance, Key: p.Key})
	}))
	t.Cleanup(server.Close)
	p.Config.Port, err = strconv.Atoi(port(server.URL))
	if err != nil {
		t.Fatal(err)
	}
	if err := p.SaveConfig(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p.DB, []byte("synthetic database placeholder"), 0600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestInitMismatchLeavesConfigurationUntouched(t *testing.T) {
	p := incompatibleLocalProject(t)
	before, err := os.ReadFile(p.ConfigPath)
	if err != nil {
		t.Fatal(err)
	}
	a := &args{flags: map[string]string{"name": "Changed", "port": "18499"}, bools: map[string]bool{}}
	if err := initProject(p, a, false); err == nil || !strings.Contains(err.Error(), "old-release") {
		t.Fatalf("missing version preflight: %v", err)
	}
	after, err := os.ReadFile(p.ConfigPath)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatalf("failed init modified config: %v", err)
	}
}

func TestTunnelMismatchDoesNotRotateIdentity(t *testing.T) {
	p := incompatibleLocalProject(t)
	if err := os.MkdirAll(p.Cache, 0700); err != nil {
		t.Fatal(err)
	}
	identity := []byte("existing identity must not be loaded or replaced")
	if err := os.WriteFile(identityFile(p), identity, 0600); err != nil {
		t.Fatal(err)
	}
	a := &args{pos: []string{"serve"}, flags: map[string]string{"db": p.DB}, bools: map[string]bool{"new-address": true}}
	if err := tunnelServe(context.Background(), a, false); err == nil || !strings.Contains(err.Error(), "old-release") {
		t.Fatalf("missing version preflight: %v", err)
	}
	after, err := os.ReadFile(identityFile(p))
	if err != nil || !bytes.Equal(identity, after) {
		t.Fatalf("failed tunnel serve changed identity: %v", err)
	}
}
