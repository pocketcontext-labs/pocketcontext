package client

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"time"

	"github.com/pocketcontext-labs/pocketcontext/internal/bundle"
	"github.com/pocketcontext-labs/pocketcontext/internal/tunnel"
)

// Managed tunnels use a private heartbeat and stop request rather than killing a
// recorded PID, which might have been recycled by the OS. The OS lock serializes
// workers; each stop request names the exact random worker generation.
type managedState struct {
	ID          string    `json:"id"`
	Fingerprint string    `json:"fingerprint"`
	Updated     time.Time `json:"updated"`
}
type managedInput struct {
	Connection connection `json:"connection"`
	ID         string     `json:"id"`
}

func managedPaths(base string) (dir, state, stop string, err error) {
	p, err := connectionPath(base)
	if err != nil {
		return "", "", "", err
	}
	dir = filepath.Join(filepath.Dir(p), "managed-forward")
	return dir, filepath.Join(dir, "state.json"), filepath.Join(dir, "stop"), nil
}
func connectionFingerprint(c connection) string {
	b, _ := json.Marshal(c)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
func readManagedState(path string) (managedState, error) {
	var s managedState
	b, e := os.ReadFile(path)
	if e != nil {
		return s, e
	}
	if json.Unmarshal(b, &s) != nil || s.ID == "" || s.Fingerprint == "" {
		return s, errors.New("invalid managed tunnel state")
	}
	if age := time.Since(s.Updated); age < -5*time.Second || age > 5*time.Second {
		return s, errors.New("managed tunnel is not running")
	}
	return s, nil
}
func writeManagedState(path string, s managedState) error {
	s.Updated = time.Now()
	b, e := json.Marshal(s)
	if e != nil {
		return e
	}
	return bundle.WriteAtomic(path, b, 0600)
}
func managedWorker(ctx context.Context) error {
	var input managedInput
	d := json.NewDecoder(io.LimitReader(os.Stdin, 65537))
	d.DisallowUnknownFields()
	if d.Decode(&input) != nil || input.ID == "" {
		return fail(2, "invalid managed tunnel input")
	}
	c := input.Connection
	base, e := normalizeURL(c.URL)
	if e != nil || base != c.URL || c.Format != 1 {
		return fail(2, "invalid managed connection")
	}
	addr, e := tunnel.ParseAddress(c.Address)
	if e != nil {
		return e
	}
	dir, statePath, stopPath, e := managedPaths(c.URL)
	if e != nil {
		return e
	}
	release, e := bundle.AcquireTunnelLock(&bundle.Project{Cache: dir})
	if e != nil {
		return e
	}
	defer release()
	n, _ := strconv.Atoi(port(c.URL))
	ln, e := tunnel.Listen("127.0.0.1", n)
	if e != nil {
		return e
	}
	defer ln.Close()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- tunnel.Forward(ctx, addr, ln, n) }()
	s := managedState{ID: input.ID, Fingerprint: connectionFingerprint(c)}
	if e = writeManagedState(statePath, s); e != nil {
		return e
	}
	defer os.Remove(statePath)
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case e := <-done:
			return e
		case <-tick.C:
			if b, e := os.ReadFile(stopPath); e == nil && string(b) == s.ID {
				_ = os.Remove(stopPath)
				return nil
			}
			if e := writeManagedState(statePath, s); e != nil {
				return e
			}
		}
	}
}
func ensureManagedForward(ctx context.Context, c connection) (string, error) {
	dir, statePath, _, e := managedPaths(c.URL)
	if e != nil {
		return "", e
	}
	if s, e := readManagedState(statePath); e == nil {
		if s.Fingerprint != connectionFingerprint(c) {
			return "", fail(1, "a different managed connection uses this port; stop it explicitly before pairing")
		}
		return "", waitForwardIdentity(ctx, c)
	}
	if e = os.MkdirAll(dir, 0700); e != nil {
		return "", e
	}
	executable, e := os.Executable()
	if e != nil {
		return "", e
	}
	input := managedInput{c, bundle.RandomHex(24)}
	b, _ := json.Marshal(input)
	cmd := exec.Command(executable, "tunnel", "_forward")
	cmd.Stdin = bytes.NewReader(b)
	// Diagnostics are retained privately and never contain the invitation code.
	log, e := os.OpenFile(filepath.Join(dir, "forward.log"), os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if e != nil {
		return "", e
	}
	defer log.Close()
	cmd.Stdout = log
	cmd.Stderr = log
	detachTunnel(cmd)
	if e = cmd.Start(); e != nil {
		return "", e
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			_ = cmd.Process.Kill()
			<-done
			return "", ctx.Err()
		case <-deadline.C:
			_ = cmd.Process.Kill()
			<-done
			return "", fail(1, "managed forward startup timed out")
		case <-done:
			return "", fail(1, "managed forward could not start; check the required port and private log at %s", filepath.Join(dir, "forward.log"))
		case <-tick.C:
			if s, e := readManagedState(statePath); e == nil && s.ID == input.ID {
				if e = waitForwardIdentity(ctx, c); e != nil {
					_ = stopManagedGeneration(c.URL, input.ID)
					return "", e
				}
				return input.ID, nil
			}
		}
	}
}
func waitForwardIdentity(ctx context.Context, c connection) error {
	deadline := time.Now().Add(45 * time.Second)
	for time.Now().Before(deadline) {
		i, e := probe(c.URL)
		if e == nil {
			if c.Instance != "" && i.Instance != c.Instance {
				return fail(1, "invitation identity mismatch; no code was sent")
			}
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
	return fail(1, "server not reachable; check that its tunnel is running")
}
func stopManagedForward(base string) error { return stopManagedGeneration(base, "") }

func stopManagedGeneration(base, expectedID string) error {
	dir, statePath, stopPath, e := managedPaths(base)
	if e != nil {
		return e
	}
	s, e := readManagedState(statePath)
	if e != nil {
		if os.IsNotExist(e) {
			return nil
		}
		return e
	}
	if expectedID != "" && s.ID != expectedID {
		return nil
	}
	if e = bundle.WriteAtomic(stopPath, []byte(s.ID), 0600); e != nil {
		return e
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		current, e := readManagedState(statePath)
		if e == nil && current.ID != s.ID {
			return nil
		}
		if os.IsNotExist(e) {
			// The worker removes its state before its deferred listener close
			// and final lock release. Wait for both before allowing a restart.
			if release, err := bundle.AcquireTunnelLock(&bundle.Project{Cache: dir}); err == nil {
				release()
				return nil
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	return fail(1, "managed forward did not stop; no unrelated process was terminated")
}
func joinManaged(ctx context.Context, in invitation, noBrowser, pretty bool) error {
	started, e := ensureManagedForward(ctx, in.connection)
	if e != nil {
		return e
	}
	keep := false
	defer func() {
		if started != "" && !keep {
			_ = stopManagedGeneration(in.URL, started)
		}
	}()
	if _, e = redeemCode(in.URL, in.Code, in.Instance); e != nil {
		return e
	}
	if e = saveConnection(in.connection); e != nil {
		return e
	}
	keep = true // A browser failure must not undo a successful CLI connection.
	out, e := openRemoteReader(in.URL, noBrowser)
	if e != nil {
		return fmt.Errorf("CLI connected and tunnel saved; open the reader with `open --url %s`: %w", in.URL, e)
	}
	out["name"], out["instance"], out["signedIn"], out["saved"], out["forwarding"], out["background"] = in.Name, in.Instance, true, true, true, true
	Print(out, pretty)
	return nil
}
func managedCommand(a *args, pretty bool) error {
	if len(a.pos) != 1 || a.has("db") || a.flags["url"] == "" {
		return fail(2, "usage: pocketcontext tunnel %s --url URL", a.pos[0])
	}
	base, e := normalizeURL(a.flags["url"])
	if e != nil {
		return e
	}
	if a.pos[0] == "stop" {
		if e = stopManagedForward(base); e != nil {
			return e
		}
		Print(map[string]any{"url": base, "stopped": true}, pretty)
		return nil
	}
	_, path, _, e := managedPaths(base)
	if e != nil {
		return e
	}
	_, e = readManagedState(path)
	Print(map[string]any{"url": base, "running": e == nil, "background": true}, pretty)
	return nil
}
