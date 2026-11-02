package client

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"github.com/tailscale/tailcat"

	"github.com/pocketcontext-labs/pocketcontext/internal/bundle"
	"github.com/pocketcontext-labs/pocketcontext/internal/profiles"
	"github.com/pocketcontext-labs/pocketcontext/internal/tunnel"
)

// identityFile is the tunnel identity in the project's private cache: never
// in the synced project folder, which other computers and people may read.
func identityFile(p *bundle.Project) string { return filepath.Join(p.Cache, "tunnel.json") }

// runTunnel runs `tunnel serve` on the agent computer or `tunnel forward` on
// the person's computer. Both run in the foreground until interrupted.
func runTunnel(a *args, pretty bool) error {
	if len(a.pos) == 0 {
		return fail(2, "usage: pocketcontext tunnel serve|forward|invite|join; run `pocketcontext tunnel --help`")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	switch a.pos[0] {
	case "serve":
		return tunnelServe(ctx, a, pretty)
	case "forward":
		return tunnelForward(ctx, a, pretty)
	case "invite":
		return tunnelInvite(a, pretty)
	case "join":
		return tunnelJoin(ctx, a, pretty)
	}
	return fail(2, "usage: pocketcontext tunnel serve|forward|invite|join; run `pocketcontext tunnel --help`")
}

func tunnelServe(ctx context.Context, a *args, pretty bool) error {
	if a.has("url") {
		return fail(2, "tunnel serve runs on the agent computer beside the database; use --db, not --url")
	}
	if len(a.pos) != 1 || a.bools["address-stdin"] {
		return fail(2, "usage: pocketcontext tunnel serve [--new-address]")
	}
	p, err := bundle.Resolve(a.flags["db"])
	if err != nil {
		return fail(2, "%v", err)
	}
	if _, err := os.Stat(p.DB); err != nil {
		return fail(2, "no PocketContext database at %s; run `pocketcontext init` first, or pass --db", p.DB)
	}
	release, err := bundle.AcquireTunnelLock(p)
	if err != nil {
		return err
	}
	defer release()
	path := identityFile(p)
	id, err := tunnel.LoadIdentity(path, a.bools["new-address"])
	if err != nil {
		return fail(1, "%v", err)
	}
	chosen := id.Region != nil
	running, runErr := bundle.Running(p)
	if runErr != nil {
		return runErr
	}
	if !running {
		return fail(1, "start the project with ensure-running before tunnel serve")
	}
	endpoint := filepath.Join(p.Cache, "tunnel-endpoint.json")
	defer os.Remove(endpoint)
	err = tunnel.ServeBackend(ctx, p.Config.Port, id, func(addr tailcat.Addr) {
		if !chosen && id.Region != nil {
			if err := id.Save(path); err != nil {
				fmt.Fprintf(os.Stderr, "pocketcontext: could not keep the tunnel identity (%v); the address will change on the next start\n", err)
			}
		}
		data, _ := json.Marshal(connection{Format: 1, Address: string(addr), URL: p.URL(), Instance: p.Config.Instance, Name: p.Config.Name})
		if e := bundle.WriteAtomic(endpoint, append(data, '\n'), 0600); e != nil {
			fmt.Fprintln(os.Stderr, "could not save private endpoint:", e)
			return
		}
		Print(map[string]any{"port": p.Config.Port, "serverRunning": running, "ready": true, "note": "Create a private invitation with tunnel invite --out FILE. Keep this process supervised."}, pretty)
	}, func() (net.Conn, error) { return dialTunnelBackend(p) })
	if err != nil {
		return fail(1, "%v", err)
	}
	return nil
}

func tunnelForward(ctx context.Context, a *args, pretty bool) error {
	if a.has("db") {
		return fail(2, "tunnel forward runs on the client computer and never uses a local database; use --url, not --db")
	}
	if a.bools["new-address"] {
		return fail(2, "--new-address belongs to `tunnel serve` on the agent computer")
	}
	raw, fromFlag := a.flags["url"], a.has("url")
	if !fromFlag {
		raw = os.Getenv("POCKETCONTEXT_URL")
	}
	if raw == "" {
		r, err := profiles.Read()
		if err != nil {
			return err
		}
		if r.Default != "" {
			e, err := r.Find(r.Default)
			if err != nil {
				return err
			}
			if e.URL != "" {
				raw = e.URL
			}
		}
		if raw == "" {
			var urls []string
			for _, e := range r.Profiles {
				if e.URL != "" {
					urls = append(urls, e.URL)
				}
			}
			if len(urls) > 1 {
				return fail(2, "several remote knowledge bases are registered; choose --url or set a remote profile default")
			}
			if len(urls) == 1 {
				raw = urls[0]
			}
		}
		if raw == "" {
			raw = fmt.Sprintf("http://127.0.0.1:%d", bundle.DefaultPort)
		}
	}
	base, err := normalizeURL(raw)
	if err != nil {
		return err
	}
	var text string
	switch {
	case a.bools["address-stdin"] && len(a.pos) == 1:
		line, err := bufio.NewReader(os.Stdin).ReadString('\n')
		if err != nil && !errors.Is(err, io.EOF) {
			return err
		}
		text = line
	case !a.bools["address-stdin"] && len(a.pos) == 1:
		saved, err := loadConnection(base)
		if err != nil {
			return err
		}
		text = saved.Address
	case !a.bools["address-stdin"] && len(a.pos) == 2:
		text = a.pos[1]
	default:
		return fail(2, "usage: pocketcontext tunnel forward (ADDRESS | --address-stdin) [--url http://127.0.0.1:PORT]")
	}
	addr, err := tunnel.ParseAddress(strings.TrimSpace(text))
	if err != nil {
		return fail(2, "%v", err)
	}
	u, _ := url.Parse(base)
	port, _ := strconv.Atoi(u.Port())
	host := u.Hostname()
	if host == "localhost" {
		host = "127.0.0.1"
	}
	ln, err := tunnel.Listen(host, port)
	if err != nil {
		return fail(1, "%v", err)
	}
	if a.bools["save"] {
		if err := saveConnection(connection{Format: 1, Address: string(addr), URL: base}); err != nil {
			ln.Close()
			return err
		}
	}
	Print(map[string]any{"url": base, "forwarding": true,
		"note": "the agent computer's PocketContext is reachable at this URL while this runs; sign in with `pocketcontext login --url " + base + " --code-stdin`. Stop with Ctrl-C."}, pretty)
	if err := tunnel.Forward(ctx, addr, ln, port); err != nil {
		return fail(1, "the forward stopped: %v", err)
	}
	return nil
}
