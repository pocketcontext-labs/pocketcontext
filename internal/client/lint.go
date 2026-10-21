package client

import (
	"regexp"
	"sort"
	"strings"
	"unicode"
)

// Text checks of `lint` on published pages. They are pure functions of the
// page text so that they can be tested without a server. All of them are
// hints for an editor, not integrity errors: publication never depends on them.

// lintPage is what the text checks need of one published, unarchived page.
type lintPage struct {
	ID, Slug, Kind, Title, Body string
	Citations                   int             // distinct citation markers
	Properties                  int             // number of properties
	Links                       map[string]bool // target page IDs: page_links and relationship properties
}

// stubWords is the body length below which a page counts as a stub.
const stubWords = 80

// missingPageMin is the number of pages a term must recur on to ask for its own page.
const missingPageMin = 3

var (
	fencedCode   = regexp.MustCompile("(?s)(^|\n)[ \t]*(```|~~~).*?(\n[ \t]*(```|~~~)[^\n]*|$)")
	codeSpan     = regexp.MustCompile("`+[^`\n]*`+")
	pageLinkText = regexp.MustCompile(`\[\[[^\]\n]+\]\]`)
	footnoteMark = regexp.MustCompile(`\[\^[^\]\n]*\]`)
	mdLink       = regexp.MustCompile(`!?\[([^\]\n]+)\]\(([^)\n]*)\)`)
	boldTerm     = regexp.MustCompile(`\*\*([^*\n]+)\*\*|__([^_\n]+)__`)
)

// withoutCode removes fenced code blocks and inline code spans.
func withoutCode(body string) string {
	return codeSpan.ReplaceAllString(fencedCode.ReplaceAllString(body, "\n"), " ")
}

// proseText is the body as prose: no code, no footnote markers, no [[page]] links
// (their text is already a link) and Markdown links reduced to their text.
func proseText(body string) string {
	text := footnoteMark.ReplaceAllString(withoutCode(body), "")
	text = pageLinkText.ReplaceAllString(text, " ")
	return mdLink.ReplaceAllStringFunc(text, func(m string) string {
		if strings.HasPrefix(m, "!") {
			return " "
		}
		return mdLink.FindStringSubmatch(m)[1]
	})
}

// countWords counts whitespace-separated tokens that contain a letter or digit.
func countWords(text string) int {
	n := 0
	for _, f := range strings.Fields(text) {
		if strings.IndexFunc(f, func(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) }) >= 0 {
			n++
		}
	}
	return n
}

// normalTerm lowercases a term and collapses whitespace, hyphens and underscores.
func normalTerm(s string) string {
	s = strings.Map(func(r rune) rune {
		if r == '-' || r == '_' {
			return ' '
		}
		return unicode.ToLower(r)
	}, s)
	return strings.Join(strings.Fields(strings.Trim(s, " \t.,;:!?\"'()")), " ")
}

// mentionTerm reports whether a page title or slug is specific enough to look
// for in other pages: at least two words, or one word of six or more characters.
func mentionTerm(term string) bool {
	words := strings.Fields(term)
	return len(words) >= 2 || (len(words) == 1 && len([]rune(words[0])) >= 6)
}

// termPattern matches a normalized term as whole words, case-insensitively,
// with any run of spaces or hyphens between its words.
func termPattern(term string) *regexp.Regexp {
	words := strings.Fields(term)
	for i, w := range words {
		words[i] = regexp.QuoteMeta(w)
	}
	return regexp.MustCompile(`(?i)(?:^|[^\p{L}\p{N}_])` + strings.Join(words, `[\s\-]+`) + `(?:$|[^\p{L}\p{N}_])`)
}

