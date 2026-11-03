package client

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pocketcontext-labs/pocketcontext/internal/bundle"
)

func TestInvitationStdinAndGeneratedPrompt(t *testing.T) {
	in := invitation{connection{Format: 1, Address: validAddress(), URL: "http://127.0.0.1:18096", Instance: "project-a", Name: "Research"}, "one-time-test-code", time.Now().Add(time.Minute)}
	data, _ := json.Marshal(in)
	prompt := clientSetupPrompt(data)
	_, payload, ok := strings.Cut(prompt, "Invitation JSON (use the complete object unchanged):\n")
	if !ok {
		t.Fatal("no invitation in prompt")
	}
	decoded, err := decodeInvitation(strings.NewReader(payload))
	if err != nil || decoded.Code != in.Code || decoded.Instance != in.Instance {
		t.Fatalf("prompt invitation round trip: %v", err)
	}
	if !strings.Contains(prompt, "tunnel join --stdin") || !strings.Contains(prompt, "/blob/v0.18.0/README.md") || !strings.Contains(prompt, "--no-browser") {
		t.Fatal("incomplete client setup instructions")
	}
	for _, bad := range []string{string(data) + ` {}`, strings.Replace(string(data), `"format":1`, `"format":1,"unexpected":true`, 1), string(data) + strings.Repeat(" ", 65537)} {
		if _, err := decodeInvitation(strings.NewReader(bad)); err == nil {
			t.Fatal("accepted malformed or oversized invitation")
		}
	}
}
func TestManagedStateAndGenerationStop(t *testing.T) {
	root := t.TempDir()
	t.Setenv("XDG_CACHE_HOME", root)
	t.Setenv("LOCALAPPDATA", root)
	t.Setenv("HOME", root)
	base := "http://127.0.0.1:18096"
	dir, path, stop, err := managedPaths(base)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	state := managedState{ID: "generation-one", Fingerprint: "test-fingerprint"}
	if err = writeManagedState(path, state); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- stopManagedForward(base) }()
	deadline := time.Now().Add(time.Second)
	var got []byte
	for time.Now().Before(deadline) {
		got, _ = os.ReadFile(stop)
		if len(got) > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if string(got) != state.ID {
		t.Fatal("stop did not target exact worker generation")
	}
	// A replacement worker must not be stopped or have its state deleted.
	state.ID = "generation-two"
	if err = writeManagedState(path, state); err != nil {
		t.Fatal(err)
	}
	if err = <-done; err != nil {
		t.Fatal(err)
	}
	current, err := readManagedState(path)
	if err != nil || current.ID != state.ID {
		t.Fatal("replacement state was damaged")
	}
	_ = os.Remove(stop)
	if err := stopManagedGeneration(base, "generation-one"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stop); !os.IsNotExist(err) {
		t.Fatal("cleanup requested stop of a replacement worker")
	}
	stale := managedState{ID: "old", Fingerprint: "old", Updated: time.Now().Add(-time.Minute)}
	data, _ := json.Marshal(stale)
	os.WriteFile(path, data, 0600)
	if _, err = readManagedState(path); err == nil {
		t.Fatal("stale worker reported alive")
	}
	if filepath.Dir(path) != dir {
		t.Fatal("state escaped cache directory")
	}
}
func TestTunnelRejectsWrongLifecycleFlags(t *testing.T) {
	for _, argv := range [][]string{{"tunnel", "serve", "--background"}, {"tunnel", "invite", "--stdin"}, {"tunnel", "join", "--stdin", "--background"}, {"tunnel", "stop", "--no-browser"}, {"tunnel", "serve", "--skip-reader"}} {
		if err := run(argv); err == nil || !strings.Contains(err.Error(), "not supported") {
			t.Fatalf("wrong lifecycle flags %v: %v", argv, err)
		}
	}
}

func TestManagedStopWaitsForWorkerLock(t *testing.T) {
	root := t.TempDir()
	t.Setenv("XDG_CACHE_HOME", root)
	t.Setenv("LOCALAPPDATA", root)
	t.Setenv("HOME", root)
	base := "http://127.0.0.1:18097"
	dir, state, stop, err := managedPaths(base)
	if err != nil {
		t.Fatal(err)
	}
	release, err := bundle.AcquireTunnelLock(&bundle.Project{Cache: dir})
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if err := writeManagedState(state, managedState{ID: "stopping-worker", Fingerprint: "test"}); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- stopManagedForward(base) }()
	deadline := time.Now().Add(time.Second)
	for {
		if _, err := os.Stat(stop); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("stop request was not written")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := os.Remove(state); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		t.Fatalf("stop returned before worker released its lock: %v", err)
	case <-time.After(150 * time.Millisecond):
	}
	release()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("stop did not finish after worker exited")
	}
}
