package client

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pocketcontext-labs/pocketcontext/internal/bundle"
	"github.com/pocketcontext-labs/pocketcontext/internal/profiles"
)

func TestRemoteMismatchPreservesDiagnosticsAndCredentials(t *testing.T) {
	root := t.TempDir()
	t.Setenv("HOME", root)
	t.Setenv("XDG_CACHE_HOME", root)
	t.Setenv("LOCALAPPDATA", root)
	var authenticated atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/bundle/instance" {
			json.NewEncoder(w).Encode(bundle.Instance{App: "pocketcontext", Instance: "expected", Version: "older"})
			return
		}
		authenticated.Add(1)
		http.Error(w, "must not send credentials", 500)
	}))
	defer server.Close()
	if err := saveSession(&session{URL: server.URL, Instance: "expected", Token: "private", Refreshed: time.Now()}); err != nil {
		t.Fatal(err)
	}
	if _, err := NewRemote(server.URL, ""); err == nil {
		t.Fatal("accepted different server version")
	}
	if _, err := redeemCode(server.URL, "private-code", "expected"); err == nil {
		t.Fatal("redeemed invitation on incompatible server")
	}
	status, err := remoteStatus(server.URL)
	if err != nil || status["reachable"] != true || status["compatible"] != false || status["version"] != "older" {
		t.Fatalf("diagnostics unavailable: %v %v", status, err)
	}
	if authenticated.Load() != 0 {
		t.Fatal("sent credentials before compatibility check")
	}
	s, err := loadSession(server.URL)
	if err != nil || s == nil || s.Token != "private" {
		t.Fatal("compatibility failure damaged saved session")
	}
}

func TestProfileChecksSelectedReleaseAndRecordedServer(t *testing.T) {
	e := profiles.Entry{Name: "legacy", Version: "0.12.1", ServerVersion: "0.12.1"}
	i := &bundle.Instance{Version: "0.12.1"}
	if err := checkProfileServer(e, i); err != nil {
		t.Fatalf("current router cannot verify matching legacy pair: %v", err)
	}
	i.Version = "0.13.0"
	if err := checkProfileServer(e, i); err == nil {
		t.Fatal("accepted stale running server")
	}
	e.Version = "0.13.0"
	if err := checkProfileServer(e, i); err == nil {
		t.Fatal("silently reconciled registered server version")
	}
}

func TestManagedForwardRequiresExplicitRestartAfterUpgrade(t *testing.T) {
	root := t.TempDir()
	t.Setenv("HOME", root)
	t.Setenv("XDG_CACHE_HOME", root)
	t.Setenv("LOCALAPPDATA", root)
	c := connection{Format: 1, URL: "http://127.0.0.1:18098", Instance: "expected"}
	dir, statePath, stopPath, err := managedPaths(c.URL)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	for _, version := range []string{"", "older"} {
		state := managedState{ID: "existing", Version: version, Fingerprint: connectionFingerprint(c)}
		if err := writeManagedState(statePath, state); err != nil {
			t.Fatal(err)
		}
		if _, err := ensureManagedForward(context.Background(), c); err == nil || !strings.Contains(err.Error(), "tunnel stop") {
			t.Fatalf("missing actionable mismatch: %v", err)
		}
		if _, err := os.Stat(stopPath); !os.IsNotExist(err) {
			t.Fatal("implicitly stopped old worker")
		}
		if got, err := readManagedState(statePath); err != nil || got.ID != state.ID {
			t.Fatal("modified existing worker")
		}
	}
}
