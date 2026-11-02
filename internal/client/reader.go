package client

import (
	"net/url"
	"strings"

	"github.com/pocketcontext-labs/pocketcontext/internal/bundle"
)

// openRemoteReader issues a separate one-time browser handoff. The reusable
// CLI token stays in its private cache and never appears in the link or output.
func openRemoteReader(base string, noBrowser bool) (map[string]any, error) {
	c, err := NewRemote(base, "")
	if err != nil {
		return nil, err
	}
	data, err := c.Must("POST", "/api/bundle/reader-code", map[string]any{})
	if err != nil {
		return nil, err
	}
	raw, _ := dig(data, "url").(string)
	u, err := url.Parse(raw)
	if err != nil || u.Path != "/bundle/login" || u.RawQuery != "" || u.User != nil || u.Opaque != "" {
		return nil, fail(1, "server returned an invalid reader sign-in link")
	}
	origin, err := normalizeURL(u.Scheme + "://" + u.Host)
	if err != nil || port(origin) != port(base) || len(u.Fragment) != 48 || strings.Trim(u.Fragment, "0123456789abcdef") != "" {
		return nil, fail(1, "server returned an invalid reader sign-in link")
	}
	// Keep the client's chosen localhost/127.0.0.1 origin and browser storage.
	link := base + "/bundle/login#" + u.Fragment
	out := map[string]any{"url": base, "signInLink": link, "expires": dig(data, "expires"), "browserOpened": false,
		"note": "single-use reader sign-in link, valid for 2 minutes; open it in this computer's browser"}
	if !noBrowser {
		if err := bundle.OpenBrowser(link); err != nil {
			out["note"] = "Could not launch a browser. Open signInLink in this computer's browser within 2 minutes."
		} else {
			out["browserOpened"] = true
		}
	}
	return out, nil
}
