package client

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	assets "github.com/pocketcontext-labs/pocketcontext"
	"github.com/pocketcontext-labs/pocketcontext/internal/bundle"
	"github.com/pocketcontext-labs/pocketcontext/internal/profiles"
)

// marker identifies skill directories written by this command, which may be replaced.
const marker = ".pocketcontext"

// skillTargets are the user-level skill directories of supported agents. An
// agent is skipped when its configuration directory does not exist.
func skillTargets(home string) map[string][2]string {
	return map[string][2]string{
		"claude-code": {filepath.Join(home, ".claude"), filepath.Join(home, ".claude", "skills", "pocketcontext")},
		"codex":       {filepath.Join(home, ".codex"), filepath.Join(home, ".codex", "skills", "pocketcontext")},
		"antigravity": {filepath.Join(home, ".gemini"), filepath.Join(home, ".gemini", "antigravity", "skills", "pocketcontext")},
	}
}

// remoteTemplate replaces SKILL.md for a skill that reaches a forwarded server.
const remoteTemplate = "SKILL.remote.md"

// installSkills writes the skill for the local database db, or, when db is
// empty, the remote variant for the forwarded server at url.
func installSkills(db, url, agent, dir string, pretty bool) error {
	if db != "" {
		p, err := bundle.Resolve(db)
		if err != nil {
			return err
		}
		if _, err := os.Stat(p.DB); err != nil {
			return fail(2, "initialize the project before installing its skill: %v", err)
		}
		registry, err := profiles.Read()
		if err != nil {
			return err
		}
		for _, old := range registry.Profiles {
			if old.DB == p.DB && old.Instance != p.Config.Instance {
				return fail(2, "registered database path now belongs to another project; refusing skill replacement")
			}
		}
		if err := bundle.EnsureRunning(p, bundle.StartOptions{}); err != nil {
			return err
		}
	}

	e, err := newProfile("", db, url, "", dir)
	if err != nil {
		return err
	}
	r, err := profiles.Read()
	if err != nil {
		return err
	}
	for _, old := range r.Profiles {
		if ((e.DB != "" && old.DB == e.DB) || (e.URL != "" && old.URL == e.URL)) && old.Instance != e.Instance {
			return fail(2, "registered endpoint now belongs to another project; refusing skill replacement")
		}
		if old.Instance == e.Instance {
			e.Name = old.Name
			if old.ServerName != e.ServerName {
				return fail(2, "server name changed; use profile update before installing skills")
			}
		}
	}
	// Explicit custom destinations remain supported for legacy compatibility.
	if err := writeSkill(e.Skill, e.Binary, e.DB, e.URL); err != nil {
		return err
	}
	if err := profiles.Put(e, true); err != nil {
		return err
	}
	if dir != "" {
		report := map[string]any{"profile": e, "installed": map[string]string{"custom": e.Skill}, "binary": e.Binary}
		if e.DB != "" {
			report["db"] = e.DB
		} else {
			report["url"] = e.URL
		}
		Print(report, pretty)
		return nil
	}
	return installRouters(agent, pretty)
}

const routerFormat = 1
const routerMarker = ".pocketcontext-router"

func installRouters(agent string, pretty bool) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	targets := skillTargets(home)
	names := []string{"claude-code", "codex", "antigravity"}
	if agent != "" && agent != "all" {
		if _, ok := targets[agent]; !ok {
			return fail(2, "unknown agent %q", agent)
		}
		names = []string{agent}
	}
	results := map[string]string{}
	for _, name := range names {
		target := targets[name]
		if _, err := os.Stat(target[0]); err != nil && (agent == "" || agent == "all") {
			results[name] = "skipped: agent directory not present"
			continue
		}
		if err := writeRouter(target[1]); err != nil {
			return fmt.Errorf("install %s router: %w", name, err)
		}
		results[name] = target[1]
	}
	path, _ := profiles.Path()
	Print(map[string]any{"installed": results, "registry": path, "routerFormat": routerFormat}, pretty)
	return nil
}

