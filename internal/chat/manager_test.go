package chat

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestACPProcess is a synthetic stdio subprocess; it never invokes a provider.
func TestACPProcess(t *testing.T) {
	if os.Getenv("CHAT_TEST_PROCESS") != "1" {
		return
	}
	if os.Getenv("CHAT_TEST_NONREADING") == "1" {
		time.Sleep(time.Hour)
		os.Exit(0)
	}
	var mu sync.Mutex
	send := func(v any) { mu.Lock(); defer mu.Unlock(); json.NewEncoder(os.Stdout).Encode(v) }
	reply := func(id json.RawMessage, result any) {
		send(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
	}
	var promptID json.RawMessage
	s := bufio.NewScanner(os.Stdin)
	for s.Scan() {
		var w wire
		if json.Unmarshal(s.Bytes(), &w) != nil {
			os.Exit(2)
		}
		switch w.Method {
		case "initialize":
			if gate := os.Getenv("CHAT_TEST_INIT_GATE"); gate != "" {
				os.WriteFile(gate+".ready", []byte("ready"), 0600)
				for {
					if _, err := os.Stat(gate); err == nil {
						break
					}
					time.Sleep(time.Millisecond)
				}
			}
			reply(w.ID, map[string]any{"protocolVersion": 1, "agentCapabilities": map[string]any{"loadSession": true, "promptCapabilities": map[string]bool{"image": true}}})
		case "session/new", "session/load":
			if os.Getenv("CHAT_TEST_AUTH_FAIL") == "1" {
				send(wire{JSONRPC: "2.0", ID: w.ID, Error: &rpcError{Code: -32000, Message: "authentication required"}})
				continue
			}
			models := ModelState{Current: "first", Options: []ChatModel{{ID: "first", Name: "First"}, {ID: "second", Name: "Second"}}}
			if os.Getenv("CHAT_TEST_MODEL_EFFORT") == "1" {
				models = ModelState{Current: "first[low]", Options: []ChatModel{{ID: "first[low]", Name: "First (low)"}, {ID: "first[high]", Name: "First (high)"}, {ID: "second[high]", Name: "Second (high)"}}}
			}
			reply(w.ID, map[string]any{"sessionId": "fake-session", "models": models, "modes": map[string]any{"currentModeId": "agent-full-access", "availableModes": []any{map[string]string{"id": "read-only"}, map[string]string{"id": "workspace-write"}, map[string]string{"id": "agent-full-access"}}}})
		case "session/set_mode", "session/set_model":
			if os.Getenv("INITIAL_AGENT_MODE") == "agent-full-access" && os.Getenv("CODEX_CONFIG") != `{"approval_policy":"never","sandbox_mode":"danger-full-access"}` {
				os.Exit(4)
			}
			reply(w.ID, map[string]any{})
		case "session/prompt":
			var p struct {
				Prompt []struct {
					Text string `json:"text"`
				} `json:"prompt"`
			}
			json.Unmarshal(w.Params, &p)
			text := p.Prompt[0].Text
			if text == "crash" {
				os.Exit(3)
			}
			promptID = w.ID
			if text == "permission" {
				send(map[string]any{"jsonrpc": "2.0", "id": "permission-1", "method": "session/request_permission", "params": map[string]any{"sessionId": "fake-session", "toolCall": map[string]any{"title": "Synthetic action"}, "options": []PermissionOption{{OptionID: "allow-once", Name: "Allow once", Kind: "allow_once"}, {OptionID: "reject-once", Name: "Reject", Kind: "reject_once"}}}})
				continue
			}
			if text == "hang" {
				continue
			}
			send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": "fake-session", "update": map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]string{"type": "text", "text": "Synthetic response"}}}})
			reply(w.ID, map[string]string{"stopReason": "end_turn"})
		case "session/cancel":
			if len(promptID) > 0 {
				reply(promptID, map[string]string{"stopReason": "cancelled"})
				promptID = nil
			}
		case "":
			if len(promptID) > 0 {
				reply(promptID, map[string]string{"stopReason": "end_turn"})
				promptID = nil
			}
		}
	}
	os.Exit(0)
}
func testManager(t *testing.T, extra ...string) *Manager {
	t.Helper()
	exe, e := os.Executable()
	if e != nil {
		t.Fatal(e)
	}
	base := t.TempDir()
	env := append(os.Environ(), "CHAT_TEST_PROCESS=1")
	env = append(env, extra...)
	m, e := New(Config{Command: exe, Args: []string{"-test.run=^TestACPProcess$"}, Dir: filepath.Join(base, "work"), StateDir: filepath.Join(base, "state"), Env: env, CancelTimeout: 50 * time.Millisecond})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { m.Close() })
	return m
}
func await(t *testing.T, m *Manager, id string, pred func(Snapshot) bool) Snapshot {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		s, e := m.Snapshot(id, 0)
		if e != nil {
			t.Fatal(e)
		}
		if pred(s) {
			return s
		}
		time.Sleep(5 * time.Millisecond)
	}
	s, _ := m.Snapshot(id, 0)
	t.Fatalf("timed out: %+v", s)
	return s
}
func TestLifecycle(t *testing.T) {
	m := testManager(t)
	s, e := m.Create(context.Background(), "create-1", "space-1")
	if e != nil {
		t.Fatal(e)
	}
	again, e := m.Create(context.Background(), "create-1", "space-1")
	if e != nil || again.ID != s.ID {
		t.Fatal("create dedupe", e)
	}
	if _, e = m.Create(context.Background(), "create-1", "space-2"); e != ErrConflict {
		t.Fatal(e)
	}
	if e = m.Prompt(s.ID, "p1", "hello"); e != nil {
		t.Fatal(e)
	}
	if e = m.Prompt(s.ID, "p1", "hello"); e != nil {
		t.Fatal(e)
	}
	done := await(t, m, s.ID, func(s Snapshot) bool { return s.Status == "idle" })
	users, agents := 0, 0
	for _, v := range done.Events {
		if v.Type == "user" {
			users++
		}
		if v.Type == "agent" {
			agents++
		}
	}
	if users != 1 || agents != 1 {
		t.Fatal(done.Events)
	}
	if e = m.Prompt(s.ID, "p1", "different"); e != ErrConflict {
		t.Fatal(e)
	}
	for i, option := range []string{"allow-once", "reject-once"} {
		if e = m.Prompt(s.ID, fmt.Sprint("permission", i), "permission"); e != nil {
			t.Fatal(e)
		}
		p := await(t, m, s.ID, func(s Snapshot) bool { return len(s.Permissions) == 1 })
		if e = m.Permission(s.ID, p.Permissions[0].ID, "invented"); e != ErrInvalid {
			t.Fatal(e)
		}
		if e = m.Permission(s.ID, p.Permissions[0].ID, option); e != nil {
			t.Fatal(e)
		}
		await(t, m, s.ID, func(s Snapshot) bool { return s.Status == "idle" })
	}
	if e = m.Prompt(s.ID, "cancel", "permission"); e != nil {
		t.Fatal(e)
	}
	await(t, m, s.ID, func(s Snapshot) bool { return len(s.Permissions) == 1 })
	if e = m.Cancel(s.ID); e != nil {
		t.Fatal(e)
	}
	await(t, m, s.ID, func(s Snapshot) bool { return s.Status == "idle" && len(s.Permissions) == 0 })
	if e = m.CloseSession(s.ID); e != nil {
		t.Fatal(e)
	}
	time.Sleep(50 * time.Millisecond)
	if e = m.Resume(context.Background(), s.ID); e != nil {
		t.Fatal(e)
	}
	if e = m.Prompt(s.ID, "crash", "crash"); e != nil {
		t.Fatal(e)
	}
	await(t, m, s.ID, func(s Snapshot) bool { return s.Status == "error" || s.Status == "interrupted" })
	if e = m.Close(); e != nil {
		t.Fatal(e)
	}
	restored, e := New(m.c)
	if e != nil {
		t.Fatal(e)
	}
	defer restored.Close()
	history, e := restored.Snapshot(s.ID, 0)
	if e != nil || len(history.Events) == 0 || history.Status != "interrupted" {
		t.Fatal(history, e)
	}
	if e = restored.Prompt(s.ID, "crash", "crash"); e != nil {
		t.Fatal("uncertain prompt must dedupe", e)
	}
}
func TestAuthFailure(t *testing.T) {
	m := testManager(t, "CHAT_TEST_AUTH_FAIL=1")
	s, e := m.Create(context.Background(), "auth", "space")
	if e == nil || s.Status != "error" {
		t.Fatal(s, e)
	}
}
func TestPersistenceFailureDoesNotSend(t *testing.T) {
	m := testManager(t)
	s, e := m.Create(context.Background(), "create", "space")
	if e != nil {
		t.Fatal(e)
	}
	m.c.StateDir = filepath.Join(t.TempDir(), "absent")
	if e = m.Prompt(s.ID, "not-sent", "hello"); e == nil {
		t.Fatal("expected failure")
	}
	s, _ = m.Snapshot(s.ID, 0)
	if s.Status != "error" {
		t.Fatal(s.Status)
	}
	for _, v := range s.Events {
		if v.Type == "agent" {
			t.Fatal("unsaved prompt reached agent")
		}
	}
	if e = m.Prompt(s.ID, "not-sent", "hello"); e != nil {
		t.Fatal("request must never be replayed", e)
	}
}

