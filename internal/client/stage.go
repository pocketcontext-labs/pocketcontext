package client

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Staging a whole run from one JSON spec, checking a run before publication and
// exporting a published page as an editable spec page. The server's publication
// checks stay the authority: stage validates what it needs to build the records
// before the first write, then asks the server (check-run) for every problem.

// stageSpec is the JSON document `stage` reads.
type stageSpec struct {
	RunKey      string     `json:"run_key"`
	Description string     `json:"description,omitempty"`
	Sources     []string   `json:"sources,omitempty"`
	Home        string     `json:"home,omitempty"`
	Pages       []specPage `json:"pages"`
}

// specPage is one page of a spec, and the output of `page`. Omitted title,
// summary, properties and property_evidence are copied from the published revision.
// Without body, edits and then append change the published body.
type specPage struct {
	Slug             string            `json:"slug"`
	Kind             string            `json:"kind,omitempty"`
	Title            *string           `json:"title,omitempty"`
	Summary          *string           `json:"summary,omitempty"`
	Body             *string           `json:"body,omitempty"`
	Edits            []specEdit        `json:"edits,omitempty"`
	Append           *string           `json:"append,omitempty"`
	Citations        map[string]string `json:"citations,omitempty"`
	Properties       map[string]any    `json:"properties,omitempty"`
	PropertyEvidence map[string]any    `json:"property_evidence,omitempty"`
	Archived         *bool             `json:"archived,omitempty"`
}

// specEdit replaces old, which must occur exactly once, with new.
type specEdit struct {
	Old string  `json:"old"`
	New *string `json:"new"`
}

type problem struct {
	Page   string `json:"page"`
	Kind   string `json:"kind"`
	Detail string `json:"detail"`
}

// batchLimit is the server's maximum number of requests in one /api/batch call.
const batchLimit = 20

var (
	slugPattern     = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)
	markerPattern   = regexp.MustCompile(`\[\^(\d+)\]`)
	footnotePattern = regexp.MustCompile(`(?m)^\[\^\d+\]:`)
	linkPattern     = regexp.MustCompile(`\[\[([^\]]+)\]\]`)
	citationKey     = regexp.MustCompile(`^[1-9][0-9]{0,7}$`)
	pageKinds       = map[string]bool{"summary": true, "concept": true, "entity": true, "transcript": true, "answer": true, "legacy": true}
)

// parseSpec decodes a spec strictly and reports its shape problems.
func parseSpec(data []byte) (*stageSpec, []problem, error) {
	var spec stageSpec
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&spec); err != nil {
		return nil, nil, fail(2, "the spec is not valid: %v", err)
	}
	var problems []problem
	add := func(page, kind, format string, args ...any) {
		problems = append(problems, problem{page, kind, fmt.Sprintf(format, args...)})
	}
	if strings.TrimSpace(spec.RunKey) == "" || len(spec.RunKey) > 100 {
		add("", "spec", "run_key is required (1-100 characters)")
	}
	if len(spec.Description) > 2000 {
		add("", "spec", "description is longer than 2000 characters")
	}
	if len(spec.Sources) > 100 {
		add("", "spec", "at most 100 sources")
	}
	for _, id := range spec.Sources {
		if !idPattern.MatchString(id) {
			add("", "source", "invalid source ID %q", id)
		}
	}
	if spec.Home != "" && !slugPattern.MatchString(spec.Home) {
		add("", "home", "home must be a page slug: %q", spec.Home)
	}
	if len(spec.Pages) == 0 && spec.Home == "" {
		add("", "spec", "pages is empty and no home is chosen")
	}
	seen := map[string]bool{}
	for i, p := range spec.Pages {
		name := p.Slug
		switch {
		case !slugPattern.MatchString(p.Slug) || len(p.Slug) > 150:
			add(name, "slug", "pages[%d]: invalid slug %q (lowercase words joined by hyphens)", i, p.Slug)
		case p.Slug == "index" || p.Slug == "log":
			add(name, "slug", "reserved slug %q", p.Slug)
		case seen[p.Slug]:
			add(name, "duplicate", "slug appears more than once in the spec")
		}
		seen[p.Slug] = true
		if p.Kind != "" && !pageKinds[p.Kind] {
			add(name, "kind", "unknown kind %q (summary, concept, entity, transcript, answer, legacy)", p.Kind)
		}
		if p.Body != nil && p.Append != nil {
			add(name, "spec", "give body or append, not both")
		}
		if p.Body != nil && len(p.Edits) > 0 {
			add(name, "spec", "give body or edits, not both; edits change the published body")
		}
		for j, e := range p.Edits {
			if e.Old == "" {
				add(name, "edit", "edits[%d]: old is empty", j)
			}
			if e.New == nil {
				add(name, "edit", "edits[%d]: new is required (\"\" deletes the old text)", j)
			}
		}
		for key, passage := range p.Citations {
			if !citationKey.MatchString(key) {
				add(name, "citation", "citation marker %q must be a positive number", key)
			}
			if !idPattern.MatchString(passage) {
				add(name, "citation", "citation %s: invalid passage ID %q", key, passage)
			}
		}
	}
	return &spec, problems, nil
}

