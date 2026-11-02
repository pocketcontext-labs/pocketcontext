package client

import (
	"github.com/pocketcontext-labs/pocketcontext/internal/profiles"
	"os"
	"path/filepath"
	"testing"
)

func isolateProfiles(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("HOME", dir)
	t.Setenv("AppData", dir)
}
func TestRouterNeverDowngrades(t *testing.T) {
	isolateProfiles(t)
	dir := filepath.Join(t.TempDir(), "router")
	os.MkdirAll(dir, 0700)
	os.WriteFile(filepath.Join(dir, routerMarker), []byte("99\n"), 0600)
	os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("future"), 0600)
	if err := writeRouter(dir); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(dir, "SKILL.md"))
	if string(b) != "future" {
		t.Fatal("downgraded router")
	}
}
func TestRouterPreservesRegisteredLegacySkill(t *testing.T) {
	isolateProfiles(t)
	dir := filepath.Join(t.TempDir(), "global")
	os.MkdirAll(filepath.Join(dir, "references"), 0700)
	db := filepath.Join(t.TempDir(), "pocketcontext.db")
	os.WriteFile(filepath.Join(dir, marker), []byte(db+"\n"), 0600)
	os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("legacy skill"), 0600)
	os.WriteFile(filepath.Join(dir, "references", "schema.md"), []byte("legacy schema"), 0600)
	e := profiles.Entry{ID: profiles.ID("instance"), Instance: "instance", Name: "legacy", DB: db, Binary: filepath.Join(t.TempDir(), "binary"), Version: "0.12.1", Skill: dir}
	if err := profiles.Put(e, false); err != nil {
		t.Fatal(err)
	}
	if err := writeRouter(dir); err != nil {
		t.Fatal(err)
	}
	r, _ := profiles.Read()
	saved, _ := r.Find("legacy")
	if saved.Skill == dir {
		t.Fatal("legacy still points at router")
	}
	b, err := os.ReadFile(filepath.Join(saved.Skill, "references", "schema.md"))
	if err != nil || string(b) != "legacy schema" {
		t.Fatalf("references lost: %q %v", b, err)
	}
}
func TestRouterRefusesUnrelatedSkill(t *testing.T) {
	isolateProfiles(t)
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("unrelated"), 0600)
	if err := writeRouter(dir); err == nil {
		t.Fatal("replaced unrelated skill")
	}
}
