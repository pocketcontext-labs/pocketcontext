package client

import (
	"net/url"
	"strings"

	"github.com/pocketcontext-labs/pocketcontext/internal/bundle"
)

// skippedReader decides before resolving a project, starting a server, enabling
// TCP, loading authentication, or minting a browser code. Explicit --no-browser
// means the caller has established that the user can reach this endpoint.
func skippedReader(noBrowser, skipReader bool) map[string]any {
	environment := bundle.ReaderEnvironment()
	if !skipReader && (noBrowser || environment.CanOpen()) {
		return nil
	}
	note := "Reader sign-in skipped because this session has no confirmed usable desktop browser. Continue setup on the user's computer; localhost links here do not establish access from another computer."
	next := "choose-reader-computer"
	if environment.Session == "ssh" || environment.Session == "headless" {
		next = "client-setup"
	}
	if skipReader {
		note = "Reader sign-in skipped as requested; no reader code was issued."
		next = "none"
	}
	return map[string]any{"readerSkipped": true, "browserLaunchRequested": false,
		"environment": environment, "nextAction": next, "note": note}
}

// readerHandoff reports only dispatch of a launcher, never that the browser or
// page was observed. A printed code is an intentional handoff, not a health check.
func readerHandoff(base, link string, noBrowser bool) map[string]any {
	out := map[string]any{"url": base, "signInLink": link, "readerSkipped": false,
		"browserLaunchRequested": false, "note": "Single-use reader sign-in link, valid for 2 minutes. Use a browser with verified access to this computer's loopback endpoint."}
	if !noBrowser {
		if err := bundle.OpenBrowser(link); err != nil {
			out["note"] = "Browser launcher did not accept the request. Use signInLink only in a browser with verified access to this endpoint; otherwise continue client setup on the user's computer."
		} else {
			out["browserLaunchRequested"] = true
			out["note"] = "Browser launch requested; opening and sign-in are not verified. The single-use link expires in 2 minutes."
		}
	}
	return out
}

func openLocalReader(p *bundle.Project, noBrowser bool) (map[string]any, error) {
	if err := bundle.EnsureRunning(p, bundle.StartOptions{}); err != nil {
		return nil, err
	}
	if err := bundle.EnableTCP(p); err != nil {
		return nil, err
	}
	data, err := bundle.LocalCall(p, "/api/bundle/login-code", map[string]any{})
	if err != nil {
		return nil, err
	}
	link, _ := data["url"].(string)
	return readerHandoff(p.URL(), link, noBrowser), nil
}

// openRemoteReader issues a separate one-time browser handoff. The reusable
// CLI token stays in its private cache and never appears in the link or output.
func openRemoteReader(base string, noBrowser, skipReader bool) (map[string]any, error) {
	if noBrowser && skipReader {
		return nil, fail(2, "choose --no-browser or --skip-reader, not both")
	}
	if out := skippedReader(noBrowser, skipReader); out != nil {
		return out, nil
	}
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
	out := readerHandoff(base, link, noBrowser)
	out["expires"] = dig(data, "expires")
	return out, nil
}
