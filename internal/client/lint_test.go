package client

import (
	"fmt"
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
	entity.Kind, entity.Catalog = "entity", "organization"
	// Properties without a catalog type do not make an entity a catalog record.
	untyped := page("p6", "widget", "Widget", "Short.", 1)
	untyped.Kind = "entity"
	unknown := page("p7", "thing", "Thing", "Short.", 1)
	unknown.Kind, unknown.Catalog = "entity", "entity_type"
	typedConcept := page("p8", "typed", "Typed", "Short.", 1)
	typedConcept.Catalog = "product"
	pages := []lintPage{
		page("p1", "short", "Short", "A short page.[^1] `code words are not counted`", 2),
		page("p2", "single", "Single", long+"[^1]", 1),
		page("p3", "full", "Full", long+"[^1][^2]", 2),
		entity,
		page("p5", "code", "Code", "```\n"+long+"\n```\nShort.", 2),
		untyped, unknown, typedConcept,
	}
	got := []string{}
	for _, f := range stubs(pages) {
		got = append(got, f["page"].(string))
	}
	if want := []string{"short", "single", "code", "widget", "thing", "typed"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	if words := stubs(pages)[0]["words"]; words != 3 {
		t.Fatalf("short page words = %v", words)
	}
}

func TestTitleWords(t *testing.T) {
	for in, want := range map[string]string{
		"Cursor (Anysphere)":           "cursor anysphere",
		"Zero-touch engineering (ZTE)": "zero touch engineering zte",
		"ZTE: zero-touch engineering":  "zte zero touch engineering",
		"GPT-5.5 «preview», O'Reilly":  "gpt 5 5 preview o reilly",
		"  ":                           "",
	} {
		if got := titleWords(in); got != want {
			t.Errorf("titleWords(%q) = %q, want %q", in, got, want)
		}
	}
}

// A capitalized name counts as part of a title when it is one of the title's
// words once punctuation is removed; parts of words still do not count.
func TestMissingPagesTitlePunctuation(t *testing.T) {
	filler := "The team reviewed the agent output with care. "
	body := filler + "They compared it with Anysphere and with ZTE in practice, and Cursorial too. Then Engineer Smith left. "
	pages := []lintPage{
		page("p1", "cursor", "Cursor (Anysphere)", filler, 2),
		page("p2", "zte", "Zero-touch engineering (ZTE)", filler, 2),
		page("p3", "zte-alt", "ZTE: zero-touch engineering", filler, 2),
		page("p4", "a", "A", body, 2),
		page("p5", "b", "B", body, 2),
		page("p6", "c", "C", body, 2),
	}
	got := missingPages(pages)
	terms := []string{}
	for _, f := range got {
		terms = append(terms, f["term"].(string))
	}
	if want := []string{"Cursorial", "Engineer Smith"}; !reflect.DeepEqual(terms, want) {
		t.Fatalf("got %v, want %v", terms, want)
	}
	reversed := make([]lintPage, len(pages))
	for i, p := range pages {
		reversed[len(pages)-1-i] = p
	}
	if again := missingPages(reversed); !reflect.DeepEqual(again, got) {
		t.Fatalf("order changed the findings: %v vs %v", again, got)
	}
}

func TestCapitalizedNames(t *testing.T) {
	lower := map[string]bool{"using": true, "agent": true, "review": true}
	text := "Mario Zechner wrote it. The Stripe Minions merged it on Monday, and Cloudflare's review factory checked it.\n" +
		"Using Claude Code, we ran OpenCode and GPT-5.5 in March. However, Cloudflare said no. I think the Agent works.\n" +
		"Researchers at Project Glasswing agreed. AWS and the CEO met Andrej Karpathy (Karpathy). iPhone owners: Fine.\n" +
		"Press Shift+Tab to use the APIs and CLIs of Next.js."
	got := capitalizedNames(text, lower)
	want := []string{"Mario Zechner", "Stripe Minions", "Cloudflare", "Claude Code", "OpenCode", "GPT-5.5", "Cloudflare",
		"Project Glasswing", "Andrej Karpathy", "Karpathy", "iPhone", "Next.js"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestMissingPagesCapitalizedNames(t *testing.T) {
	filler := "The team reviewed the agent output with care. "
	pages := []lintPage{
		page("p1", "review-factories", "Review factories",
			"# Cloudflare Notes\n\n"+filler+"Their review factory runs at Cloudflare, and Stripe Minions do the same.[^1] "+
				"Mario Zechner described it on Monday. See [[andrej-karpathy|Andrej Karpathy]] and `Bowser Stack` in code. "+
				"The agent uses GPT-5.5 for drafts.", 2),
		page("p2", "agent-loops", "Agent loops",
			filler+"Their verifier agent from Cloudflare's lab, like Stripe Minions, retries in January. Karpathy agrees with Mario Zechner. "+
				"Teams use GPT-5.5 daily. Bowser stays a side note at https://Bowser.example.com/Bowser.", 2),
		page("p3", "coding-agents", "Coding agents",
			filler+"OpenCode came from Mario Zechner; the stripe minions [Stripe Minions](https://example.com) ship daily. "+
				"Engineers at Cloudflare built one too, as did Andrej Karpathy. Bowser was tried.\n\n```\nBowser Stack\n```", 2),
		page("p4", "andrej-karpathy", "Andrej Karpathy",
			filler+"He uses GPT-5.5 and Claude in January. Claude helped. Thursday matters.", 2),
		page("p5", "notes", "Notes", filler+"Claude summarized it in January. OpenCode and Bowser were mentioned.", 2),
	}
	got := missingPages(pages)
	reversed := make([]lintPage, len(pages))
	for i, p := range pages {
		reversed[len(pages)-1-i] = p
	}
	if again := missingPages(reversed); !reflect.DeepEqual(again, got) {
		t.Fatalf("order changed the findings: %v vs %v", again, got)
	}
	terms := map[string][]string{}
	for _, f := range got {
		terms[f["term"].(string)] = f["pages"].([]string)
	}
	want := map[string][]string{
		"Cloudflare":     {"agent-loops", "coding-agents", "review-factories"},
		"GPT-5.5":        {"agent-loops", "andrej-karpathy", "review-factories"},
		"Mario Zechner":  {"agent-loops", "coding-agents", "review-factories"},
		"Stripe Minions": {"agent-loops", "coding-agents", "review-factories"},
	}
	// Not reported: Karpathy (part of a page title), January and Monday
	// (stopwords), Claude (sentence-initial on two of three pages), OpenCode
	// (two pages), Bowser (sentence-initial, in a URL or in code), the heading
	// "Cloudflare Notes", Andrej Karpathy (a page; also a [[page]] link) and
	// lowercase prose. Stripe Minions counts once on p3 (link text and prose).
	if !reflect.DeepEqual(terms, want) {
		t.Fatalf("got %v, want %v", terms, want)
	}
}

func TestMissingPagesSkipsFieldLabels(t *testing.T) {
	var pages []lintPage
	for i, slug := range []string{"a", "b", "c"} {
		body := "**Video:** a recording.\n- **Status:** done\n1. **Owner:** me\nThen the **Glass wing:** review."
		pages = append(pages, page(fmt.Sprintf("p%d", i), slug, strings.ToUpper(slug), body, 2))
	}
	got := missingPages(pages)
	if len(got) != 1 || got[0]["term"] != "Glass wing" {
		t.Fatalf("field labels must be skipped and a mid-sentence term kept without its colon: %v", got)
	}
}
