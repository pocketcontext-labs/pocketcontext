package client

import (
	"fmt"
	"math/rand"
	"strings"
	"testing"
)

func TestManifestMatchesPythonClient(t *testing.T) {
	// Computed by the retired Python client: json.dumps(passages, sort_keys=True).
	text := "# Coffee policy\n\nThe office espresso machine is descaled every Friday by the facilities team. Café crème costs €2 — ünïcode ✓ 😀.\n"
	want := `{"passages": 1, "sha256": "6848d78490cc7739f385b32260a01f0ded44a3d04b5a0a9192f2c17aa01d63e1"}`
	if got := manifest(chunksV1(text, "document")); got != want {
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

func TestChunksV1(t *testing.T) {
	text := strings.Repeat("é", chunkRunes) + strings.Repeat(" ", chunkRunes) + "tail"
	got := chunksV1(text, "document")
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

func locators(ps []passage) []string {
	out := make([]string, len(ps))
	for i, p := range ps {
		out[i] = p.Locator
	}
	return out
}

func para(word string, n int) string { return strings.TrimSpace(strings.Repeat(word+" ", n)) }

func checkBounds(t *testing.T, ps []passage) {
	t.Helper()
	for _, p := range ps {
		if n := runes(p.Body); n > passageRunes || n == 0 || blank(p.Body) {
			t.Fatalf("passage %q has %d characters", p.Locator, n)
		}
		if runes(p.Locator) > locatorRunes {
			t.Fatalf("locator too long: %d", runes(p.Locator))
		}
	}
}

func TestChunksHeadings(t *testing.T) {
	text := "Intro line.\n\n# Title\n\nLead.\n\n## Transcript\n\n### Level 1 ##\n\nOne.\n\n```\n# not a heading\n```\n\n### Level 2\nTwo.\n\n## Notes\nThree.\n"
	got := chunks(text, true)
	// Everything under # Title fits one passage, so its subsections merge.
	want := []string{"document; line 1", "# Title; lines 3-21"}
	if fmt.Sprint(locators(got)) != fmt.Sprint(want) {
		t.Fatalf("locators %q, want %q", locators(got), want)
	}
	if !strings.Contains(got[1].Body, "# not a heading") || !strings.HasPrefix(got[1].Body, "# Title") {
		t.Fatalf("body %q", got[1].Body)
	}
}

func TestChunksSiblingSections(t *testing.T) {
	big := para("word", 500) // about 2,500 characters
	text := "## Transcript\n\n### Level 1\n\n" + big + "\n\n### Level 4 - Bash Tool + Whitelist\n\n" + big + "\n"
	got := chunks(text, true)
	want := []string{"## Transcript > ### Level 1; lines 1-5", "## Transcript > ### Level 4 - Bash Tool + Whitelist; lines 7-9"}
	if fmt.Sprint(locators(got)) != fmt.Sprint(want) {
		t.Fatalf("locators %q, want %q", locators(got), want)
	}
	checkBounds(t, got)
}

func TestChunksParagraphsAndOversized(t *testing.T) {
	var b strings.Builder
	b.WriteString("# Big\n")
	for i := 0; i < 12; i++ {
		fmt.Fprintf(&b, "\n%s\n", para(fmt.Sprintf("p%02d", i), 300)) // about 1,200 characters each
	}
	got := chunks(b.String(), true)
	checkBounds(t, got)
	if len(got) < 4 || len(got) > 5 {
		t.Fatalf("got %d passages, want 4-5: %q", len(got), locators(got))
	}
	for _, p := range got {
		if !strings.HasPrefix(p.Locator, "# Big; lines ") {
			t.Fatalf("locator %q", p.Locator)
		}
	}
	if got[0].Locator != "# Big; lines 1-7" {
		t.Fatalf("first locator %q", got[0].Locator)
	}
	// Every non-blank line lands in exactly one passage.
	joined := ""
	for _, p := range got {
		joined += p.Body + "\n"
	}
	if strings.Count(joined, "p11 ") != 299 || strings.Count(joined, "# Big") != 1 {
		t.Fatal("text lost or duplicated")
	}
}

func TestChunksLongLine(t *testing.T) {
	text := "# Talk\n" + para("abcdefghi", 1000) + "\n"
	got := chunks(text, true)
	checkBounds(t, got)
	want := []string{"# Talk; lines 1-2, characters 1-3990 of line 2", "# Talk; line 2, characters 3991-7990", "# Talk; line 2, characters 7991-9999"}
	if fmt.Sprint(locators(got)) != fmt.Sprint(want) {
		t.Fatalf("locators %q, want %q", locators(got), want)
	}
	if got[0].Body+got[1].Body+got[2].Body != "# Talk\n"+para("abcdefghi", 1000) {
		t.Fatal("hard cut lost text")
	}
	if !strings.HasSuffix(got[0].Body, " ") || !strings.HasSuffix(got[1].Body, " ") {
		t.Fatal("cut not at whitespace")
	}
	// Without whitespace the cut is exact.
	got = chunks(strings.Repeat("x", 9000), false)
	if fmt.Sprint(locators(got)) != fmt.Sprint([]string{"document; line 1, characters 1-4000", "document; line 1, characters 4001-8000", "document; line 1, characters 8001-9000"}) {
		t.Fatalf("locators %q", locators(got))
	}
}

func TestChunksFrontMatter(t *testing.T) {
	text := "---\ntitle: \"Agentic: Coding\"\npublished: 2025-06-16\nauthor:\n  - Dan\n  - Ann\ntags: [a, b]\n---\n# Episode\n\nBody.\n"
	got := chunks(text, true)
	want := []string{"front matter; lines 1-8", "# Episode; lines 9-11"}
	if fmt.Sprint(locators(got)) != fmt.Sprint(want) {
		t.Fatalf("locators %q, want %q", locators(got), want)
	}
	fm := frontMatter(splitLines(text))
	if fm["title"] != "Agentic: Coding" || fm["published"] != "2025-06-16" || fm["author"] != "" || fm["tags"] != "" {
		t.Fatalf("front matter %q", fm)
	}
	// Plain text and thematic breaks are not front matter.
	if got := chunks(text, false); len(got) != 1 || got[0].Locator != "document; lines 1-11" {
		t.Fatalf("plain text locators %q", locators(got))
	}
	if frontMatterEnd(splitLines("---\nJust a rule.\n---\n")) != 0 {
		t.Fatal("thematic break read as front matter")
	}
}

func TestScalar(t *testing.T) {
	cases := map[string]string{
		` 2025-06-16 # comment`: "2025-06-16",
		`'It''s here'`:          "It's here",
		`"a \"b\" c"`:           `a "b" c`,
		`[x, y]`:                "",
		`|`:                     "",
		`"unterminated`:         "",
		`plain: colon`:          "plain: colon",
	}
	for in, want := range cases {
		if got := scalar(in); got != want {
			t.Errorf("scalar(%q) = %q, want %q", in, got, want)
		}
	}
	fm := frontMatter(splitLines("---\ndate: 2024-01-02\nTitle: First\ntitle: Second\n---\n"))
	if fm["date"] != "2024-01-02" || fm["title"] != "First" {
		t.Fatalf("front matter %q", fm)
	}
}

func TestChunksCRLF(t *testing.T) {
	lf := "---\ntitle: T\n---\n# A\n\nOne.\n\n## B\nTwo.\n"
	crlf := strings.ReplaceAll(lf, "\n", "\r\n")
	a, b := chunks(lf, true), chunks(crlf, true)
	if fmt.Sprint(a) != fmt.Sprint(b) || strings.Contains(fmt.Sprint(b), "\r") {
		t.Fatalf("CRLF %q differs from LF %q", b, a)
	}
	if frontMatter(splitLines(crlf))["title"] != "T" {
		t.Fatal("CRLF front matter")
	}
}

func TestChunksNoHeadings(t *testing.T) {
	text := "\n\nFirst paragraph.\n\nSecond paragraph.\n\n\n"
	got := chunks(text, true)
	if len(got) != 1 || got[0].Locator != "document; lines 3-5" || got[0].Body != "First paragraph.\n\nSecond paragraph." {
		t.Fatalf("got %q", got)
	}
	if len(chunks(" \n\t\n", true)) != 0 {
		t.Fatal("whitespace produced passages")
	}
	// Non-Markdown text ignores # lines.
	if got := chunks("# comment\nvalue\n", false); len(got) != 1 || got[0].Locator != "document; lines 1-2" {
		t.Fatalf("plain %q", locators(got))
	}
}

func TestChunksEmptySections(t *testing.T) {
	big := para("word", 700) // about 3,500 characters: Full does not fit beside Other
	text := "## Transcript\n\n### Empty\n\n### Full\n" + big + "\n### Other\n" + big + "\n## Trailing\n"
	got := chunks(text, true)
	want := []string{"## Transcript > ### Full; lines 1-6", "## Transcript > ### Other; lines 7-8", "## Trailing; line 9"}
	if fmt.Sprint(locators(got)) != fmt.Sprint(want) {
		t.Fatalf("locators %q, want %q", locators(got), want)
	}
	if !strings.HasPrefix(got[0].Body, "## Transcript\n\n### Empty\n\n### Full\n") {
		t.Fatalf("empty headings not carried: %q", got[0].Body[:40])
	}
}

func TestLocatorFits(t *testing.T) {
	var path []string
	for i := 0; i < 6; i++ {
		path = append(path, strings.Repeat("#", i+1)+" "+strings.Repeat("x", 150))
	}
	loc := locator(path, "", "lines 1-2")
	if runes(loc) > locatorRunes || !strings.HasPrefix(loc, "… > ") || !strings.HasSuffix(loc, "; lines 1-2") {
		t.Fatalf("locator %q (%d)", loc, runes(loc))
	}
	loc = locator([]string{"# " + strings.Repeat("y", 600)}, "", "lines 1-2")
	if runes(loc) > locatorRunes || !strings.HasSuffix(loc, "…; lines 1-2") {
		t.Fatalf("locator %q (%d)", loc, runes(loc))
	}
}

func TestSplitFor(t *testing.T) {
	text := "# A\n\nBody.\n"
	if got := splitFor(processorV1, text, true); len(got) != 1 || got[0].Locator != "document; characters 1-11" {
		t.Fatalf("v1 %q", locators(got))
	}
	if got := splitFor(processor, text, true); len(got) != 1 || got[0].Locator != "# A; lines 1-3" {
		t.Fatalf("v2 %q", locators(got))
	}
}

func TestChunksInvariants(t *testing.T) {
	squash := func(s string) string { return strings.Join(strings.FieldsFunc(s, pythonSpace), "") }
	rng := rand.New(rand.NewSource(1))
	pieces := []string{"# H1", "## H2", "### H3", "#### H4", "", "", "```", "~~~", "---", "title: x",
		"short line", para("mid", 200), para("long", 1500), strings.Repeat("z", 9000), "  ", "\r"}
	for round := 0; round < 300; round++ {
		var b strings.Builder
		if rng.Intn(3) == 0 {
			b.WriteString("---\ntitle: T\n---\n")
		}
		for i := rng.Intn(80); i > 0; i-- {
			b.WriteString(pieces[rng.Intn(len(pieces))] + "\n")
		}
		text := b.String()
		for _, md := range []bool{true, false} {
			got := chunks(text, md)
			checkBounds(t, got)
			joined := ""
			for _, p := range got {
				joined += p.Body
			}
			if squash(joined) != squash(text) {
				t.Fatalf("round %d markdown=%v: text lost, duplicated or reordered", round, md)
			}
		}
	}
}
