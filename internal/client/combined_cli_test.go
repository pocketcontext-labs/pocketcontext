package client

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/pocketcontext-labs/pocketcontext/internal/pocketcontext/sqliteuri"
)

// Uses the invitation rehearsal's isolated project and local relay. The server
// and tunnel must share a PID and terminate together, including on startup error.
func rehearseCombinedService(t *testing.T, binary, root, db, cache string, env, clientEnv []string, run func([]string, string, ...string) map[string]any) {
	t.Helper()
	identityPath := filepath.Join(cache, "tunnel.json")
	identity, err := os.ReadFile(identityPath)
	if err != nil {
		t.Fatal(err)
	}
	refuse := func(want string) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, binary, "serve", "--headless", "--tunnel", "--db", db)
		cmd.Env = env
		out, err := cmd.CombinedOutput()
		if ctx.Err() != nil || err == nil || !strings.Contains(string(out), want) {
			t.Fatalf("combined refusal: %v (%s)", err, out)
		}
	}
	unchangedIdentity := func() {
		t.Helper()
		after, err := os.ReadFile(identityPath)
		if err != nil || !bytes.Equal(identity, after) {
			t.Fatal("combined invocation changed the saved tunnel identity")
		}
	}
	// An independently running server is never adopted or stopped.
	prior := run(env, "", "status", "--db", db)["lease"].(map[string]any)["pid"]
	refuse("already running")
	status := run(env, "", "status", "--db", db)
	if status["running"] != true || status["lease"].(map[string]any)["pid"] != prior {
		t.Fatal("combined refusal stopped or replaced existing server")
	}
	unchangedIdentity()
	run(env, "", "stop", "--db", db)

	assertStopped := func() {
		t.Helper()
		if run(env, "", "status", "--db", db)["running"] != false {
			t.Fatal("combined process left the server running")
		}
		if _, err := os.Stat(filepath.Join(cache, "tunnel-endpoint.json")); !os.IsNotExist(err) {
			t.Fatalf("combined exit left tunnel endpoint: %v", err)
		}
	}
	start := func(label string) (*exec.Cmd, <-chan error) {
		t.Helper()
		outPath, errPath := filepath.Join(root, label+".stdout"), filepath.Join(root, label+".stderr")
		out, err := os.Create(outPath)
		if err != nil {
			t.Fatal(err)
		}
		defer out.Close()
		logs, err := os.Create(errPath)
		if err != nil {
			t.Fatal(err)
		}
		defer logs.Close()
		cmd := exec.Command(binary, "serve", "--headless", "--tunnel", "--db", db)
		cmd.Env, cmd.Stdout, cmd.Stderr = env, out, logs
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() { done <- cmd.Wait(); close(done) }()
		t.Cleanup(func() { _ = cmd.Process.Kill(); <-done })
		deadline := time.Now().Add(55 * time.Second)
		for time.Now().Before(deadline) {
			raw, _ := os.ReadFile(outPath)
			var ready map[string]any
			if json.Unmarshal(raw, &ready) == nil && ready["ready"] == true {
				if ready["combined"] != true || ready["serverRunning"] != true {
					t.Fatal("combined readiness omitted lifecycle state")
				}
				status := run(env, "", "status", "--db", db)
				lease, ok := status["lease"].(map[string]any)
				if status["running"] != true || status["headless"] != true || status["tcp"] != false || !ok || lease["pid"] != float64(cmd.Process.Pid) {
					t.Fatal("combined readiness did not identify its own headless server")
				}
				return cmd, done
			}
			select {
			case err := <-done:
				logs, _ := os.ReadFile(errPath)
				t.Fatalf("combined readiness failed: %v (%s)", err, logs)
			case <-time.After(50 * time.Millisecond):
			}
		}
		t.Fatal("combined readiness timed out")
		return nil, nil
	}
	wait := func(done <-chan error) {
		t.Helper()
		select {
		case err := <-done:
			if err != nil {
				t.Fatalf("combined graceful exit: %v", err)
			}
		case <-time.After(20 * time.Second):
			t.Fatal("combined process did not exit")
		}
		assertStopped()
	}
	checkSnapshot := func(name string) {
		t.Helper()
		uri := sqliteuri.File(db)
		uri.RawQuery = "mode=ro"
		snapshot, err := sql.Open("sqlite3", uri.String())
		if err != nil {
			t.Fatal(err)
		}
		defer snapshot.Close()
		var count int
		if err := snapshot.QueryRow("SELECT count(*) FROM spaces WHERE name = ?", name).Scan(&count); err != nil || count != 1 {
			t.Fatalf("final snapshot missing write: count=%d, error=%v", count, err)
		}
	}
	// Reader TCP is not needed even when another service owns its port.
	port := run(env, "", "status", "--db", db)["port"]
	occupied, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%.0f", port))
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	_, done := start("combined-stop")
	occupied.Close()
	url := fmt.Sprintf("http://127.0.0.1:%.0f", port)
	run(clientEnv, "", "tunnel", "forward", "--url", url, "--background")
	t.Cleanup(func() {
		cmd := exec.Command(binary, "tunnel", "stop", "--url", url)
		cmd.Env = clientEnv
		_ = cmd.Run()
	})
	remoteAccess := func() {
		t.Helper()
		deadline := time.Now().Add(30 * time.Second)
		for time.Now().Before(deadline) {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			cmd := exec.CommandContext(ctx, binary, "whoami", "--url", url)
			cmd.Env = clientEnv
			out, err := cmd.Output()
			cancel()
			var who map[string]any
			if err == nil && json.Unmarshal(out, &who) == nil && who["knowledgeBaseName"] == "Pairing rehearsal" {
				return
			}
			time.Sleep(100 * time.Millisecond)
		}
		t.Fatal("authenticated remote access through combined tunnel did not recover")
	}
	remoteAccess()
	refuse("already running")
	unchangedIdentity()
	run(env, "", "create-space", "combined authenticated stop", "--db", db)
	run(env, "", "stop", "--db", db)
	wait(done)
	checkSnapshot("combined authenticated stop")
	unchangedIdentity()

	// Windows does not support os.Interrupt through Process.Signal; authenticated
	// shutdown above covers the portable shutdown path.
	if runtime.GOOS != "windows" {
		cmd, done := start("combined-interrupt")
		remoteAccess()
		run(env, "", "create-space", "combined interrupt", "--db", db)
		if err := cmd.Process.Signal(os.Interrupt); err != nil {
			t.Fatal(err)
		}
		wait(done)
		checkSnapshot("combined interrupt")
	}
	// Killing the foreground process leaves no detached database server behind.
	// A service-manager restart can reclaim the locks and reuse the identity.
	killed, killedDone := start("combined-killed")
	if err := killed.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-killedDone:
		if err == nil {
			t.Fatal("killed combined process reported success")
		}
	case <-time.After(20 * time.Second):
		t.Fatal("killed combined process did not exit")
	}
	if run(env, "", "status", "--db", db)["running"] != false {
		t.Fatal("killed combined process left a detached server running")
	}
	_, restartedDone := start("combined-after-kill")
	remoteAccess()
	run(env, "", "stop", "--db", db)
	wait(restartedDone)
	unchangedIdentity()

	// A damaged identity fails after server startup and must clean up that server.
	if err := os.WriteFile(identityPath, []byte("damaged identity"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.WriteFile(identityPath, identity, 0600) })
	refuse("identity")
	assertStopped()
	if err := os.WriteFile(identityPath, identity, 0600); err != nil {
		t.Fatal(err)
	}
	// Cleanup released both locks and permits the same identity to run again.
	_, done = start("combined-recovered")
	remoteAccess()
	run(env, "", "stop", "--db", db)
	wait(done)
	unchangedIdentity()
	t.Log("combined service: one PID, occupied reader port, duplicate refusal, authenticated and signal shutdown, snapshot write-back, failed startup cleanup and restart")
}
