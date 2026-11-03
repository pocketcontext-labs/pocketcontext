package client

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/pocketcontext-labs/pocketcontext/internal/bundle"
)

type tunnelRoundTripFunc func(*http.Request) (*http.Response, error)

func (f tunnelRoundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// Interrupting first-time relay discovery must be a clean service shutdown,
// even though tailcat wraps the cancelled request in startup diagnostics.
func TestServerTunnelCancellationDuringRelayStartup(t *testing.T) {
	root := t.TempDir()
	t.Setenv("XDG_CACHE_HOME", root)
	t.Setenv("HOME", root)
	t.Setenv("LOCALAPPDATA", root)
	p, err := bundle.Resolve(filepath.Join(root, "pocketcontext.db"))
	if err != nil {
		t.Fatal(err)
	}
	p.Config.Instance = "synthetic-instance"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(bundle.Instance{App: "pocketcontext", Version: bundle.Version, Key: p.Key, Instance: p.Config.Instance})
	}))
	defer server.Close()
	p.Config.Port, err = strconv.Atoi(port(server.URL))
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{}, 1)
	original := http.DefaultClient
	http.DefaultClient = &http.Client{Transport: tunnelRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		started <- struct{}{}
		<-r.Context().Done()
		return nil, r.Context().Err()
	})}
	defer func() { http.DefaultClient = original }()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- runServerTunnel(ctx, p, false, false, true) }()
	select {
	case <-started:
	case err := <-done:
		t.Fatalf("exited before relay startup: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("relay startup did not begin")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("cancelled relay startup failed: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("relay startup ignored cancellation")
	}
	if _, err := os.Stat(filepath.Join(p.Cache, "tunnel-endpoint.json")); !os.IsNotExist(err) {
		t.Fatalf("cancelled startup published an endpoint: %v", err)
	}
}
