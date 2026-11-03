package bundle

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestChatHostConfiguration(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		command string
		args    []string
		valid   bool
	}{
		{"", nil, true}, {"", []string{"x"}, false}, {"node", nil, false}, {exe, []string{"a b", "$(literal)"}, true}, {exe, []string{"\x00"}, false}, {t.TempDir(), nil, false},
	} {
		if err := ValidateChatOptions(tc.command, tc.args); (err == nil) != tc.valid {
			t.Errorf("configuration valid=%v: %v", tc.valid, err)
		}
	}
}

func TestChatEnvironmentAndPrivateWorkspace(t *testing.T) {
	t.Setenv("POCKETCONTEXT_TEST_SECRET", "not-for-child")
	t.Setenv("CODEX_CONFIG", `{"sandbox_mode":"danger-full-access"}`)
	t.Setenv("INITIAL_AGENT_MODE", "agent-full-access")
	t.Setenv("PATH", os.Getenv("PATH"))
	for _, v := range chatEnvironment() {
		if strings.HasPrefix(v, "POCKETCONTEXT_TEST_SECRET=") || strings.HasPrefix(v, "CODEX_CONFIG=") || strings.HasPrefix(v, "INITIAL_AGENT_MODE=") {
			t.Fatalf("unsafe inherited variable: %s", strings.SplitN(v, "=", 2)[0])
		}
	}
	root := t.TempDir()
	project := filepath.Join(root, "project")
	cache := filepath.Join(root, "cache")
	if err := os.MkdirAll(project, 0700); err != nil {
		t.Fatal(err)
	}
	p := &Project{DB: filepath.Join(project, "pocketcontext.db"), Dir: project, Cache: cache, Config: Config{Port: DefaultPort}}
	exe, _ := os.Executable()
	m, err := newChatManager(p, ServeOptions{ChatAgent: exe})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	entries, err := os.ReadDir(project)
	if err != nil || len(entries) != 0 {
		t.Fatalf("chat wrote to synced project: %v %v", entries, err)
	}
	data, err := os.ReadFile(filepath.Join(cache, "chat", "skill", "SKILL.md"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "{{DB}}") || !strings.Contains(string(data), p.DB) {
		t.Fatal("skill does not target absolute project path")
	}
	if m.Status().Active != 0 {
		t.Fatal("configuration started an agent before a conversation")
	}
}
