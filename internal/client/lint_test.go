package client

import (
	"reflect"
	"strings"
	"testing"
)

func page(id, slug, title, body string, citations int) lintPage {
	return lintPage{ID: id, Slug: slug, Kind: "concept", Title: title, Body: body, Citations: citations, Links: map[string]bool{}}
}

func kinds(findings []map[string]any, key string) []string {
	out := []string{}
	for _, f := range findings {
		out = append(out, f["page"].(string)+">"+f[key].(string))
	}
	return out
}

func TestUnlinkedMentions(t *testing.T) {
	linked := page("p4", "linked", "Linked", "Plan mode again.", 2)
	linked.Links["p1"] = true
	pages := []lintPage{
		page("p1", "plan-mode", "Plan mode", "Plan mode is described here.", 2),
		page("p2", "tokenomics", "Tokenomics", "We discuss PLAN  MODE and plan-mode switching.", 2),
		page("p3", "other", "Other", "Planmode, `plan mode` in code, [[plan-mode|plan mode]] and explanation.", 2),
		linked,
		page("p5", "bash", "Bash", "The tokenomics of agents; a bash script.", 2),
	}
	got := kinds(unlinkedMentions(pages), "target")
	want := []string{"tokenomics>plan-mode", "bash>tokenomics"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestMissingPages(t *testing.T) {
	pages := []lintPage{
		page("p1", "a", "A", "Uses **Progressive disclosure** and **x** and [Goose](https://example.com).", 2),
		page("p2", "b", "B", "More **progressive-disclosure:** and [goose](https://example.com/g).", 2),
		page("p3", "c", "C", "Then **Progressive Disclosure** and **Plan mode** and `**Goose**`.", 2),
		page("p4", "plan-mode", "Plan mode", "**plan mode** **Plan mode**", 2),
		page("p5", "d", "D", "**Plan mode** and **this whole sentence is far too long to be a term**", 2),
		page("p6", "e", "E", "**this whole sentence is far too long to be a term** [Goose](https://example.com)", 2),
		page("p7", "f", "F", "**this whole sentence is far too long to be a term**", 2),
	}
	got := missingPages(pages)
	// Record order must not change the reported spelling.
	reversed := make([]lintPage, len(pages))
	for i, p := range pages {
		reversed[len(pages)-1-i] = p
	}
	if again := missingPages(reversed); !reflect.DeepEqual(again, got) {
		t.Fatalf("order changed the findings: %v vs %v", again, got)
	}
	if len(got) != 2 {
		t.Fatalf("got %v", got)
	}
	if got[0]["term"] != "Goose" || !reflect.DeepEqual(got[0]["pages"], []string{"a", "b", "e"}) {
		t.Fatalf("goose: %v", got[0])
	}
	if got[1]["term"] != "Progressive disclosure" || !reflect.DeepEqual(got[1]["pages"], []string{"a", "b", "c"}) {
		t.Fatalf("progressive disclosure: %v", got[1])
	}
}

func TestStubs(t *testing.T) {
	long := strings.Repeat("word ", stubWords)
	entity := page("p4", "acme", "Acme", "Short.", 1)
	entity.Kind, entity.Properties = "entity", 2
	pages := []lintPage{
		page("p1", "short", "Short", "A short page.[^1] `code words are not counted`", 2),
		page("p2", "single", "Single", long+"[^1]", 1),
		page("p3", "full", "Full", long+"[^1][^2]", 2),
		entity,
		page("p5", "code", "Code", "```\n"+long+"\n```\nShort.", 2),
	}
	got := []string{}
	for _, f := range stubs(pages) {
		got = append(got, f["page"].(string))
	}
	if want := []string{"short", "single", "code"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	if words := stubs(pages)[0]["words"]; words != 3 {
		t.Fatalf("short page words = %v", words)
	}
}
