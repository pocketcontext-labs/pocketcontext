package client

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	wikicontextbundle "github.com/pocketcontext/wikicontext-bundle"
	"github.com/pocketcontext/wikicontext-bundle/internal/bundle"
)

// marker identifies skill directories written by this command, which may be replaced.
const marker = ".wikicontext-bundle"

// skillTargets are the user-level skill directories of supported agents. An
// agent is skipped when its configuration directory does not exist.
func skillTargets(home string) map[string][2]string {
	return map[string][2]string{
		"claude-code": {filepath.Join(home, ".claude"), filepath.Join(home, ".claude", "skills", "wikicontext")},
		"codex":       {filepath.Join(home, ".codex"), filepath.Join(home, ".codex", "skills", "wikicontext")},
		"antigravity": {filepath.Join(home, ".gemini"), filepath.Join(home, ".gemini", "antigravity", "skills", "wikicontext")},
	}
}

func installSkills(p *bundle.Project, agent, dir string, pretty bool) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	results := map[string]any{}
	if dir != "" {
		abs, err := filepath.Abs(dir)
		if err != nil {
			return err
		}
		if err := writeSkill(abs, exe, p); err != nil {
			return err
		}
		results["custom"] = abs
		Print(map[string]any{"installed": results, "binary": exe, "db": p.DB}, pretty)
		return nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	targets := skillTargets(home)
	agents := []string{"claude-code", "codex", "antigravity"}
	if agent != "" && agent != "all" {
		if _, ok := targets[agent]; !ok {
			return fail(2, "--agent must be claude-code, codex, antigravity or all")
		}
		agents = []string{agent}
	}
	for _, name := range agents {
		target := targets[name]
		if _, err := os.Stat(target[0]); err != nil && (agent == "" || agent == "all") {
			results[name] = "skipped: " + target[0] + " not found"
			continue
		}
		if err := writeSkill(target[1], exe, p); err != nil {
			results[name] = "failed: " + err.Error()
			continue
		}
		results[name] = target[1]
	}
	Print(map[string]any{"installed": results, "binary": exe, "db": p.DB}, pretty)
	return nil
}

func writeSkill(dir, exe string, p *bundle.Project) error {
	if _, err := os.Stat(dir); err == nil {
		if _, err := os.Stat(filepath.Join(dir, marker)); err != nil {
			return fail(1, "%s already contains another skill; remove it first or pass --dir", dir)
		}
		if err := os.RemoveAll(dir); err != nil {
			return err
		}
	}
	replacer := strings.NewReplacer("{{BINARY}}", exe, "{{DB}}", p.DB, "{{URL}}", p.URL())
	root := "skills/wikicontext"
	err := fs.WalkDir(wikicontextbundle.Skill, root, func(name string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		target := filepath.Join(dir, filepath.FromSlash(strings.TrimPrefix(strings.TrimPrefix(name, root), "/")))
		if d.IsDir() {
			return os.MkdirAll(target, 0755)
		}
		data, err := wikicontextbundle.Skill.ReadFile(name)
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
	return os.WriteFile(filepath.Join(dir, marker), []byte(p.DB+"\n"), 0644)
}