func TestBlockedWriteHasDeadline(t *testing.T) {
	exe, _ := os.Executable()
	r, err := launch(Config{Command: exe, Args: []string{"-test.run=^TestACPProcess$"}, Env: append(os.Environ(), "CHAT_TEST_PROCESS=1", "CHAT_TEST_NONREADING=1")}, t.TempDir(), func(wire) {}, func() {})
	if err != nil {
		t.Fatal(err)
	}
	defer r.stop()
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	begin := time.Now()
	if err = r.call(ctx, "initialize", strings.Repeat("x", 1<<20), nil); err == nil {
		t.Fatal("expected timeout")
	}
	if time.Since(begin) > 3*time.Second {
		t.Fatal("write ignored timeout")
	}
	select {
	case <-r.waited:
	case <-time.After(3 * time.Second):
		t.Fatal("process did not exit")
	}
}
func TestActiveLimitAndImmediateResume(t *testing.T) {
	m := testManager(t)
	m.c.MaxActive = 1
	s, e := m.Create(context.Background(), "one", "space")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = m.Create(context.Background(), "two", "space"); e != nil {
		t.Fatal(e)
	}
	if parked, _ := m.Snapshot(s.ID, 0); parked.Status != "closed" {
		t.Fatal(parked.Status)
	}
	if e = m.Resume(context.Background(), s.ID); e != nil {
		t.Fatal(e)
	}
	if e = m.Prompt(s.ID, "after-resume", "hello"); e != nil {
		t.Fatal(e)
	}
	await(t, m, s.ID, func(s Snapshot) bool { return s.Status == "idle" })
}

