package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/pocketcontext-labs/pocketcontext/internal/bundle"
	"github.com/pocketcontext-labs/pocketcontext/internal/tunnel"
)

type connection struct {
	Format   int    `json:"format"`
	Address  string `json:"address"`
	URL      string `json:"url"`
	Instance string `json:"instance,omitempty"`
	Name     string `json:"name,omitempty"`
}
type invitation struct {
	connection
	Code    string    `json:"code"`
	Expires time.Time `json:"expires"`
}

func connectionPath(base string) (string, error) {
	p, e := sessionPath(base)
	return filepath.Join(filepath.Dir(p), "forward.json"), e
}
func saveConnection(c connection) error {
	p, e := connectionPath(c.URL)
	if e != nil {
		return e
	}
	if e = os.MkdirAll(filepath.Dir(p), 0700); e != nil {
		return e
	}
	b, e := json.Marshal(c)
	if e != nil {
		return e
	}
	return bundle.WriteAtomic(p, append(b, '\n'), 0600)
}
func loadConnection(base string) (connection, error) {
	var c connection
	p, e := connectionPath(base)
	if e != nil {
		return c, e
	}
	b, e := os.ReadFile(p)
	if errors.Is(e, os.ErrNotExist) {
		return c, fail(2, "no saved forward for %s; import an invitation or use --address-stdin --save", base)
	}
	if e != nil {
		return c, e
	}
	if json.Unmarshal(b, &c) != nil || c.Format != 1 || c.URL != base {
		return c, fail(2, "invalid saved forward; pair again")
	}
	if _, e = tunnel.ParseAddress(c.Address); e != nil {
		return c, fail(2, "invalid saved forward; pair again")
	}
	return c, nil
}
func privateNewFile(path string, b []byte) error {
	f, e := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return e
	}
	_, e = f.Write(b)
	if e == nil {
		e = f.Sync()
	}
	closeErr := f.Close()
	if e == nil {
		e = closeErr
	}
	if e != nil {
		_ = os.Remove(path)
	}
	return e
}
func tunnelInvite(a *args, pretty bool) error {
	if len(a.pos) != 1 || a.has("url") {
		return fail(2, "usage: pocketcontext tunnel invite [--out NEW_FILE] --db DB")
	}
	p, e := bundle.Resolve(a.flags["db"])
	if e != nil {
		return e
	}
	var out string
	if a.has("out") {
		out, e = filepath.Abs(a.flags["out"])
		if e != nil {
			return e
		}
		parent, e := filepath.EvalSymlinks(filepath.Dir(out))
		if e != nil {
			return e
		}
		projectDir, e := filepath.EvalSymlinks(p.Dir)
		if e != nil {
			return e
		}
		relative, e := filepath.Rel(projectDir, parent)
		if e == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return fail(2, "choose an invitation destination outside the project folder; use its setup chat for the handoff")
		}
	}
	if release, err := bundle.AcquireTunnelLock(p); err == nil {
		release()
		return fail(1, "tunnel is not running; supervise tunnel serve before creating an invitation")
	}
	b, e := os.ReadFile(filepath.Join(p.Cache, "tunnel-endpoint.json"))
	if e != nil {
		return fail(1, "start and supervise `tunnel serve` before creating an invitation")
	}
	var c connection
	if json.Unmarshal(b, &c) != nil || c.Instance != p.Config.Instance || c.URL != p.URL() {
		return fail(1, "tunnel endpoint is stale; restart tunnel serve")
	}
	if _, e = tunnel.ParseAddress(c.Address); e != nil {
		return fail(1, "invalid tunnel endpoint; restart tunnel serve")
	}
	// Refuse overwriting before issuing a single-use code.
	if out != "" {
		if _, e = os.Lstat(out); e == nil {
			return fail(2, "invitation destination already exists")
		} else if !errors.Is(e, os.ErrNotExist) {
			return e
		}
	}
	data, e := bundle.LocalCall(p, "/api/bundle/login-code", map[string]any{"ttl": 600})
	if e != nil {
		return e
	}
	code, _ := data["code"].(string)
	expiry, _ := data["expires"].(string)
	expires, e := time.Parse(time.RFC3339, expiry)
	if e != nil || code == "" {
		return fail(1, "server did not issue a valid invitation code")
	}
	b, e = json.MarshalIndent(invitation{c, code, expires}, "", "  ")
	if e != nil {
		return e
	}
	if out == "" {
		fmt.Print(clientSetupPrompt(b))
		return nil
	}
	if e = privateNewFile(out, append(b, '\n')); e != nil {
		return e
	}
	Print(map[string]any{"file": out, "expires": expires, "name": c.Name, "note": "Share this invitation in your client setup chat. The code is single-use and expires; remove temporary file copies after joining."}, pretty)
	return nil
}
func readInvitation(path string) (invitation, error) {
	f, e := os.Open(path)
	if e != nil {
		return invitation{}, e
	}
	defer f.Close()
	return decodeInvitation(f)
}
func decodeInvitation(r io.Reader) (invitation, error) {
	var in invitation
	data, err := io.ReadAll(io.LimitReader(r, 65537))
	if err != nil {
		return in, err
	}
	if len(data) > 65536 {
		return in, fail(2, "invitation is too large")
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if d.Decode(&in) != nil {
		return in, fail(2, "invalid invitation JSON")
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return in, fail(2, "invalid invitation JSON")
	}
	base, e := normalizeURL(in.URL)
	if e != nil || base != in.URL || in.Format != 1 || in.Instance == "" || in.Code == "" {
		return in, fail(2, "invalid invitation JSON")
	}
	if _, e = tunnel.ParseAddress(in.Address); e != nil {
		return in, fail(2, "invalid invitation address")
	}
	if !time.Now().Before(in.Expires) {
		return in, fail(2, "invitation expired; request a fresh invitation when this client is ready")
	}
	return in, nil
}
func tunnelJoin(ctx context.Context, a *args, pretty bool) error {
	if len(a.pos) != 1 || a.has("file") == a.bools["stdin"] || a.has("db") || a.has("url") {
		return fail(2, "usage: pocketcontext tunnel join (--stdin | --file INVITATION_FILE) [--no-browser] [--foreground]")
	}
	var in invitation
	var e error
	if a.bools["stdin"] {
		in, e = decodeInvitation(os.Stdin)
	} else {
		in, e = readInvitation(a.flags["file"])
	}
	if e != nil {
		return e
	}
	if !a.bools["foreground"] {
		return joinManaged(ctx, in, a.bools["no-browser"], pretty)
	}
	addr, e := tunnel.ParseAddress(in.Address)
	if e != nil {
		return e
	}
	n, _ := strconv.Atoi(port(in.URL))
	ln, e := tunnel.Listen("127.0.0.1", n)
	if e != nil {
		return fail(1, "%v", e)
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	defer ln.Close()
	done := make(chan error, 1)
	go func() { done <- tunnel.Forward(ctx, addr, ln, n) }()
	// A forward's listener is ready before the relay session. Probe with a bound.
	deadline := time.Now().Add(45 * time.Second)
	var ready bool
	for time.Now().Before(deadline) {
		i, err := probe(in.URL)
		if err == nil {
			if i.Instance != in.Instance {
				return fail(1, "invitation identity mismatch; no code was sent")
			}
			ready = true
			break
		}
		select {
		case <-ctx.Done():
			return nil
		case err := <-done:
			return fmt.Errorf("forward stopped before sign-in: %w", err)
		case <-time.After(250 * time.Millisecond):
		}
	}
	if !ready {
		return fail(1, "server not reachable; check the supervised server tunnel and try again before the invitation expires")
	}
	if _, e = redeemCode(in.URL, in.Code, in.Instance); e != nil {
		return e
	}
	if e = saveConnection(in.connection); e != nil {
		return e
	}
	out, e := openRemoteReader(in.URL, a.bools["no-browser"])
	if e != nil {
		return e
	}
	out["name"], out["instance"], out["signedIn"], out["saved"], out["forwarding"] = in.Name, in.Instance, true, true, true
	out["note"] = "Keep this foreground process supervised. Install the remote skill with `skill --url URL`."
	Print(out, pretty)
	select {
	case <-ctx.Done():
		return nil
	case e = <-done:
		return e
	}
}

func dialTunnelBackend(p *bundle.Project) (net.Conn, error) {
	i, e := bundle.Health(p)
	if e != nil {
		return nil, e
	}
	if i.Instance != p.Config.Instance || i.Key != p.Key {
		return nil, fmt.Errorf("project identity mismatch")
	}
	if i.Socket != "" {
		return net.DialTimeout("unix", i.Socket, 10*time.Second)
	}
	return net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", p.Config.Port), 10*time.Second)
}