// bodyMarkers returns the distinct citation markers of a body in order.
func bodyMarkers(body string) []string {
	var out []string
	seen := map[string]bool{}
	for _, m := range markerPattern.FindAllStringSubmatch(body, -1) {
		if !seen[m[1]] {
			seen[m[1]] = true
			out = append(out, m[1])
		}
	}
	return out
}

// bodyLinks returns the distinct [[slug]] targets of a body in order, read as the
// server reads them: [[slug|label]] and [[slug#heading]] name slug.
func bodyLinks(body string) []string {
	var out []string
	seen := map[string]bool{}
	for _, m := range linkPattern.FindAllStringSubmatch(body, -1) {
		target, _, _ := strings.Cut(m[1], "|")
		target, _, _ = strings.Cut(target, "#")
		if !seen[target] {
			seen[target] = true
			out = append(out, target)
		}
	}
	return out
}

// highestMarker is the largest marker used by a body or its citations.
func highestMarker(body string, citations map[string]string) int {
	high := 0
	for _, m := range bodyMarkers(body) {
		if n, err := strconv.Atoi(m); err == nil && n > high {
			high = n
		}
	}
	for m := range citations {
		if n, err := strconv.Atoi(m); err == nil && n > high {
			high = n
		}
	}
	return high
}

// renumber shifts every [^n] marker of text by offset.
func renumber(text string, offset int) string {
	return markerPattern.ReplaceAllStringFunc(text, func(m string) string {
		n, err := strconv.Atoi(m[2 : len(m)-1])
		if err != nil {
			return m
		}
		return "[^" + strconv.Itoa(n+offset) + "]"
	})
}

// revisePage applies edits, then appended text, to a published body and its
// citations. Local markers in the new text of edits and in the appended text
// share one numbering: [^k] there is local citation k and becomes [^k+offset],
// offset being the highest marker of the published body and citations. Each
// edit's old text must occur exactly once in the body as earlier edits left
// it; an edit that does not is skipped and reported. Published markers that no
// longer appear in the body lose their citations, unless keep (the markers of
// property evidence) names them.
func revisePage(body string, citations map[string]string, edits []specEdit, text string, local map[string]string, keep map[string]bool) (string, map[string]string, []string) {
	offset := highestMarker(body, citations)
	before := bodyMarkers(body)
	var problems []string
	for i, e := range edits {
		if e.Old == "" || e.New == nil {
			continue // reported by parseSpec
		}
		at := strings.Index(body, e.Old)
		switch {
		case at < 0:
			problems = append(problems, fmt.Sprintf("edits[%d]: old text not found in the published body (after earlier edits)", i))
			continue
		case strings.Contains(body[at+1:], e.Old):
			problems = append(problems, fmt.Sprintf("edits[%d]: old text occurs more than once in the published body (after earlier edits); include more surrounding text", i))
			continue
		}
		body = body[:at] + renumber(*e.New, offset) + body[at+len(e.Old):]
	}
	if strings.TrimSpace(text) != "" {
		body = strings.TrimRight(body, " \t\r\n") + "\n\n" + strings.TrimLeft(renumber(text, offset), "\r\n")
	}
	merged := map[string]string{}
	for k, v := range citations {
		merged[k] = v
	}
	if len(edits) > 0 {
		after := map[string]bool{}
		for _, m := range bodyMarkers(body) {
			after[m] = true
		}
		for _, m := range before {
			if !after[m] && !keep[m] {
				delete(merged, m)
			}
		}
	}
	for k, v := range local {
		if n, err := strconv.Atoi(k); err == nil {
			merged[strconv.Itoa(n+offset)] = v
		}
	}
	return body, merged, problems
}