// preserveLegacy copies a registered old global skill before its router replaces it.
func preserveLegacy(dir string) error {
	markerBytes, err := os.ReadFile(filepath.Join(dir, marker))
	if err != nil {
		return fail(2, "%s contains an unrelated skill; refusing replacement", dir)
	}
	target := strings.TrimSpace(string(markerBytes))
	r, err := profiles.Read()
	if err != nil {
		return err
	}
	var found *profiles.Entry
	for _, e := range r.Profiles {
		if e.Skill == dir || e.DB == target || e.URL == target {
			copy := e
			found = &copy
			break
		}
	}
	if found != nil && found.Skill != dir {
		return nil
	} // Already preserved or regenerated for this instance.
	if found == nil {
		content, err := os.ReadFile(filepath.Join(dir, "SKILL.md"))
		if err != nil {
			return err
		}
		binary := ""
		for _, line := range strings.Split(string(content), "\n") {
			if strings.HasPrefix(line, "Binary: `") {
				binary = strings.TrimSuffix(strings.TrimPrefix(line, "Binary: `"), "`")
				break
			}
		}
		if binary == "" {
			return fail(2, "register the legacy skill at %s with profile add before replacing it", dir)
		}
		db, url := target, ""
		if strings.HasPrefix(target, "http://") {
			db, url = "", target
		}
		e, err := newProfile("", db, url, binary, dir)
		if err != nil {
			return fmt.Errorf("register legacy skill before replacement: %w", err)
		}
		found = &e
	}
	dst, err := profiles.SkillDir(found.Instance)
	if err != nil {
		return err
	}
	if dst == dir {
		return fail(2, "legacy skill destination equals router directory")
	}
	if _, err := os.Stat(dst); err == nil {
		return fail(2, "legacy skill destination already exists: %s; reconcile its registration first", dst)
	}
	if err := copySkillTree(dir, dst); err != nil {
		return err
	}
	found.Skill = dst
	return profiles.Put(*found, true)
}
func copySkillTree(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("refusing symlink in legacy skill: %s", path)
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0700)
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, b, 0600)
	})
}
func writeRouter(dir string) error {
	if b, err := os.ReadFile(filepath.Join(dir, routerMarker)); err == nil {
		version, err := strconv.Atoi(strings.TrimSpace(string(b)))
		if err != nil {
			return fail(2, "invalid router format marker at %s", dir)
		}
		if version > routerFormat {
			return nil
		}
	} else if _, err := os.Stat(dir); err == nil {
		if err := preserveLegacy(dir); err != nil {
			return err
		}
	}
	content, err := assets.Skill.ReadFile("skills/pocketcontext/ROUTER.md")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	if err := bundle.WriteAtomic(filepath.Join(dir, "SKILL.md"), content, 0600); err != nil {
		return err
	}
	// Do not remove legacy references: preservation happened first, and readers may still hold paths.
	if err := bundle.WriteAtomic(filepath.Join(dir, marker), []byte("router\n"), 0600); err != nil {
		return err
	}
	return bundle.WriteAtomic(filepath.Join(dir, routerMarker), []byte(strconv.Itoa(routerFormat)+"\n"), 0600)
}

// registeredPorts supplies candidates to avoid; binding still checks unrelated applications.
func registeredPorts() (map[int]bool, error) {
	r, err := profiles.Read()
	if err != nil {
		return nil, err
	}
	ports := map[int]bool{}
	for _, e := range r.Profiles {
		if e.DB != "" {
			p, er := bundle.Resolve(e.DB)
			if er == nil {
				ports[p.Config.Port] = true
			}
		} else {
			n, er := strconv.Atoi(port(e.URL))
			if er == nil {
				ports[n] = true
			}
		}
	}
	return ports, nil
}

func writeSkill(dir, exe, db, url string) error {
	if _, err := os.Stat(dir); err == nil {
		if _, err := os.Stat(filepath.Join(dir, marker)); err != nil {
			return fail(1, "%s already contains another skill; remove it first or pass --dir", dir)
		}
		if err := os.RemoveAll(dir); err != nil {
			return err
		}
	}
	replacer := strings.NewReplacer("{{BINARY}}", exe, "{{DB}}", db, "{{URL}}", url)
	root := "skills/pocketcontext"
	err := fs.WalkDir(assets.Skill, root, func(name string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel := strings.TrimPrefix(strings.TrimPrefix(name, root), "/")
		if rel == "ROUTER.md" || rel == remoteTemplate || (db == "" && rel == "SKILL.md") {
			return nil
		}
		target := filepath.Join(dir, filepath.FromSlash(rel))
		if d.IsDir() {
			return os.MkdirAll(target, 0755)
		}
		data, err := assets.Skill.ReadFile(name)
		if err != nil {
			return err
		}
		if strings.HasSuffix(name, ".md") {
			data = []byte(replacer.Replace(string(data)))
		}
		return os.WriteFile(target, data, 0644)
	})
	if err != nil {
		return err
	}
	if db == "" {
		data, err := assets.Skill.ReadFile(root + "/" + remoteTemplate)
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(replacer.Replace(string(data))), 0644); err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(dir, marker), []byte(url+"\n"), 0644)
	}
	return os.WriteFile(filepath.Join(dir, marker), []byte(db+"\n"), 0644)
}
