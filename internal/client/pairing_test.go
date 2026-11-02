package client

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestInvitationValidationAndPrivateStorage(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CACHE_HOME", dir)
	t.Setenv("LOCALAPPDATA", dir)
	t.Setenv("HOME", dir)
	c := connection{Format: 1, Address: validAddress(), URL: "http://127.0.0.1:18096", Instance: "instance-a"}
	if e := saveConnection(c); e != nil {
		t.Fatal(e)
	}
	got, e := loadConnection(c.URL)
	if e != nil || got != c {
		t.Fatalf("saved connection: %v", e)
	}
	if _, e := loadConnection("http://127.0.0.1:18097"); e == nil {
		t.Fatal("reused another URL")
	}
	in := invitation{c, "secret-code", time.Now().Add(time.Minute)}
	b, _ := json.Marshal(in)
	file := filepath.Join(dir, "invite.json")
	if e := privateNewFile(file, b); e != nil {
		t.Fatal(e)
	}
	if e := privateNewFile(file, b); e == nil {
		t.Fatal("overwrote invitation")
	}
	if _, e := readInvitation(file); e != nil {
		t.Fatal(e)
	}
	in.Expires = time.Now().Add(-time.Minute)
	b, _ = json.Marshal(in)
	os.WriteFile(file, b, 0600)
	if _, e := readInvitation(file); e == nil || !strings.Contains(e.Error(), "expired") {
		t.Fatalf("expiry: %v", e)
	}
	os.WriteFile(file, []byte(`{"address":"SECRETbroken","code":"SECRETcode"}`), 0600)
	if _, e := readInvitation(file); e == nil || strings.Contains(e.Error(), "SECRET") {
		t.Fatalf("leaked invitation: %v", e)
	}
}

func TestInviteRefusesProjectDestination(t *testing.T) {
	root := t.TempDir()
	err := run([]string{"tunnel", "invite", "--db", filepath.Join(root, "pocketcontext.db"), "--out", filepath.Join(root, "invitation.json")})
	if err == nil || !strings.Contains(err.Error(), "outside the project") {
		t.Fatalf("project secret destination: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "invitation.json")); !os.IsNotExist(err) {
		t.Fatal("invitation written in project")
	}
}