// packBatches fills batches of up to size requests in order, keeping each group
// (a page revision with its citations and links) in one batch when it fits.
func packBatches(groups [][]any, size int) [][]any {
	var out [][]any
	var current []any
	for _, group := range groups {
		if len(current) > 0 && len(current)+len(group) > size {
			out, current = append(out, current), nil
		}
		for _, r := range group {
			if len(current) == size {
				out, current = append(out, current), nil
			}
			current = append(current, r)
		}
	}
	if len(current) > 0 {
		out = append(out, current)
	}
	return out
}

func numericKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		a, _ := strconv.Atoi(keys[i])
		b, _ := strconv.Atoi(keys[j])
		return a < b
	})
	return keys
}

// inList runs fetch for chunks of up to 100 quoted values.
func inList(values []string, fetch func(list string) ([]map[string]any, error)) ([]map[string]any, error) {
	unique := map[string]bool{}
	var quoted []string
	for _, v := range values {
		if !unique[v] {
			unique[v] = true
			quoted = append(quoted, literal(v))
		}
	}
	var out []map[string]any
	for start := 0; start < len(quoted); start += 100 {
		rows, err := fetch(strings.Join(quoted[start:min(start+100, len(quoted))], ","))
		if err != nil {
			return nil, err
		}
		out = append(out, rows...)
	}
	return out, nil
}

type pageRow struct{ id, slug, kind string }

// pages reads page identities of the space by slug or id.
func (c *Client) pages(space, column string, values []string) (map[string]pageRow, error) {
	rows, err := inList(values, func(list string) ([]map[string]any, error) {
		return c.batches(func(after string, limit int) string {
			return "SELECT id, slug, kind FROM pages WHERE space=" + literal(space) + " AND " + column + " IN (" + list + ") AND id>" + literal(after) + fmt.Sprintf(" ORDER BY id LIMIT %d", limit)
		})
	})
	out := map[string]pageRow{}
	for _, r := range rows {
		p := pageRow{fmt.Sprint(r["id"]), fmt.Sprint(r["slug"]), fmt.Sprint(r["kind"])}
		out[fmt.Sprint(r[column])] = p
	}
	return out, err
}

// published reads the selected revisions of pages in one publication, keyed by page ID.
func (c *Client) published(publication string, pageIDs []string, full bool) (map[string]map[string]any, error) {
	out := map[string]map[string]any{}
	if publication == "" {
		return out, nil
	}
	columns := "r.id, r.page, r.archived"
	if full {
		columns = "r.id, r.page, r.archived, r.title, r.summary, r.body, r.properties, r.property_evidence"
	}
	rows, err := inList(pageIDs, func(list string) ([]map[string]any, error) {
		return c.batches(func(after string, limit int) string {
			return "SELECT " + columns + " FROM publications pub JOIN json_each(pub.manifest) m JOIN page_revisions r ON r.id=m.value AND r.page=m.key " +
				"WHERE pub.id=" + literal(publication) + " AND m.key IN (" + list + ") AND r.id>" + literal(after) + fmt.Sprintf(" ORDER BY r.id LIMIT %d", limit)
		})
	})
	for _, r := range rows {
		out[fmt.Sprint(r["page"])] = r
	}
	return out, err
}

