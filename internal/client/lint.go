package client

import (
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Text checks of `lint` on published pages. They are pure functions of the
// page text so that they can be tested without a server. All of them are
// hints for an editor, not integrity errors: publication never depends on them.

// lintPage is what the text checks need of one published, unarchived page.
type lintPage struct {
	ID, Slug, Kind, Title, Body string
	Catalog                     string          // catalog_type, when it is a supported catalog type
	Citations                   int             // distinct citation markers
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
	listPrefix   = regexp.MustCompile(`^\s*(?:[-*+]|\d+[.)])?\s*$`)
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

var (
	proseHeading = regexp.MustCompile(`(?m)^[ \t]{0,3}#{1,6}(?:[ \t][^\n]*)?$`)
	bareURL      = regexp.MustCompile(`(?i)(?:\b[a-z][a-z0-9+.\-]*://|\bwww\.)[^\s<>()\[\]]+`)
	nameToken    = regexp.MustCompile(`[\p{L}\p{N}](?:[\p{L}\p{N}.'’\-]*[\p{L}\p{N}])?`)
)

// nameStopwords are capitalized words that never name a thing on their own:
// pronouns, determiners, sentence connectives, days, months, nationalities and
// common abbreviations (also in the plural: APIs). They also end a run of
// capitalized words.
var nameStopwords = func() map[string]bool {
	words := map[string]bool{}
	for _, w := range strings.Fields(`
		i i'm i've i'd i'll me my mine we us our ours you your yours he him his she her hers it its they them their theirs
		a an the this that these those there here what which who whom whose why how when where whether
		and or but nor so yet if then than because although though while unless until since once also too
		in on at by for from of to with without within into onto over under after before during between
		through across about above below against among around as like unlike via per
		all any both each every few many more most much no none not only other several some such
		is are was were be been being am do does did done has have had can could may might must shall should will would
		yes ok okay however therefore thus hence meanwhile instead still even just now later next last first second third
		finally overall similarly notably moreover furthermore today yesterday tomorrow
		monday tuesday wednesday thursday friday saturday sunday
		january february march april may june july august september october november december
		american british english european french german italian japanese chinese indian spanish
		mr mrs ms dr st jr sr
		ai api apis cli cpu gpu ui ux url urls id ids json html css http https sql sdk llm llms os pdf csv faq
		ceo cto cfo coo vp hr pr prs qa usd eur utc tbd todo etc
		note see figure table section chapter part step page
		shift ctrl alt cmd esc tab`) {
		words[w] = true
	}
	return words
}()

// stopword reports whether a word is in nameStopwords, or is the plural of an
// abbreviation there (CLIs, UIs).
func stopword(word string) bool {
	l := strings.ToLower(word)
	if nameStopwords[l] {
		return true
	}
	stem := strings.TrimSuffix(word, "s")
	return stem != word && strings.ToUpper(stem) == stem && nameStopwords[strings.ToLower(stem)]
}

// nameText is the prose that names are read from: no headings, code,
// footnote markers, [[page]] links or bare URLs. Bold and Markdown link text
// are terms of their own and become a comma, which ends a run of names
// without opening a sentence.
func nameText(body string) string {
	text := footnoteMark.ReplaceAllString(withoutCode(proseHeading.ReplaceAllString(body, "")), "")
	for _, re := range []*regexp.Regexp{pageLinkText, mdLink, boldTerm, bareURL} {
		text = re.ReplaceAllString(text, " , ")
	}
	return text
}

// productLike reports whether a word's capitals cannot come from its position
// in a sentence: inner capitals beside small letters (OpenCode, iPhone) or
// capitals with digits (GPT-5.5, H100).
func productLike(word string) bool {
	upper, lower, digit, innerUpper := false, false, false, false
	for i, r := range []rune(word) {
		switch {
		case unicode.IsUpper(r):
			upper, innerUpper = true, innerUpper || i > 0
		case unicode.IsLower(r):
			lower = true
		case unicode.IsDigit(r):
			digit = true
		}
	}
	return (innerUpper && lower) || (upper && digit)
}

// sentenceStart reports whether the token at byte offset i opens a sentence,
// line, list item or table cell: skipping spaces, quotes, brackets, emphasis
// and dashes, the text before it ends with . ! ? : | or a newline, or begins.
func sentenceStart(text string, i int) bool {
	for i > 0 {
		r, size := utf8.DecodeLastRuneInString(text[:i])
		switch {
		case strings.ContainsRune(".!?:|\n\r", r):
			return true
		case strings.ContainsRune(" \t*_~\"'“”‘’()[]>-–—", r):
			i -= size
		default:
			return false
		}
	}
	return true
}

// lowercaseWords is the set of words written entirely in lowercase somewhere
// in the prose of the pages: in this knowledge base they are ordinary words.
func lowercaseWords(texts []string) map[string]bool {
	words := map[string]bool{}
	for _, text := range texts {
		for _, w := range nameToken.FindAllString(text, -1) {
			w, _ = trimPossessive(w)
			if strings.IndexFunc(w, unicode.IsLetter) >= 0 && strings.ToLower(w) == w {
				words[w] = true
			}
		}
	}
	return words
}

// trimPossessive removes a trailing 's or ’s.
func trimPossessive(w string) (string, bool) {
	for _, suffix := range []string{"'s", "’s", "'S", "’S"} {
		if strings.HasSuffix(w, suffix) && len(w) > len(suffix) {
			return strings.TrimSuffix(w, suffix), true
		}
	}
	return w, false
}

// capitalizedNames returns the names in prose: runs of up to five capitalized
// or product-like words joined by spaces (Mario Zechner, Stripe Minions), and
// single such words (Cloudflare, OpenCode, GPT-5.5). Stopwords end a run. A
// run that opens a sentence loses its first word when that word is common
// (a stopword or written in lowercase elsewhere); a single word that opens a
// sentence counts only when product-like; a single word inside a sentence
// counts only when it is not common.
func capitalizedNames(text string, lower map[string]bool) []string {
	common := func(w string) bool {
		l := strings.ToLower(w)
		return stopword(w) || lower[l]
	}
	names := []string{}
	var run []string
	initial, prevEnd := false, -1
	flush := func() {
		words := run
		run, prevEnd = nil, -1
		if len(words) > 0 && initial && !productLike(words[0]) && (len(words) == 1 || common(words[0])) {
			words = words[1:]
		}
		if len(words) == 1 && !productLike(words[0]) && (common(words[0]) || len([]rune(words[0])) < 3) {
			return
		}
		if len(words) > 0 && len(words) <= 5 {
			names = append(names, strings.Join(words, " "))
		}
	}
	for _, loc := range nameToken.FindAllStringIndex(text, -1) {
		word, possessive := trimPossessive(text[loc[0]:loc[1]])
		if prevEnd >= 0 && strings.Trim(text[prevEnd:loc[0]], " \t") != "" {
			flush()
		}
		first, _ := utf8.DecodeRuneInString(word)
		if !(unicode.IsUpper(first) || productLike(word)) || stopword(word) {
			flush()
			continue
		}
		if len(run) == 0 {
			initial = sentenceStart(text, loc[0])
		}
		run, prevEnd = append(run, word), loc[1]
		if possessive {
			flush()
		}
	}
	flush()
	return names
}

// titleWords lowercases s and reduces it to its words: every run of
// characters other than letters and digits becomes one space, so that
// "Cursor (Anysphere)" reads "cursor anysphere" and "ZTE: zero-touch" reads
// "zte zero touch".
func titleWords(s string) string {
	return strings.Join(strings.FieldsFunc(strings.ToLower(s), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	}), " ")
}

// containsWords reports whether the words of term occur, in order and as
// whole words, in the normalized text s.
func containsWords(s, term string) bool {
	return strings.Contains(" "+s+" ", " "+term+" ")
}

// fieldLabel reports a bold label such as "**Video:**" that opens a line or a
// list item: it names a field of the page, not a recurring term.
func fieldLabel(text string, start int, term string) bool {
	if !strings.HasSuffix(strings.TrimSpace(term), ":") {
		return false
	}
	line := text[strings.LastIndexByte(text[:start], '\n')+1 : start]
	return listPrefix.MatchString(line)
}

// missingPages finds terms on at least three pages when no published page has
// that term as its title or slug. Terms are text written in **bold** (or
// __bold__), the text of Markdown links [term](url) and capitalized names in
// prose (see capitalizedNames); a name is also skipped when it is part of a
// page title or slug (Karpathy for a page "Andrej Karpathy", Anysphere for
// "Cursor (Anysphere)"), comparing words with punctuation removed. Terms compare
// case-insensitively with hyphens and spaces equal; code, [[page]] links and
// headings are ignored.
func missingPages(pages []lintPage) []map[string]any {
	existing := map[string]bool{}
	titles := []string{}
	for _, p := range pages {
		existing[normalTerm(p.Title)], existing[normalTerm(p.Slug)] = true, true
		titles = append(titles, titleWords(p.Title), titleWords(p.Slug))
	}
	partOfTitle := func(term string) bool {
		term = titleWords(term)
		for _, t := range titles {
			if containsWords(t, term) {
				return true
			}
		}
		return false
	}
	prose, texts := map[string]string{}, []string{}
	for _, p := range pages {
		prose[p.ID] = nameText(p.Body)
		texts = append(texts, prose[p.ID])
	}
	lower := lowercaseWords(texts)
	on := map[string]map[string]bool{}
	// The reported spelling is the most frequent one, ties going to the page
	// first in slug order, so the result does not depend on record order.
	ordered := append([]lintPage(nil), pages...)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].Slug < ordered[j].Slug })
	forms, firstSeen := map[string]map[string]int{}, map[string][]string{}
	for _, p := range ordered {
		text := footnoteMark.ReplaceAllString(withoutCode(p.Body), "")
		var raw []string
		for _, loc := range boldTerm.FindAllStringSubmatchIndex(text, -1) {
			term := text[max(loc[2], loc[4]):max(loc[3], loc[5])]
			if fieldLabel(text, loc[0], term) {
				continue
			}
			raw = append(raw, strings.TrimRight(term, ":"))
		}
		for _, m := range mdLink.FindAllStringSubmatch(text, -1) {
			if !strings.HasPrefix(m[0], "!") {
				raw = append(raw, m[1])
			}
		}
		names := len(raw)
		raw = append(raw, capitalizedNames(prose[p.ID], lower)...)
		for i, r := range raw {
			term := normalTerm(r)
			if !candidateTerm(term) || existing[term] || (i >= names && partOfTitle(term)) {
				continue
			}
			if on[term] == nil {
				on[term], forms[term] = map[string]bool{}, map[string]int{}
			}
			on[term][p.Slug] = true
			form := strings.TrimSpace(r)
			if forms[term][form] == 0 {
				firstSeen[term] = append(firstSeen[term], form)
			}
			forms[term][form]++
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
		display := ""
		for _, form := range firstSeen[term] {
			if display == "" || forms[term][form] > forms[term][display] {
				display = form
			}
		}
		findings = append(findings, map[string]any{"kind": "missing-page", "term": display, "pages": slugs})
	}
	return findings
}

// stubs finds pages with fewer than stubWords words of prose or exactly one
// citation. Entity pages with a supported catalog_type are catalog records, not
// prose, and are never stubs; other entity pages, even with properties, are
// checked like any page. Pages without citations are reported as no-citations.
func stubs(pages []lintPage) []map[string]any {
	findings := []map[string]any{}
	for _, p := range pages {
		if p.Kind == "entity" && catalogTypes[p.Catalog] {
			continue
		}
		if words := countWords(proseText(p.Body)); words < stubWords || p.Citations == 1 {
			findings = append(findings, map[string]any{"page": p.Slug, "kind": "stub", "words": words, "citations": p.Citations})
		}
	}
	return findings
}