// A reservation exists before filesystem preparation/process launch. The second
// caller must reject it even though no subprocess has been attached yet.
func TestConcurrentResumeReservation(t *testing.T) {
	m := testManager(t)
	snap, err := m.Create(context.Background(), "reservation", "space")
	if err != nil {
		t.Fatal(err)
	}
	if err = m.CloseSession(snap.ID); err != nil {
		t.Fatal(err)
	}
	s, _ := m.get(snap.ID)
	s.mu.Lock()
	s.Status = "initializing"
	s.generation++
	generation := s.generation
	s.mu.Unlock()
	done := make(chan error, 1)
	go func() { done <- m.Resume(context.Background(), snap.ID) }()
	if err = <-done; err != ErrBusy {
		t.Fatalf("second resume: %v", err)
	}
	if err = m.start(context.Background(), s, true, generation); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	runner := s.process
	s.mu.Unlock()
	if err = m.start(context.Background(), s, true, generation); err != ErrClosed {
		t.Fatalf("duplicate launch: %v", err)
	}
	s.mu.Lock()
	if s.process != runner {
		t.Error("duplicate replaced process")
	}
	s.mu.Unlock()
}
func TestCloseDuringInitializeAndResume(t *testing.T) {
	gate := filepath.Join(t.TempDir(), "gate")
	if err := os.WriteFile(gate, []byte("open"), 0600); err != nil {
		t.Fatal(err)
	}
	m := testManager(t, "CHAT_TEST_INIT_GATE="+gate)
	snap, err := m.Create(context.Background(), "close-init", "space")
	if err != nil {
		t.Fatal(err)
	}
	if err = m.CloseSession(snap.ID); err != nil {
		t.Fatal(err)
	}
	os.Remove(gate)
	os.Remove(gate + ".ready")
	resumed := make(chan error, 1)
	go func() { resumed <- m.Resume(context.Background(), snap.ID) }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err = os.Stat(gate + ".ready"); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("initialize did not block")
		}
		time.Sleep(time.Millisecond)
	}
	s, _ := m.get(snap.ID)
	s.mu.Lock()
	oldGeneration := s.generation
	s.mu.Unlock()
	if err = m.CloseSession(snap.ID); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(gate, []byte("open"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = m.Resume(context.Background(), snap.ID); err != nil {
		t.Fatal(err)
	}
	// Delayed startup errors from the killed generation must not overwrite the
	// newly ready session, regardless of goroutine scheduling.
	_ = m.failed(s, oldGeneration, errors.New("old initialization failed"))
	if err = <-resumed; err == nil {
		t.Fatal("closed initialization succeeded")
	}
	current, _ := m.Snapshot(snap.ID, 0)
	if current.Status != "idle" || current.Error != "" {
		t.Fatalf("stale initialization changed state: %+v", current.Summary)
	}
	if err = m.Prompt(snap.ID, "new-generation", "hello"); err != nil {
		t.Fatal(err)
	}
	await(t, m, snap.ID, func(s Snapshot) bool { return s.Status == "idle" })
}

func TestAllConversationModesAvailable(t *testing.T) {
	m := testManager(t)
	ctx := context.Background()
	ordinary, err := m.Create(ctx, "default", "space")
	if err != nil || ordinary.Mode != "read-only" {
		t.Fatalf("default mode: %v, %q", err, ordinary.Mode)
	}
	if !m.Status().AllowWorkspace || !m.Status().AllowFullAccess {
		t.Fatal("permission modes are not advertised")
	}
	for _, mode := range []string{"read-only", "workspace-write", "agent-full-access"} {
		snap, err := m.CreateWithMode(ctx, mode, "space", mode)
		if err != nil || snap.Mode != mode {
			t.Fatalf("explicit %s creation: %v, %q", mode, err, snap.Mode)
		}
		if err = m.CloseSession(snap.ID); err != nil {
			t.Fatal(err)
		}
		if err = m.Resume(ctx, snap.ID); err != nil {
			t.Fatalf("restore %s: %v", mode, err)
		}
	}
	if _, err := m.CreateWithMode(ctx, "invalid", "space", "invalid"); err != ErrInvalid {
		t.Fatalf("invalid mode: %v", err)
	}
	if _, err := m.Create(ctx, "workspace-write", "space"); err != ErrConflict {
		t.Fatalf("retry with changed mode: %v", err)
	}
}

func TestOrganizeChat(t *testing.T) {
	m := testManager(t)
	s, err := m.Create(context.Background(), "organize", "space")
	if err != nil {
		t.Fatal(err)
	}
	for _, step := range []struct {
		action           string
		pinned, archived bool
	}{
		{"pin", true, false}, {"unpin", false, false}, {"pin", true, false}, {"archive", false, true}, {"restore", false, false},
	} {
		if err := m.Organize(s.ID, step.action); err != nil {
			t.Fatal(err)
		}
		row := m.List()[0]
		if row.Pinned != step.pinned || row.Archived != step.archived || row.Status != s.Status {
			t.Fatalf("%s: %+v", step.action, row)
		}
	}
}

func TestLiveModeResolvesPendingApproval(t *testing.T) {
	m := testManager(t)
	ctx := context.Background()
	s, err := m.Create(ctx, "live", "space")
	if err != nil {
		t.Fatal(err)
	}
	if err = m.Prompt(s.ID, "one", "permission"); err != nil {
		t.Fatal(err)
	}
	await(t, m, s.ID, func(s Snapshot) bool { return len(s.Permissions) == 1 })
	if err = m.SetMode(ctx, s.ID, "agent-full-access"); err != nil {
		t.Fatal(err)
	}
	await(t, m, s.ID, func(s Snapshot) bool {
		return s.Status == "idle" && s.Mode == "agent-full-access" && len(s.Permissions) == 0
	})
	if err = m.SetMode(ctx, s.ID, "read-only"); err != nil {
		t.Fatal(err)
	}
}

func TestModelDefaultSurvivesSelectionAndResume(t *testing.T) {
	m := testManager(t)
	s, err := m.Create(context.Background(), "model-default", "space")
	if err != nil {
		t.Fatal(err)
	}
	if s.Models == nil || s.Models.Default != "first" {
		t.Fatalf("initial adapter default missing: %+v", s.Models)
	}
	if err = m.PromptWithOptions(s.ID, "change-model", "synthetic", "second", nil); err != nil {
		t.Fatal(err)
	}
	s = await(t, m, s.ID, func(s Snapshot) bool { return s.Status == "idle" })
	if s.Models.Current != "second" || s.Models.Default != "first" {
		t.Fatalf("selection overwrote default: %+v", s.Models)
	}
	if err = m.Close(); err != nil {
		t.Fatal(err)
	}
	restored, err := New(m.c)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { restored.Close() })
	s, _ = restored.Snapshot(s.ID, 0)
	if s.Models.Current != "second" || s.Models.Default != "first" {
		t.Fatalf("restart lost model selection/default: %+v", s.Models)
	}
	if err = restored.Resume(context.Background(), s.ID); err != nil {
		t.Fatal(err)
	}
	s, _ = restored.Snapshot(s.ID, 0)
	if s.Models.Default != "first" {
		t.Fatalf("resume overwrote default: %+v", s.Models)
	}
}

func TestLegacyModelHistoryDoesNotInventDefaultOnResume(t *testing.T) {
	m := testManager(t)
	s, err := m.Create(context.Background(), "legacy-model", "space")
	if err != nil {
		t.Fatal(err)
	}
	if err = m.CloseSession(s.ID); err != nil {
		t.Fatal(err)
	}
	stored, _ := m.get(s.ID)
	stored.mu.Lock()
	stored.Models.Default = "" // The field is absent in histories from older builds.
	stored.mu.Unlock()
	if err = m.Resume(context.Background(), s.ID); err != nil {
		t.Fatal(err)
	}
	s, _ = m.Snapshot(s.ID, 0)
	if s.Models.Default != "" {
		t.Fatalf("invented an original default from resumed current: %+v", s.Models)
	}
}