// children reads citations (marker → passage) or link targets of revisions, keyed by revision ID.
func (c *Client) children(table string, revisions []string) (map[string]map[string]string, error) {
	columns := "id, page_revision, marker, passage"
	if table == "page_links" {
		columns = "id, page_revision, target"
	}
	rows, err := inList(revisions, func(list string) ([]map[string]any, error) {
		return c.batches(func(after string, limit int) string {
			return "SELECT " + columns + " FROM " + table + " WHERE page_revision IN (" + list + ") AND id>" + literal(after) + fmt.Sprintf(" ORDER BY id LIMIT %d", limit)
		})
	})
	out := map[string]map[string]string{}
	for _, r := range rows {
		rev := fmt.Sprint(r["page_revision"])
		if out[rev] == nil {
			out[rev] = map[string]string{}
		}
		if table == "page_links" {
			out[rev][fmt.Sprint(r["target"])] = ""
		} else {
			out[rev][fmt.Sprint(r["marker"])] = fmt.Sprint(r["passage"])
		}
	}
	return out, err
}

func (c *Client) existing(table, space string, ids []string) (map[string]bool, error) {
	rows, err := inList(ids, func(list string) ([]map[string]any, error) {
		return c.batches(func(after string, limit int) string {
			return "SELECT id FROM " + table + " WHERE space=" + literal(space) + " AND id IN (" + list + ") AND id>" + literal(after) + fmt.Sprintf(" ORDER BY id LIMIT %d", limit)
		})
	})
	out := map[string]bool{}
	for _, r := range rows {
		out[fmt.Sprint(r["id"])] = true
	}
	return out, err
}

func flag(v any) bool { n, _ := asInt(v); return n != 0 || v == true }

// stagedPage is one page revision to write.
type stagedPage struct {
	slug, page, kind, revision, base string
	fresh, skip                      bool
	title, summary, body             string
	archived                         bool
	properties, evidence             map[string]any
	citations                        map[string]string
	links                            []string // target page IDs
}

