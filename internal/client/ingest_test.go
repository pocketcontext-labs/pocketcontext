package client

import (
	"strings"
	"testing"
)

func TestManifestMatchesPythonClient(t *testing.T) {
	// Computed by the retired Python client: json.dumps(passages, sort_keys=True).
	text := "# Coffee policy\n\nThe office espresso machine is descaled every Friday by the facilities team. Café crème costs €2 — ünïcode ✓ 😀.\n"
	want := `{"passages": 1, "sha256": "6848d78490cc7739f385b32260a01f0ded44a3d04b5a0a9192f2c17aa01d63e1"}`
	if got := manifest(chunks(text, "document")); got != want {
		t.Fatalf("manifest = %s, want %s", got, want)
	}
}

func TestPyString(t *testing.T) {
	cases := map[string]string{
		"a\"b\\c":      `"a\"b\\c"`,
		"\n\t\x01\x7f": `"\n\t\u0001` + "\x7f" + `"`,
		"é€😀":          `"\u00e9\u20ac\ud83d\ude00"`,
	}
	for in, want := range cases {
		if got := pyString(in); got != want {
			t.Errorf("pyString(%q) = %s, want %s", in, got, want)
		}
	}
}

func TestChunks(t *testing.T) {
	text := strings.Repeat("é", chunkRunes) + strings.Repeat(" ", chunkRunes) + "tail"
	got := chunks(text, "document")
	if len(got) != 2 {
		t.Fatalf("got %d passages, want 2 (whitespace-only chunk skipped)", len(got))
	}
	if got[0].Locator != "document; characters 1-24000" || got[1].Locator != "document; characters 48001-48004" {
		t.Fatalf("locators %q, %q", got[0].Locator, got[1].Locator)
	}
}

func TestParseArgsInterspersed(t *testing.T) {
	a, err := parseArgs([]string{"note.md", "--title", "T", "--pretty", "--db=x.db"}, []string{"title"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(a.pos) != 1 || a.flags["title"] != "T" || a.flags["db"] != "x.db" || !a.bools["pretty"] {
		t.Fatalf("parsed %+v", a)
	}
	if _, err := parseArgs([]string{"--bogus"}, nil, nil); err == nil {
		t.Fatal("unknown option accepted")
	}
}

func TestNewID(t *testing.T) {
	for i := 0; i < 100; i++ {
		if id := NewID(); !idPattern.MatchString(id) {
			t.Fatalf("invalid id %q", id)
		}
	}
}
