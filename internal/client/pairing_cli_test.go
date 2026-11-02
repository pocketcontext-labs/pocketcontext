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
	stopServer, _ := start(serverEnv, "serve", "tunnel", "serve", "--db", db)
	defer stopServer()
	invitationPath := filepath.Join(root, "invitation.json")
	run(serverEnv, "", "tunnel", "invite", "--db", db, "--out", invitationPath)
	stopJoin, joined := start(clientEnv, "join", "tunnel", "join", "--file", invitationPath)
	if joined["signedIn"] != true || joined["saved"] != true {
		t.Fatal("join did not sign in and persist")
	}
	url := fmt.Sprintf("http://127.0.0.1:%d", port)
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
	stopJoin()
	stopForward, _ := start(clientEnv, "forward", "tunnel", "forward", "--url", url)
	run(clientEnv, "", "whoami", "--url", url)
	stopForward()
	// Successful join consumes the code: repeating the invitation must fail.
	cmd := exec.Command(binary, "tunnel", "join", "--file", invitationPath)
	cmd.Env = clientEnv
	var output bytes.Buffer
	cmd.Stdout = &output
	cmd.Stderr = &output
	if err := cmd.Run(); err == nil {
		t.Fatal("reused one-time invitation")
	}
	b, err := os.ReadFile(invitationPath)
	if err != nil {
		t.Fatal(err)
	}
	var invitation invitation
	if err := json.Unmarshal(b, &invitation); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(output.String(), invitation.Code) || strings.Contains(output.String(), invitation.Address) {
		t.Fatal("failed join leaked invitation secrets")
	}
	for _, suffix := range []string{"*.stdout", "*.stderr"} {
		paths, _ := filepath.Glob(filepath.Join(root, suffix))
		for _, p := range paths {
			logs, _ := os.ReadFile(p)
			if bytes.Contains(logs, []byte(invitation.Code)) || bytes.Contains(logs, []byte(invitation.Address)) {
				t.Fatal("process output leaked invitation secrets")
			}
		}
	}
	t.Log("headless server -> local relay -> invitation join -> authenticated query -> saved forward restart; consumed invitation refused; no secret output")
}