// Stage validates a spec completely, then writes its run through /api/batch.
func (c *Client) Stage(data []byte, dryRun bool) (map[string]any, error) {
	spec, problems, err := parseSpec(data)
	if err != nil {
		return nil, err
	}
	add := func(page, kind, format string, args ...any) {
		problems = append(problems, problem{page, kind, fmt.Sprintf(format, args...)})
	}
	space, err := c.SpaceID()
	if err != nil {
		return nil, err
	}
	publication, err := c.selectPublication("", 0)
	if err != nil {
		return nil, err
	}
	pubID, previousHome := "", ""
	if publication != nil {
		pubID = publication["id"].(string)
		rows, err := c.Rows("SELECT home FROM publications WHERE id=" + literal(pubID))
		if err != nil {
			return nil, err
		}
		previousHome, _ = rows[0]["home"].(string)
	}

	// The run: resumed by key while it is staging.
	var run map[string]any
	runs, err := c.Rows("SELECT id, status, revision, home FROM ingestion_runs WHERE space=" + literal(space) + " AND key=" + literal(spec.RunKey) + " LIMIT 1")
	if err != nil {
		return nil, err
	}
	stagedRevisions := map[string]string{} // page ID → revision ID already in the run
	var stagedCitations, stagedLinks map[string]map[string]string
	if len(runs) == 1 {
		run = runs[0]
		if status := fmt.Sprint(run["status"]); status != "staging" {
			add("", "run", "run %s with key %q is %s; choose a new run_key", run["id"], spec.RunKey, status)
		}
		rows, err := c.batches(func(after string, limit int) string {
			return "SELECT id, page FROM page_revisions WHERE run=" + literal(run["id"]) + " AND id>" + literal(after) + fmt.Sprintf(" ORDER BY id LIMIT %d", limit)
		})
		if err != nil {
			return nil, err
		}
		var ids []string
		for _, r := range rows {
			stagedRevisions[fmt.Sprint(r["page"])] = fmt.Sprint(r["id"])
			ids = append(ids, fmt.Sprint(r["id"]))
		}
		if stagedCitations, err = c.children("citations", ids); err != nil {
			return nil, err
		}
		if stagedLinks, err = c.children("page_links", ids); err != nil {
			return nil, err
		}
	}

	// Pages of the spec and their published revisions.
	var slugs []string
	for _, p := range spec.Pages {
		slugs = append(slugs, p.Slug)
	}
	known, err := c.pages(space, "slug", slugs)
	if err != nil {
		return nil, err
	}
	var copied []string
	for _, p := range spec.Pages {
		if row, ok := known[p.Slug]; ok {
			copied = append(copied, row.id)
		}
	}
	current, err := c.published(pubID, copied, true)
	if err != nil {
		return nil, err
	}
	var currentIDs []string
	for _, r := range current {
		currentIDs = append(currentIDs, fmt.Sprint(r["id"]))
	}
	currentCitations, err := c.children("citations", currentIDs)
	if err != nil {
		return nil, err
	}

	var staged []*stagedPage
	bySlug := map[string]*stagedPage{}
	var passages []string
	for _, p := range spec.Pages {
		if bySlug[p.Slug] != nil {
			continue
		}
		s := &stagedPage{slug: p.Slug, kind: p.Kind, revision: NewID()}
		bySlug[p.Slug] = s
		staged = append(staged, s)
		row, exists := known[p.Slug]
		if exists {
			s.page = row.id
			if p.Kind != "" && p.Kind != row.kind {
				add(p.Slug, "kind", "page exists with kind %s; kinds are immutable", row.kind)
			}
			s.kind = row.kind
			if id, ok := stagedRevisions[row.id]; ok {
				s.skip, s.revision = true, id
			}
		} else {
			s.page, s.fresh = NewID(), true
			if p.Kind == "" {
				add(p.Slug, "kind", "new page needs a kind")
			}
		}
		prior := current[s.page]
		if prior != nil {
			s.base = fmt.Sprint(prior["id"])
		}
		s.properties, s.evidence = p.Properties, p.PropertyEvidence
		if s.properties == nil && prior != nil {
			s.properties = decodeJSONField(prior["properties"])
		}
		if s.evidence == nil && prior != nil {
			s.evidence = decodeJSONField(prior["property_evidence"])
		}
		if p.Body != nil {
			s.body, s.citations = *p.Body, p.Citations
		} else if prior == nil {
			add(p.Slug, "spec", "body is required: the page has no published revision to edit or append to")
		} else {
			text := ""
			if p.Append != nil {
				text = *p.Append
			}
			keep := map[string]bool{}
			for _, list := range s.evidence {
				for _, m := range stringList(list) {
					keep[m] = true
				}
			}
			body, _ := prior["body"].(string)
			var failed []string
			s.body, s.citations, failed = revisePage(body, currentCitations[s.base], p.Edits, text, p.Citations, keep)
			for _, detail := range failed {
				add(p.Slug, "edit", "%s", detail)
			}
		}
		if s.citations == nil {
			s.citations = map[string]string{}
		}
		pick := func(given *string, field string) string {
			if given != nil {
				return *given
			}
			if prior != nil {
				v, _ := prior[field].(string)
				return v
			}
			return ""
		}
		s.title, s.summary = pick(p.Title, "title"), pick(p.Summary, "summary")
		if strings.TrimSpace(s.title) == "" || len(s.title) > 500 {
			add(p.Slug, "spec", "title is required (1-500 characters)")
		}
		if strings.TrimSpace(s.summary) == "" || len(s.summary) > 2000 {
			add(p.Slug, "spec", "summary is required (1-2000 characters)")
		}
		if strings.TrimSpace(s.body) == "" || len(s.body) > 100000 {
			add(p.Slug, "spec", "body is required (at most 100000 characters)")
		}
		s.archived = p.Archived != nil && *p.Archived

		// Markers, citations and evidence, as publication checks them.
		if footnotePattern.MatchString(s.body) {
			add(p.Slug, "footnote-definition", "footnote definitions are rendered from citations; remove [^n]: lines")
		}
		markers := map[string]bool{}
		used := bodyMarkers(s.body)
		for _, m := range used {
			markers[m] = true
		}
		hasEvidence := false
		for key, list := range s.evidence {
			for _, m := range stringList(list) {
				markers[m], hasEvidence = true, true
			}
			if _, ok := s.properties[key]; !ok {
				add(p.Slug, "property", "property_evidence names %s, which is not a property", key)
			}
		}
		for _, m := range sortedKeys(markers) {
			if _, ok := s.citations[m]; !ok {
				add(p.Slug, "missing-marker", "marker [^%s] has no citation", m)
			}
		}
		for _, m := range numericKeys(s.citations) {
			if !markers[m] {
				add(p.Slug, "unused-citation", "citation %s is not used in the body or property_evidence", m)
			}
			passages = append(passages, s.citations[m])
		}
		markdownDocument := s.properties["catalog_type"] == "repository_document" && s.properties["output_mode"] == "markdown" && hasEvidence
		if len(used) == 0 && !strings.Contains(s.body, "[needs verification]") && !markdownDocument {
			add(p.Slug, "uncited", "body cites nothing; cite passages or mark it [needs verification]")
		}
	}

	// Link targets: pages staged unarchived in this spec, or published and unarchived.
	var targets, relationIDs []string
	for _, s := range staged {
		targets = append(targets, bodyLinks(s.body)...)
		for key := range relationshipProperties {
			relationIDs = append(relationIDs, stringList(s.properties[key])...)
		}
	}
	if spec.Home != "" {
		targets = append(targets, spec.Home)
	}
	targetPages, err := c.pages(space, "slug", targets)
	if err != nil {
		return nil, err
	}
	relationPages, err := c.pages(space, "id", relationIDs)
	if err != nil {
		return nil, err
	}
	var targetIDs []string
	for _, row := range targetPages {
		targetIDs = append(targetIDs, row.id)
	}
	for id := range relationPages {
		targetIDs = append(targetIDs, id)
	}
	targetRevisions, err := c.published(pubID, targetIDs, false)
	if err != nil {
		return nil, err
	}
	stagedByID := map[string]*stagedPage{}
	for _, s := range staged {
		stagedByID[s.page] = s
	}
	// resolve returns the page ID of a valid target, or why it is not one.
	resolve := func(slug, id string) (string, string) {
		if s := bySlug[slug]; s != nil && slug != "" {
			id = s.page
		} else if row, ok := targetPages[slug]; ok && slug != "" {
			id = row.id
		} else if slug != "" {
			return "", "no page has this slug"
		} else if _, ok := relationPages[id]; !ok && stagedByID[id] == nil {
			return "", "no page has this ID in the space"
		}
		if s := stagedByID[id]; s != nil {
			if s.archived {
				return "", "it is archived in this spec"
			}
			return id, ""
		}
		if r := targetRevisions[id]; r == nil || flag(r["archived"]) {
			return "", "it is not published and not staged in this spec"
		}
		return id, ""
	}
	for _, s := range staged {
		seen := map[string]bool{}
		for _, slug := range bodyLinks(s.body) {
			id, why := resolve(slug, "")
			if why != "" {
				add(s.slug, "link-target", "[[%s]]: %s", slug, why)
			} else if !seen[id] {
				seen[id] = true
				s.links = append(s.links, id)
			}
		}
		keys := make([]string, 0, len(s.properties))
		for key := range s.properties {
			if relationshipProperties[key] {
				keys = append(keys, key)
			}
		}
		sort.Strings(keys)
		for _, key := range keys {
			for _, target := range stringList(s.properties[key]) {
				id, why := resolve("", target)
				if why != "" {
					add(s.slug, "relationship-target", "%s → %s: %s", key, target, why)
				} else if !seen[id] {
					seen[id] = true
					s.links = append(s.links, id)
				}
			}
		}
	}
	homeID := ""
	if spec.Home != "" {
		id, why := resolve(spec.Home, "")
		if why != "" {
			add(spec.Home, "home", "home %s: %s", spec.Home, why)
		}
		homeID = id
	}

	// Evidence and sources must exist in the space.
	found, err := c.existing("passages", space, passages)
	if err != nil {
		return nil, err
	}
	for _, s := range staged {
		for _, m := range numericKeys(s.citations) {
			if id := s.citations[m]; idPattern.MatchString(id) && !found[id] {
				add(s.slug, "passage", "citation %s: passage %s not found in this space", m, id)
			}
		}
	}
	sources, err := c.existing("sources", space, spec.Sources)
	if err != nil {
		return nil, err
	}
	for _, id := range spec.Sources {
		if idPattern.MatchString(id) && !sources[id] {
			add("", "source", "source %s not found in this space", id)
		}
	}

	out := map[string]any{"run": nil, "revision": nil, "staged": []string{}, "skipped": []string{}, "problems": problems}
	if run != nil {
		out["run"], out["revision"] = run["id"], run["revision"]
	}
	for _, s := range staged {
		if s.skip {
			out["skipped"] = append(out["skipped"].([]string), s.slug)
		} else {
			out["staged"] = append(out["staged"].([]string), s.slug)
		}
	}
	if problems == nil {
		out["problems"] = []problem{}
	}
	if len(problems) > 0 || dryRun {
		return out, nil
	}

	// Writes: new identities, the run, then each page with its citations and links.
	var groups [][]any
	post := func(collection string, body map[string]any) any {
		return map[string]any{"method": "POST", "url": records(collection), "body": body}
	}
	for _, s := range staged {
		if s.fresh {
			groups = append(groups, []any{post("pages", map[string]any{"id": s.page, "space": space, "slug": s.slug, "kind": s.kind})})
		}
	}
	runID := ""
	if run == nil {
		runID = NewID()
		description := spec.Description
		if description == "" {
			description = "Staged from spec " + spec.RunKey
		}
		body := map[string]any{"id": runID, "space": space, "key": spec.RunKey, "status": "staging", "description": description, "sources": spec.Sources}
		if homeID != "" {
			body["home"], body["home_base"], body["clear_home"] = homeID, previousHome, false
		}
		groups = append(groups, []any{post("ingestion_runs", body)})
	} else {
		runID = fmt.Sprint(run["id"])
		if homeID != "" && homeID != fmt.Sprint(run["home"]) {
			revision, _ := asInt(run["revision"])
			groups = append(groups, []any{map[string]any{"method": "PATCH", "url": records("ingestion_runs", runID),
				"body": map[string]any{"home": homeID, "home_base": previousHome, "clear_home": false, "expected_revision": revision}}})
		}
	}
	for _, s := range staged {
		var group []any
		if !s.skip {
			body := map[string]any{"id": s.revision, "run": runID, "page": s.page, "base_revision": s.base, "title": s.title,
				"summary": s.summary, "body": s.body, "archived": s.archived}
			if len(s.properties) > 0 {
				body["properties"] = s.properties
			}
			if len(s.evidence) > 0 {
				body["property_evidence"] = s.evidence
			}
			group = append(group, post("page_revisions", body))
		}
		// A resumed page gets only the citations and links an interrupted run missed.
		for _, m := range numericKeys(s.citations) {
			if _, done := stagedCitations[s.revision][m]; !done {
				group = append(group, post("citations", map[string]any{"page_revision": s.revision, "passage": s.citations[m], "marker": m}))
			}
		}
		for _, target := range s.links {
			if _, done := stagedLinks[s.revision][target]; !done {
				group = append(group, post("page_links", map[string]any{"page_revision": s.revision, "target": target}))
			}
		}
		if len(group) > 0 {
			groups = append(groups, group)
		}
	}
	batches := packBatches(groups, batchLimit)
	for i, batch := range batches {
		if _, err := c.Must("POST", "/api/batch", map[string]any{"requests": batch}); err != nil {
			code := 1
			if f, ok := err.(*Fail); ok {
				code = f.Code
			}
			return nil, &Fail{code, fmt.Sprintf("%v\nbatch %d of %d failed; earlier batches are saved in run %s. Fix the spec and run stage again with the same run_key to resume.", err, i+1, len(batches), runID)}
		}
	}

	check, err := c.CheckRun(runID)
	if err != nil {
		return nil, err
	}
	rows, err := c.Rows("SELECT revision FROM ingestion_runs WHERE id=" + literal(runID))
	if err != nil {
		return nil, err
	}
	out["run"], out["revision"] = runID, rows[0]["revision"]
	if list, _ := check["problems"].([]any); len(list) > 0 {
		out["problems"] = list
	}
	return out, nil
}

