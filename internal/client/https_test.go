package client

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pocketcontext-labs/pocketcontext/internal/bundle"
)

func TestHTTPSCLIOptions(t *testing.T) {
	for _, tc := range []struct {
		args []string
		ok   bool
	}{
		{[]string{"--headless", "--domain", "knowledge.example.com"}, true},
		{[]string{"--headless", "--domain", "knowledge.example.com", "--tunnel", "--acme-email", "owner@example.com"}, true},
		{[]string{"--headless", "--tunnel"}, true},
		{[]string{"--domain", "knowledge.example.com"}, false},
		{[]string{"--headless", "--domain", ""}, false},
		{[]string{"--headless", "--domain", "https://knowledge.example.com"}, false},
		{[]string{"--headless", "--domain", "knowledge.example.com:443"}, false},
		{[]string{"--headless", "--domain", "knowledge.example.com", "--port", "8096"}, false},
		{[]string{"--headless", "--domain", "knowledge.example.com", "--tcp-only"}, false},
		{[]string{"--headless", "--domain", "knowledge.example.com", "--ui-dev", "http://127.0.0.1:5173"}, false},
		{[]string{"--headless", "--acme-email", "owner@example.com"}, false},
		{[]string{"--headless", "--domain", "knowledge.example.com", "--acme-email", "Owner <owner@example.com>"}, false},
		{[]string{"--headless", "--domain", "knowledge.example.com", "--acme-email", ""}, false},
	} {
		a, err := parseArgs(tc.args, []string{"domain", "acme-email", "port", "ui-dev"}, []string{"headless", "tcp-only", "tunnel"})
		if err != nil {
			t.Fatal(err)
		}
		if err := validateHTTPSArgs(a); (err == nil) != tc.ok {
			t.Errorf("%q: %v (want success %v)", tc.args, err, tc.ok)
		}
	}
}

func TestPublicReaderHandoffRejectsForeignOrMalformedLinks(t *testing.T) {
	base := "https://knowledge.example.com"
	code := strings.Repeat("a", 48)
	for _, link := range []string{
		"https://other.example.com/bundle/login#" + code,
		"http://knowledge.example.com/bundle/login#" + code,
		base + "/bundle/login?token=secret#" + code,
		base + "/bundle/login#short",
		base + "/bundle/login#" + strings.Repeat("z", 48),
		base + "/bundle/login#" + code + "/extra",
	} {
		if _, err := publicReaderHandoff(base, map[string]any{"url": link}); err == nil {
			t.Errorf("accepted invalid public handoff %q", link)
		}
	}
	link := base + "/bundle/login#" + code
	out, err := publicReaderHandoff(base, map[string]any{"url": link, "expires": "synthetic-expiry", "code": code, "token": "must-not-disclose"})
	if err != nil || out["signInLink"] != link || out["public"] != true || out["browserLaunchRequested"] != false || out["readerSkipped"] != false {
		t.Fatalf("incorrect public handoff: %v %v", out, err)
	}
	if _, ok := out["token"]; ok {
		t.Fatal("reusable token leaked into public handoff")
	}
}

func TestPublicReaderRequiresRunningServiceAndNeverStartsOne(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("XDG_CACHE_HOME", filepath.Join(dir, "cache"))
	t.Setenv("LOCALAPPDATA", filepath.Join(dir, "cache"))
	t.Setenv("POCKETCONTEXT_URL", "")
	t.Setenv("SSH_CONNECTION", "synthetic ssh session")
	db := filepath.Join(dir, "project", "pocketcontext.db")
	if err := run([]string{"open", "--public", "--db", db}); err == nil || !strings.Contains(err.Error(), "not running") {
		t.Fatalf("public reader did not require running hosting service: %v", err)
	}
	if _, err := os.Stat(filepath.Dir(db)); !os.IsNotExist(err) {
		t.Fatal("public reader created a stopped project")
	}
	p, err := bundle.Resolve(db)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(p.Cache); !os.IsNotExist(err) {
		t.Fatal("public reader created server cache")
	}
	for _, options := range [][]string{
		{"open", "--public", "--skip-reader", "--db", db},
		{"open", "--public", "--url", "http://127.0.0.1:8096"},
	} {
		if err := run(options); err == nil {
			t.Fatalf("accepted invalid public reader options: %q", options)
		}
	}
}
