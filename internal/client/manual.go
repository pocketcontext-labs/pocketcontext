package client

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"

	assets "github.com/pocketcontext-labs/pocketcontext"
)

const manualVersion = "0.16.1"

var manualFiles = []string{"README.md", "docs/spaces.md", "docs/import-obsidian.md", "docs/upgrades.md", "docs/reader-setup.md", "docs/releases/0.16.1.md"}
var markdownLink = regexp.MustCompile(`\]\(([^)\s]+)\)`)

func manualContent(name string) ([]byte, error) {
	b, err := assets.ManualSources.ReadFile(name)
	if err != nil {
		return nil, err
	}
	content := string(b)
	if name == "README.md" {
		var lines []string
		skip := false
		for _, line := range strings.Split(content, "\n") {
			if strings.HasPrefix(line, "## ") {
				skip = line == "## Build" || line == "## Develop the reader" || line == "## Layout"
			}
			if !skip {
				lines = append(lines, line)
			}
		}
		content = strings.Join(lines, "\n")
	}
	content = markdownLink.ReplaceAllStringFunc(content, func(link string) string {
		target := link[2 : len(link)-1]
		if strings.Contains(target, ":") || strings.HasPrefix(target, "#") || strings.HasPrefix(target, "/") {
			return link
		}
		file, fragment, _ := strings.Cut(target, "#")
		resolved := path.Clean(path.Join(path.Dir(name), file))
		for _, included := range manualFiles {
			if resolved == included {
				return link
			}
		}
		target = "https://github.com/pocketcontext-labs/pocketcontext/blob/v" + manualVersion + "/" + resolved
		if fragment != "" {
			target += "#" + fragment
		}
		return "](" + target + ")"
	})
	title, _ := json.Marshal("PocketContext " + manualVersion + " manual: " + name)
	return []byte("---\ntitle: " + string(title) + "\n---\n\n" + content), nil
}

func exportManual(a *args, pretty bool) error {
	if len(a.pos) != 0 || a.flags["out"] == "" || a.has("db") || a.has("url") {
		return fail(2, "usage: pocketcontext manual --out NEW_DIRECTORY")
	}
	out, err := filepath.Abs(a.flags["out"])
	if err != nil {
		return err
	}
	if err = os.Mkdir(out, 0700); err != nil {
		return fmt.Errorf("manual destination must be a new directory: %w", err)
	}
	complete := false
	defer func() {
		if !complete {
			_ = os.RemoveAll(out)
		}
	}()
	hashes := map[string]string{}
	for _, name := range manualFiles {
		content, err := manualContent(name)
		if err != nil {
			return err
		}
		dest := filepath.Join(out, filepath.FromSlash(name))
		if err = os.MkdirAll(filepath.Dir(dest), 0700); err != nil {
			return err
		}
		if err = os.WriteFile(dest, content, 0600); err != nil {
			return err
		}
		sum := sha256.Sum256(content)
		hashes[name] = hex.EncodeToString(sum[:])
	}
	manifest, _ := json.MarshalIndent(map[string]any{"version": manualVersion, "files": hashes}, "", "  ")
	if err = os.WriteFile(filepath.Join(out, "manifest.json"), append(manifest, '\n'), 0600); err != nil {
		return err
	}
	complete = true
	Print(map[string]any{"directory": out, "version": manualVersion, "files": hashes}, pretty)
	return nil
}