func sortedKeys(m map[string]bool) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// CheckRun asks the server for every problem publication of the run would raise.
func (c *Client) CheckRun(id string) (map[string]any, error) {
	if !idPattern.MatchString(id) {
		return nil, fail(2, "run ID must be 15 lowercase letters or digits")
	}
	data, err := c.Must("GET", "/api/pocketcontext/runs/"+id+"/check", nil)
	if err != nil {
		return nil, err
	}
	result, ok := data.(map[string]any)
	if !ok || result["run"] != id {
		return nil, fail(1, "unexpected run check response")
	}
	return result, nil
}

// PageSpec exports a published page as a spec page with marker → passage citations.
func (c *Client) PageSpec(slug, publicationID string, sequence int) (*specPage, error) {
	if !slugPattern.MatchString(slug) {
		return nil, fail(2, "invalid page slug")
	}
	publication, err := c.selectPublication(publicationID, sequence)
	if err != nil {
		return nil, err
	}
	if publication == nil {
		return nil, fail(1, "nothing is published in this space")
	}
	pubID := publication["id"].(string)
	rows, err := c.Rows("SELECT r.id, p.kind, r.title, r.summary, r.body, r.archived, r.properties, r.property_evidence " +
		manifestJoin(pubID) + "WHERE pub.id=" + literal(pubID) + " AND p.slug=" + literal(slug) + " AND r.id IS NOT NULL LIMIT 1")
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, fail(1, "page %s is not in publication %v", slug, publication["sequence"])
	}
	r := rows[0]
	citations, err := c.children("citations", []string{fmt.Sprint(r["id"])})
	if err != nil {
		return nil, err
	}
	text := func(field string) *string { v, _ := r[field].(string); return &v }
	page := &specPage{Slug: slug, Kind: fmt.Sprint(r["kind"]), Title: text("title"), Summary: text("summary"), Body: text("body"),
		Citations: citations[fmt.Sprint(r["id"])]}
	if page.Citations == nil {
		page.Citations = map[string]string{}
	}
	if m := decodeJSONField(r["properties"]); len(m) > 0 {
		page.Properties = m
	}
	if m := decodeJSONField(r["property_evidence"]); len(m) > 0 {
		page.PropertyEvidence = m
	}
	if flag(r["archived"]) {
		archived := true
		page.Archived = &archived
	}
	return page, nil
}

// readSpec reads a spec file, or standard input for "-".
func readSpec(path string) ([]byte, error) {
	if path == "-" {
		return readArg("-", "the spec")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fail(2, "cannot read the spec: %v", err)
	}
	return data, nil
}

// problemCount counts a problems list of either origin.
func problemCount(v any) int {
	switch list := v.(type) {
	case []problem:
		return len(list)
	case []any:
		return len(list)
	}
	return 0
}
