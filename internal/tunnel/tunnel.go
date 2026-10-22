// Package tunnel carries one PocketContext port between two computers through
// tailcat: WireGuard over Tailscale's data plane, bootstrapped through a DERP
// relay, without a Tailscale account or control plane. The agent computer serves
// exactly the project's port and proxies it to the server on 127.0.0.1; the
// person's computer listens on the same loopback port and dials it through the
// tunnel. Nothing else is reachable: no other ports, no forwarding through the
// server, no UDP.
package tunnel

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/tailscale/tailcat"
	"tailscale.com/tailcfg"
	"tailscale.com/types/key"
	"tailscale.com/wgengine/filter"

	"github.com/pocketcontext-labs/pocketcontext/internal/bundle"
)

// Identity is the server's tailcat identity. Keeping it makes the address
// stable across restarts; anyone holding the address can reach the served port,
// so the file is as private as the address.
type Identity struct {
	Key          key.NodePrivate      `json:"key"`
	PresharedKey tailcat.PresharedKey `json:"presharedKey"`
	// Region is the bootstrap relay chosen on the first start. The address
	// embeds its details, so it is reused to keep the address the same; when
	// that relay is retired, --new-address picks the nearest one again.
	Region *tailcfg.DERPRegion `json:"region,omitempty"`
}

// LoadIdentity reads the identity at path, or creates and saves a new one when
// the file is missing or rotate is set.
func LoadIdentity(path string, rotate bool) (*Identity, error) {
	if !rotate {
		data, err := os.ReadFile(path)
		if err == nil {
			var id Identity
			if err := json.Unmarshal(data, &id); err != nil || id.Key.IsZero() || id.PresharedKey.IsZero() {
				return nil, fmt.Errorf("the tunnel identity %s is damaged; run `pocketcontext tunnel serve --new-address`", path)
			}
			return &id, nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
	}
	id := &Identity{Key: key.NewNode(), PresharedKey: tailcat.NewPresharedKey()}
	return id, id.Save(path)
}

// Save writes the identity to a private file.
func (id *Identity) Save(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(id, "", "  ")
	if err != nil {
		return err
	}
	return bundle.WriteAtomic(path, append(data, '\n'), 0600)
}

// quiet discards tailcat's and the data plane's diagnostics, which name keys
// and endpoints and would otherwise go to the standard logger.
func quiet(string, ...any) {}

// Serve exposes port on 127.0.0.1 through tailcat until ctx ends. ready
// receives the address once the server is up. A new identity gets the nearest
// public relay, recorded in id.Region for the caller to save.
func Serve(ctx context.Context, port int, id *Identity, ready func(tailcat.Addr)) error {
	if port < 1 || port > 65535 {
		return fmt.Errorf("port %d is out of range", port)
	}
	served := uint16(port)
	target := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	s := &tailcat.Server{
		Key:            id.Key,
		PresharedKey:   id.PresharedKey,
		Logf:           quiet,
		Region:         id.Region,
		ServedTCPPorts: []filter.PortRange{{First: served, Last: served}},
		OnTCP: func(p uint16) func(net.Conn) {
			if p != served {
				return nil
			}
			return func(c net.Conn) {
				local, err := net.DialTimeout("tcp", target, 10*time.Second)
				if err != nil {
					c.Close()
					return
				}
				tailcat.ProxyConns(c, local)
			}
		},
	}
	if err := s.Start(); err != nil {
		s.Close()
		return fmt.Errorf("the tunnel did not start: %v", err)
	}
	defer s.Close()
	addr := s.TailcatAddr()
	if id.Region == nil {
		if info, err := tailcat.ParseAddr(addr); err == nil && len(info.Region) == 1 {
			id.Region = info.Region[0]
		}
	}
	ready(addr)
	<-ctx.Done()
	return nil
}

// ParseAddress validates a tailcat address without echoing it in errors: the
// address is the capability to reach the served port.
func ParseAddress(text string) (tailcat.Addr, error) {
	addr := tailcat.Addr(text)
	if _, err := tailcat.ParseAddr(addr); err != nil {
		return "", errors.New("that is not a valid tailcat address; copy the address printed by `pocketcontext tunnel serve` on the agent computer")
	}
	return addr, nil
}

// Listen opens the loopback listener for Forward. A busy port is an error:
// the server only accepts its own port, so another one would not work.
func Listen(host string, port int) (net.Listener, error) {
	address := net.JoinHostPort(host, strconv.Itoa(port))
	ln, err := net.Listen("tcp", address)
	if err != nil {
		return nil, fmt.Errorf("cannot listen on %s (%v); the forward needs this exact port, so stop whatever uses it or ask its owner, then retry", address, err)
	}
	return ln, nil
}

// Forward accepts connections on ln and carries each one to the same port on
// the server at addr, until ctx ends.
func Forward(ctx context.Context, addr tailcat.Addr, ln net.Listener, port int) error {
	c := &tailcat.Client{Server: addr, Logf: quiet}
	defer c.Close()
	go func() {
		<-ctx.Done()
		ln.Close()
	}()
	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		go func() {
			dial, cancel := context.WithTimeout(ctx, 30*time.Second)
			defer cancel()
			remote, err := c.DialTCPPort(dial, uint16(port))
			if err != nil {
				io.WriteString(os.Stderr, "pocketcontext: the agent computer did not answer through the tunnel; check that `pocketcontext tunnel serve` runs there\n")
				conn.Close()
				return
			}
			tailcat.ProxyConns(conn, remote)
		}()
	}
}
