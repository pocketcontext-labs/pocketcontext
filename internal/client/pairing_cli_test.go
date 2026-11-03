package client

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/pocketcontext-labs/pocketcontext/internal/tunnel"
	"tailscale.com/derp/derpserver"
	"tailscale.com/net/stun/stuntest"
	"tailscale.com/tailcfg"
	"tailscale.com/types/key"
	"tailscale.com/types/nettype"
)

// Run with POCKETCONTEXT_REHEARSAL_BINARY pointing at a freshly built candidate.
// This exercises the actual CLI processes against an in-process relay, not public relays.
func TestInvitationCLIRehearsal(t *testing.T) {
	binary := os.Getenv("POCKETCONTEXT_REHEARSAL_BINARY")
	if binary == "" {
		t.Skip("set POCKETCONTEXT_REHEARSAL_BINARY to rehearse the candidate CLI")
	}
	binary, err := filepath.Abs(binary)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	roleEnv := func(role string) []string {
		home := filepath.Join(root, role)
		for _, part := range []string{"home", "config", "cache"} {
			if err := os.MkdirAll(filepath.Join(home, part), 0700); err != nil {
				t.Fatal(err)
			}
		}
		env := []string{}
		for _, v := range os.Environ() {
			if strings.HasPrefix(v, "HOME=") || strings.HasPrefix(v, "XDG_CONFIG_HOME=") || strings.HasPrefix(v, "XDG_CACHE_HOME=") || strings.HasPrefix(v, "LOCALAPPDATA=") || strings.HasPrefix(v, "APPDATA=") || strings.HasPrefix(v, "POCKETCONTEXT_") {
				continue
			}
			env = append(env, v)
		}
		return append(env, "IN_TS_TEST=true", "TS_DEBUG_DISABLE_PORTMAPPER=true", "HOME="+filepath.Join(home, "home"), "XDG_CONFIG_HOME="+filepath.Join(home, "config"), "XDG_CACHE_HOME="+filepath.Join(home, "cache"), "LOCALAPPDATA="+filepath.Join(home, "cache"), "APPDATA="+filepath.Join(home, "config"))
	}
	serverEnv, clientEnv := roleEnv("server"), roleEnv("client")
	run := func(env []string, input string, args ...string) map[string]any {
		cmd := exec.Command(binary, args...)
		cmd.Env = env
		cmd.Stdin = strings.NewReader(input)
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("CLI %s failed: %v (%s)", args[0], err, stderr.String())
		}
		var result map[string]any
		if err := json.Unmarshal(out, &result); err != nil {
			t.Fatalf("invalid CLI JSON: %v", err)
		}
		return result
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	db := filepath.Join(root, "project", "pocketcontext.db")
	os.MkdirAll(filepath.Dir(db), 0700)
	run(serverEnv, "synthetic-cli-rehearsal-password\n", "init", "--db", db, "--name", "Pairing rehearsal", "--port", strconv.Itoa(port), "--password-stdin")
	t.Cleanup(func() { cmd := exec.Command(binary, "stop", "--db", db); cmd.Env = serverEnv; _ = cmd.Run() })
	status := run(serverEnv, "", "status", "--db", db)
	if status["headless"] != true {
		t.Fatal("server not headless")
	}
	cache, _ := status["cache"].(string)
	if cache == "" {
		t.Fatal("status omitted cache")
	}
	relayServer := derpserver.New(key.NewNode(), func(string, ...any) {})
	relay := httptest.NewUnstartedServer(derpserver.Handler(relayServer))
	relay.TLS = &tls.Config{NextProtos: []string{"http/1.1"}}
	relay.Config.TLSNextProto = map[string]func(*http.Server, *tls.Conn, http.Handler){}
	relay.StartTLS()
	defer relay.Close()
	defer relayServer.Close()
	stun, stopSTUN := stuntest.ServeWithPacketListener(t, nettype.Std{})
	defer stopSTUN()
	region := &tailcfg.DERPRegion{RegionID: 1, RegionCode: "test", Nodes: []*tailcfg.DERPNode{{Name: "t1", RegionID: 1, HostName: "127.0.0.1", IPv4: "127.0.0.1", IPv6: "none", STUNPort: stun.Port, DERPPort: relay.Listener.Addr().(*net.TCPAddr).Port, InsecureForTests: true, STUNTestIP: "127.0.0.1"}}}
	identityPath := filepath.Join(cache, "tunnel.json")
	identity, err := tunnel.LoadIdentity(identityPath, false)
	if err != nil {
		t.Fatal(err)
	}
	identity.Region = region
	if err := identity.Save(identityPath); err != nil {
		t.Fatal(err)
	}
	start := func(env []string, label string, args ...string) (func(), map[string]any) {
		stdoutPath := filepath.Join(root, label+".stdout")
		out, err := os.Create(stdoutPath)
		if err != nil {
			t.Fatal(err)
		}
		defer out.Close()
		stderr, err := os.Create(filepath.Join(root, label+".stderr"))
		if err != nil {
			t.Fatal(err)
		}
		defer stderr.Close()
		cmd := exec.Command(binary, args...)
		cmd.Env = env
		cmd.Stdout = out
		cmd.Stderr = stderr
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		stopped := false
		stop := func() {
			if stopped {
				return
			}
			stopped = true
			_ = cmd.Process.Signal(os.Interrupt)
			select {
			case <-done:
			case <-time.After(10 * time.Second):
				_ = cmd.Process.Kill()
				<-done
			}
		}
		t.Cleanup(stop)
		deadline := time.Now().Add(55 * time.Second)
		for time.Now().Before(deadline) {
			b, _ := os.ReadFile(stdoutPath)
			var result map[string]any
			if json.Unmarshal(b, &result) == nil {
				return stop, result
			}
			select {
			case err := <-done:
				stopped = true
				logs, _ := os.ReadFile(filepath.Join(root, label+".stderr"))
				t.Fatalf("%s failed before readiness: %v (%s)", label, err, logs)
			case <-time.After(50 * time.Millisecond):
			}
		}
		t.Fatalf("%s readiness timed out", label)
		return stop, nil
	}
	// Starting the tunnel alone must bring a stopped project back headlessly,
	// even when its reader port is occupied by an unrelated service.
	run(serverEnv, "", "stop", "--db", db)
	if run(serverEnv, "", "status", "--db", db)["running"] != false {
		t.Fatal("server did not stop before automatic-start rehearsal")
	}
	readerPort, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { readerPort.Close() })
	stopServer, ready := start(serverEnv, "serve", "tunnel", "serve", "--db", db)
	defer stopServer()
	status = run(serverEnv, "", "status", "--db", db)
	if ready["ready"] != true || ready["serverRunning"] != true || status["running"] != true || status["headless"] != true || status["tcp"] != false {
		t.Fatal("tunnel did not automatically start a headless server")
	}
	lease, ok := status["lease"].(map[string]any)
	if !ok || lease["pid"] == nil {
		t.Fatal("running server omitted its lease PID")
	}
	serverPID := lease["pid"]
	readerPort.Close()

	// A second invocation must refuse before rotating the active identity.
	beforeIdentity, err := os.ReadFile(identityPath)
	if err != nil {
		t.Fatal(err)
	}
	duplicate := exec.Command(binary, "tunnel", "serve", "--db", db, "--new-address")
	duplicate.Env = serverEnv
	duplicateOutput, err := duplicate.CombinedOutput()
	if err == nil || !strings.Contains(string(duplicateOutput), "already running") {
		t.Fatalf("duplicate tunnel was not refused: %v (%s)", err, duplicateOutput)
	}
	afterIdentity, err := os.ReadFile(identityPath)
	if err != nil || !bytes.Equal(beforeIdentity, afterIdentity) {
		t.Fatal("duplicate tunnel changed the active identity")
	}
	// The only handoff is the complete prompt emitted by invite.
	inviteCmd := exec.Command(binary, "tunnel", "invite", "--db", db)
	inviteCmd.Env = serverEnv
	prompt, err := inviteCmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	marker := "Invitation JSON (use the complete object unchanged):\n"
	_, invitationText, ok := strings.Cut(string(prompt), marker)
	if !ok {
		t.Fatal("generated prompt omitted its invitation")
	}
	var invitation invitation
	if err := json.Unmarshal([]byte(invitationText), &invitation); err != nil {
		t.Fatal(err)
	}
	url := fmt.Sprintf("http://127.0.0.1:%d", port)
	t.Cleanup(func() {
		cmd := exec.Command(binary, "tunnel", "stop", "--url", url)
		cmd.Env = clientEnv
		_ = cmd.Run()
	})
	joined := run(clientEnv, invitationText, "tunnel", "join", "--stdin", "--no-browser")
	if joined["signedIn"] != true || joined["saved"] != true || joined["background"] != true {
		t.Fatal("join did not sign in and persist in background")
	}
	if run(clientEnv, "", "tunnel", "status", "--url", url)["running"] != true {
		t.Fatal("managed forward not running")
	}
	link, _ := joined["signInLink"].(string)
	_, browserCode, ok := strings.Cut(link, "#")
	if !ok || browserCode == "" {
		t.Fatal("join omitted reader sign-in link")
	}
	response, err := http.Post(url+"/api/bundle/redeem", "application/json", strings.NewReader(fmt.Sprintf(`{"code":%q}`, browserCode)))
	if err != nil {
		t.Fatal(err)
	}
	var browserSession map[string]any
	err = json.NewDecoder(response.Body).Decode(&browserSession)
	response.Body.Close()
	if err != nil || response.StatusCode != 200 || browserSession["token"] == nil {
		t.Fatal("reader link did not sign in")
	}
	response, err = http.Post(url+"/api/bundle/redeem", "application/json", strings.NewReader(fmt.Sprintf(`{"code":%q}`, browserCode)))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 401 {
		t.Fatal("reader sign-in link reusable")
	}
	who := run(clientEnv, "", "whoami", "--url", url)
	if who["knowledgeBaseName"] != "Pairing rehearsal" {
		t.Fatalf("wrong project name: %v", who["knowledgeBaseName"])
	}
	run(clientEnv, "", "sql", "SELECT count(*) AS n FROM sources", "--url", url)
	run(clientEnv, "", "skill", "--url", url)
	run(clientEnv, "", "profile", "check", "Pairing rehearsal")
	if run(serverEnv, "", "status", "--db", db)["headless"] != true {
		t.Fatal("tunnel enabled server TCP")
	}
	run(clientEnv, "", "tunnel", "stop", "--url", url)
	if run(clientEnv, "", "tunnel", "status", "--url", url)["running"] != false {
		t.Fatal("managed stop did not stop")
	}
	run(clientEnv, "", "tunnel", "forward", "--url", url, "--background")
	run(clientEnv, "", "tunnel", "forward", "--url", url, "--background") // idempotent
	run(clientEnv, "", "whoami", "--url", url)
	run(clientEnv, "", "open", "--url", url, "--no-browser")
	run(clientEnv, "", "tunnel", "stop", "--url", url)
	// Failed redemption must stop a newly created worker, but not destroy a saved session.
	cmd := exec.Command(binary, "tunnel", "join", "--stdin", "--no-browser")
	cmd.Env = clientEnv
	cmd.Stdin = strings.NewReader(invitationText)
	var output bytes.Buffer
	cmd.Stdout = &output
	cmd.Stderr = &output
	if err := cmd.Run(); err == nil {
		t.Fatal("reused one-time invitation")
	}
	if strings.Contains(output.String(), invitation.Code) || strings.Contains(output.String(), invitation.Address) {
		t.Fatal("failed join leaked invitation data")
	}
	if run(clientEnv, "", "tunnel", "status", "--url", url)["running"] != false {
		t.Fatal("failed join left worker running")
	}
	// Both automatic SSH detection and explicit CLI-only pairing avoid reader
	// handoffs while preserving the authenticated CLI and managed forward.
	for _, mode := range []string{"ssh", "explicit"} {
		inviteCmd := exec.Command(binary, "tunnel", "invite", "--db", db)
		inviteCmd.Env = serverEnv
		prompt, err := inviteCmd.Output()
		if err != nil {
			t.Fatal(err)
		}
		_, payload, ok := strings.Cut(string(prompt), marker)
		if !ok {
			t.Fatal("fresh invitation missing")
		}
		env := append([]string{}, clientEnv...)
		options := []string{"tunnel", "join", "--stdin"}
		if mode == "ssh" {
			env = append(env, "SSH_CONNECTION=synthetic-test-session")
		} else {
			options = append(options, "--skip-reader")
		}
		joined := run(env, payload, options...)
		if joined["readerSkipped"] != true || joined["signedIn"] != true || joined["forwarding"] != true {
			t.Fatalf("CLI-only join failed: %v", joined)
		}
		if _, exists := joined["signInLink"]; exists {
			t.Fatal("CLI-only join issued a reader link")
		}
		run(env, "", "whoami", "--url", url)
		run(env, "", "tunnel", "stop", "--url", url)
	}
	// A busy port is never taken over or silently remapped.
	occupied, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		t.Fatal(err)
	}
	cmd = exec.Command(binary, "tunnel", "forward", "--url", url, "--background")
	cmd.Env = clientEnv
	if err := cmd.Run(); err == nil {
		occupied.Close()
		t.Fatal("accepted busy port")
	}
	occupied.Close()
	// Interrupting the tunnel leaves the server available. Restarting the
	// tunnel reuses that process, including TCP explicitly activated by open.
	stopServer()
	status = run(serverEnv, "", "status", "--db", db)
	lease, ok = status["lease"].(map[string]any)
	if status["running"] != true || !ok || lease["pid"] != serverPID {
		t.Fatal("stopping the tunnel stopped or replaced its server")
	}
	run(serverEnv, "", "open", "--db", db, "--no-browser")
	stopRestarted, _ := start(serverEnv, "serve-reused", "tunnel", "serve", "--db", db)
	status = run(serverEnv, "", "status", "--db", db)
	lease, ok = status["lease"].(map[string]any)
	if status["running"] != true || status["tcp"] != true || !ok || lease["pid"] != serverPID {
		t.Fatal("restarted tunnel did not reuse the server and preserve its listeners")
	}
	stopRestarted()
	if run(serverEnv, "", "status", "--db", db)["running"] != true {
		t.Fatal("stopping the restarted tunnel stopped its reused server")
	}
	rehearseCombinedService(t, binary, root, db, cache, serverEnv, clientEnv, run)
	t.Log("automatic headless startup, duplicate refusal, interrupt and listener-preserving reuse; generated prompt -> stdin join -> managed forward -> authenticated reader -> stop/reconnect; used code and busy port refused")
}
