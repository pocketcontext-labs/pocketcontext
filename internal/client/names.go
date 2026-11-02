package client

import (
	"net"
	"net/url"
	"strconv"
	"strings"

	"github.com/pocketcontext-labs/pocketcontext/internal/bundle"
	"github.com/pocketcontext-labs/pocketcontext/internal/profiles"
)

func projectName(p *bundle.Project, a *args, pretty bool) error {
	if len(a.pos) > 1 {
		return fail(2, "usage: pocketcontext name [NAME]")
	}
	if len(a.pos) == 1 {
		name := strings.TrimSpace(a.pos[0])
		if e := profiles.ValidateName(name); e != nil {
			return fail(2, "%v", e)
		}
		running, e := bundle.Running(p)
		if e != nil {
			return e
		}
		if running {
			if _, e = bundle.LocalCall(p, "/api/bundle/name", map[string]string{"name": name}); e != nil {
				return e
			}
		} else {
			p.Config.Name = name
			if e = p.SaveConfig(); e != nil {
				return e
			}
		}
		p.Config.Name = name
	}
	Print(map[string]any{"name": p.Config.Name, "instance": p.Config.Instance, "note": "Reconcile registered profiles explicitly with profile update after renaming."}, pretty)
	return nil
}
func availablePort() (int, error) {
	r, e := profiles.Read()
	if e != nil {
		return 0, e
	}
	used := map[int]bool{}
	for _, entry := range r.Profiles {
		if entry.DB != "" {
			if p, e := bundle.Resolve(entry.DB); e == nil {
				used[p.Config.Port] = true
			}
		} else if u, e := url.Parse(entry.URL); e == nil {
			n, _ := strconv.Atoi(u.Port())
			used[n] = true
		}
	}
	for n := bundle.DefaultPort; n <= 65535; n++ {
		if used[n] {
			continue
		}
		ln, e := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(n))
		if e == nil {
			ln.Close()
			return n, nil
		}
	}
	return 0, fail(1, "no available loopback port; choose --port explicitly")
}