// unlinkedMentions finds pages whose prose names another published page (by
// title or by the words of its slug) without linking to it. Text inside code,
// [[page]] links and footnote markers is ignored; a page is never reported for
// mentioning itself. One finding per page and target.
func unlinkedMentions(pages []lintPage) []map[string]any {
	type target struct {
		page     lintPage
		patterns []*regexp.Regexp
		terms    []string
	}
	targets := []target{}
	for _, p := range pages {
		t := target{page: p}
		seen := map[string]bool{}
		for _, term := range []string{normalTerm(p.Title), normalTerm(p.Slug)} {
			if term != "" && !seen[term] && mentionTerm(term) {
				seen[term] = true
				t.terms = append(t.terms, term)
				t.patterns = append(t.patterns, termPattern(term))
			}
		}
		if len(t.terms) > 0 {
			targets = append(targets, t)
		}
	}
	findings := []map[string]any{}
	for _, p := range pages {
		text := proseText(p.Body)
		for _, t := range targets {
			if t.page.ID == p.ID || p.Links[t.page.ID] {
				continue
			}
			for i, pattern := range t.patterns {
				if pattern.MatchString(text) {
					findings = append(findings, map[string]any{"page": p.Slug, "kind": "unlinked-mention", "target": t.page.Slug, "term": t.terms[i]})
					break
				}
			}
		}
	}
	return findings
}

// candidateTerm reports whether emphasized or linked text looks like a name
// rather than a sentence: 3-60 characters, at most five words, not only digits.
func candidateTerm(term string) bool {
	n := len([]rune(term))
	return n >= 3 && n <= 60 && len(strings.Fields(term)) <= 5 &&
		strings.IndexFunc(term, unicode.IsLetter) >= 0
}

// missingPages finds terms written in **bold** (or __bold__) or as the text
// of a Markdown link [term](url) on at least three pages when no published
// page has that term as its title or slug. Terms compare case-insensitively
// with hyphens and spaces equal; code is ignored.
func missingPages(pages []lintPage) []map[string]any {
	existing := map[string]bool{}
	for _, p := range pages {
		existing[normalTerm(p.Title)], existing[normalTerm(p.Slug)] = true, true
	}
	on := map[string]map[string]bool{}
	display := map[string]string{}
	for _, p := range pages {
		text := footnoteMark.ReplaceAllString(withoutCode(p.Body), "")
		var raw []string
		for _, m := range boldTerm.FindAllStringSubmatch(text, -1) {
			raw = append(raw, m[1]+m[2])
		}
		for _, m := range mdLink.FindAllStringSubmatch(text, -1) {
			if !strings.HasPrefix(m[0], "!") {
				raw = append(raw, m[1])
			}
		}
		for _, r := range raw {
			term := normalTerm(r)
			if !candidateTerm(term) || existing[term] {
				continue
			}
			if on[term] == nil {
				on[term], display[term] = map[string]bool{}, strings.TrimSpace(r)
			}
			on[term][p.Slug] = true
		}
	}
	terms := make([]string, 0, len(on))
	for term, slugs := range on {
		if len(slugs) >= missingPageMin {
			terms = append(terms, term)
		}
	}
	sort.Strings(terms)
	findings := []map[string]any{}
	for _, term := range terms {
		slugs := make([]string, 0, len(on[term]))
		for s := range on[term] {
			slugs = append(slugs, s)
		}
		sort.Strings(slugs)
		findings = append(findings, map[string]any{"kind": "missing-page", "term": display[term], "pages": slugs})
	}
	return findings
}

// stubs finds pages with fewer than stubWords words of prose or exactly one
// citation. Entity pages that carry properties are catalog records, not prose,
// and are never stubs; pages without citations are reported as no-citations.
func stubs(pages []lintPage) []map[string]any {
	findings := []map[string]any{}
	for _, p := range pages {
		if p.Kind == "entity" && p.Properties > 0 {
			continue
		}
		if words := countWords(proseText(p.Body)); words < stubWords || p.Citations == 1 {
			findings = append(findings, map[string]any{"page": p.Slug, "kind": "stub", "words": words, "citations": p.Citations})
		}
	}
	return findings
}
