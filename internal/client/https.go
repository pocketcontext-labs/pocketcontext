package client

import (
	"net/mail"
	"net/url"
	"strings"

	"github.com/pocketcontext-labs/pocketcontext/internal/bundle"
)

func validateHTTPSArgs(a *args) error {
	if a.bools["hosted-restore"] && (!a.bools["hosted"] || a.bools["hosted-init"]) {
		return fail(2, "--hosted-restore requires --hosted and excludes --hosted-init")
	}
	if a.bools["hosted-init"] && !a.bools["hosted"] {
		return fail(2, "--hosted-init requires --hosted")
	}
	if a.bools["hosted"] && (!a.bools["mcp"] || !a.bools["headless"] || !a.has("domain") || a.bools["tunnel"] || a.has("acme-email")) {
		return fail(2, "--hosted requires --headless --domain --mcp and excludes --tunnel and --acme-email")
	}

	if a.bools["mcp"] && !a.has("domain") {
		return fail(2, "--mcp requires --domain and --headless")
	}
	if !a.has("domain") {
		if a.has("acme-email") {
			return fail(2, "--acme-email requires --domain")
		}
		return nil
	}
	if err := bundle.ValidateHTTPSDomain(a.flags["domain"]); err != nil {
		return fail(2, "%v", err)
	}
	if !a.bools["headless"] || a.bools["tcp-only"] || a.has("port") || a.has("ui-dev") {
		return fail(2, "--domain requires --headless and cannot be combined with --tcp-only, --port or --ui-dev; HTTPS uses port 443 and HTTP uses port 80")
	}
	if a.has("acme-email") {
		email := a.flags["acme-email"]
		parsed, err := mail.ParseAddress(email)
		if err != nil || parsed.Address != email || parsed.Name != "" {
			return fail(2, "--acme-email must be a plain email address")
		}
	}
	return nil
}

// Public handoff is explicit and works from SSH. It must never start an ordinary
// background server in place of the user's supervised HTTPS service.
func openPublicReader(p *bundle.Project) (map[string]any, error) {
	info, err := bundle.Health(p)
	if err != nil {
		return nil, fail(1, "HTTPS hosting is not running; start the configured service before open --public: %v", err)
	}
	if err := bundle.CheckServerCompatibility(info); err != nil {
		return nil, err
	}
	if info.Key != p.Key || (p.Config.Instance != "" && info.Instance != p.Config.Instance) {
		return nil, fail(1, "running server identity differs from the selected project")
	}
	if info.Hosted {
		return map[string]any{"url": info.PublicURL, "public": true, "readerSkipped": false, "browserLaunchRequested": false, "note": "Open this website and choose Log in with email."}, nil
	}
	base := info.PublicURL
	u, err := url.Parse(base)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Opaque != "" || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || bundle.ValidateHTTPSDomain(u.Host) != nil {
		return nil, fail(1, "this server has no valid public HTTPS origin; start it with serve --headless --domain HOST")
	}
	data, err := bundle.LocalCall(p, "/api/bundle/login-code", map[string]any{"public": true})
	if err != nil {
		return nil, err
	}
	return publicReaderHandoff(base, data)
}

func publicReaderHandoff(base string, data map[string]any) (map[string]any, error) {
	link, _ := data["url"].(string)
	prefix := base + "/bundle/login#"
	code := strings.TrimPrefix(link, prefix)
	if !strings.HasPrefix(link, prefix) || len(code) != 48 || strings.Trim(code, "0123456789abcdef") != "" {
		return nil, fail(1, "server returned an invalid public reader sign-in link")
	}
	return map[string]any{
		"url": base, "signInLink": link, "expires": data["expires"], "readerSkipped": false,
		"browserLaunchRequested": false, "public": true,
		"note": "Single-use reader sign-in link, valid for 2 minutes. Open it on your phone or another browser. This command does not verify public HTTPS reachability or browser sign-in.",
	}, nil
}
