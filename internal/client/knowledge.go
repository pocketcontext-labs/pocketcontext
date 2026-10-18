package client

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// Queries against committed knowledge, never against generated Markdown.

const batchSize = 100

// batches fetches rows ordered by id in bounded pages, halving oversized pages.
func (c *Client) batches(statement func(after string, limit int) string) ([]map[string]any, error) {
	after, limit := "", batchSize
	var out []map[string]any
	for {
		batch, err := c.Rows(statement(after, limit))
		if err != nil {
			if limit > 1 && (strings.Contains(err.Error(), "truncated") || strings.Contains(err.Error(), "HTTP 413")) {
				limit = max(1, limit/2)
				continue
			}
			return nil, err
		}
		if len(batch) == 0 {
			return out, nil
		}
		previous := after
		for _, row := range batch {
			id, _ := row["id"].(string)
			if !idPattern.MatchString(id) || id <= previous {
				return nil, fail(1, "invalid SQL pagination")
			}
			previous = id
		}
		out = append(out, batch...)
		after = previous
	}
}

func manifestJoin(publication string) string {
	return "FROM publications pub JOIN json_each(pub.manifest) m " +
		"LEFT JOIN pages p ON p.id=m.key " +
		"LEFT JOIN page_revisions r ON r.id=m.value AND r.page=p.id "
}

func (c *Client) selectPublication(publicationID string, sequence int) (map[string]any, error) {
	if publicationID != "" && !idPattern.MatchString(publicationID) {
		return nil, fail(2, "invalid publication ID")
	}
	if publicationID != "" && sequence != 0 {
		return nil, fail(2, "choose a publication ID or sequence, not both")
	}
	space, err := c.SpaceID()
	if err != nil {
		return nil, err
	}
	condition := " WHERE space=" + literal(space)
	if publicationID != "" {
		condition += " AND id=" + literal(publicationID)
	} else if sequence != 0 {
		condition += fmt.Sprintf(" AND sequence=%d", sequence)
	}
	rows, err := c.Rows("SELECT id, space, sequence, CASE WHEN json_valid(manifest) THEN json_type(manifest) ELSE 'invalid' END AS manifest_type FROM publications" + condition + " ORDER BY sequence DESC LIMIT 1")
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		if publicationID != "" || sequence != 0 {
			return nil, fail(1, "publication not found")
		}
		return nil, nil
	}
	if rows[0]["manifest_type"] != "object" {
		return nil, fail(1, "invalid publication manifest")
	}
	delete(rows[0], "manifest_type")
	return rows[0], nil
}

func (c *Client) validateManifest(publication map[string]any) (map[string]any, error) {
	id := publication["id"].(string)
	rows, err := c.Rows("SELECT count(*) AS total, count(DISTINCT m.key) AS unique_keys, " +
		"coalesce(sum(CASE WHEN length(m.key)!=15 OR m.key GLOB '*[^a-z0-9]*' " +
		"OR m.type!='text' OR length(m.value)!=15 OR m.value GLOB '*[^a-z0-9]*' " +
		"OR p.id IS NULL OR r.id IS NULL THEN 1 ELSE 0 END),0) AS invalid, " +
		"coalesce(sum(CASE WHEN r.archived=0 THEN 1 ELSE 0 END),0) AS active " +
		manifestJoin(id) + "WHERE pub.id=" + literal(id))
	if err != nil {
		return nil, err
	}
	v := rows[0]
	invalid, _ := asInt(v["invalid"])
	total, _ := asInt(v["total"])
	unique, _ := asInt(v["unique_keys"])
	if invalid != 0 || total != unique {
		return nil, fail(1, "invalid or incomplete publication manifest")
	}
	return v, nil
}

// SearchOptions select one bounded page of ranked results.
type SearchOptions struct {
	Publication string
	Sequence    int
	Limit       int
	Offset      int
	Generation  string
}

// Search ranks published revision text with the server's full-text index.
func (c *Client) Search(term string, o SearchOptions) (map[string]any, error) {
	if strings.TrimSpace(term) == "" || len(term) > 4096 || len(strings.Fields(term)) > 16 {
		return nil, fail(2, "search requires 1–16 terms and at most 4096 UTF-8 bytes")
	}
	if o.Limit < 1 || o.Limit > 100 || o.Offset < 0 || o.Offset > 10000 {
		return nil, fail(2, "search limit must be 1–100 and offset 0–10000")
	}
	if o.Offset > 0 && (o.Generation == "" || (o.Publication == "" && o.Sequence == 0)) {
		return nil, fail(2, "continuation requires --publication (or --sequence) and --generation")
	}
	publication, err := c.selectPublication(o.Publication, o.Sequence)
	if err != nil {
		return nil, err
	}
	if publication == nil {
		space, _ := c.SpaceID()
		return map[string]any{"space": space, "publication": nil, "generation": nil, "pages": []any{}, "hasMore": false, "nextOffset": nil}, nil
	}
	if _, err := c.validateManifest(publication); err != nil {
		return nil, err
	}
	pubID := publication["id"].(string)
	body := map[string]any{"index": "pages", "query": term, "scope": pubID, "limit": o.Limit, "offset": o.Offset}
	if o.Generation != "" {
		body["expectedGeneration"] = o.Generation
	}
	data, err := c.Must("POST", "/api/context/search", body)
	if err != nil {
		if f, ok := err.(*Fail); ok && f.Code == 4 {
			return nil, fail(4, "search index changed; discard prior result pages and restart at offset 0 without --generation")
		}
		return nil, err
	}
	result, _ := data.(map[string]any)
	hits, _ := result["hits"].([]any)
	generation, _ := result["generation"].(string)
	hasMore, _ := result["hasMore"].(bool)
	if result["index"] != "pages" || result["scope"] != pubID || generation == "" || (o.Generation != "" && generation != o.Generation) || len(hits) > o.Limit {
		return nil, fail(1, "invalid scoped search response")
	}
	ids := []string{}
	for _, h := range hits {
		hit, _ := h.(map[string]any)
		id, _ := hit["id"].(string)
		if !idPattern.MatchString(id) {
			return nil, fail(1, "invalid search hit")
		}
		ids = append(ids, id)
	}
	metadata := map[string]map[string]any{}
	if len(ids) > 0 {
		quoted := make([]string, len(ids))
		for i, id := range ids {
			quoted[i] = literal(id)
		}
		rows, err := c.batches(func(after string, limit int) string {
			return "SELECT r.id, r.page, p.slug, p.kind, r.title, r.summary " + manifestJoin(pubID) + "WHERE pub.id=" + literal(pubID) +
				" AND r.archived=0 AND r.id IN (" + strings.Join(quoted, ",") + ") AND r.id>" + literal(after) + fmt.Sprintf(" ORDER BY r.id LIMIT %d", limit)
		})
		if err != nil {
			return nil, err
		}
		for _, row := range rows {
			metadata[row["id"].(string)] = row
		}
		if len(metadata) != len(ids) {
			return nil, fail(1, "search hit is absent from the selected publication")
		}
	}
	pages := []any{}
	for _, h := range hits {
		hit := h.(map[string]any)
		row := metadata[hit["id"].(string)]
		row["score"], row["excerpt"] = hit["score"], hit["excerpt"]
		pages = append(pages, row)
	}
	var next any
	if hasMore {
		next = o.Offset + len(pages)
	}
	return map[string]any{"space": publication["space"], "publication": pubID, "generation": generation, "pages": pages, "hasMore": hasMore, "nextOffset": next}, nil
}

var relationshipProperties = map[string]bool{"deployment_profiles": true, "applications": true, "resources": true, "credentials": true,
	"consumers": true, "replaces": true, "replaced_by": true, "members": true, "accountable_owners": true, "backup_owners": true,
	"documents": true, "destinations": true}

var targetCatalogs = map[string]string{"members": "person", "accountable_owners": "group", "backup_owners": "group",
	"documents": "repository_document", "destinations": "repository_destination"}

func decodeJSONField(v any) map[string]any {
	if s, ok := v.(string); ok {
		var m map[string]any
		if json.Unmarshal([]byte(s), &m) == nil {
			return m
		}
		return nil
	}
	m, _ := v.(map[string]any)
	return m
}

func stringList(v any) []string {
	items, _ := v.([]any)
	out := []string{}
	for _, item := range items {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

var needsVerification = regexp.MustCompile(`\[needs verification\]`)

// Lint checks the published graph's structure; semantic review remains agent work.
func (c *Client) Lint() (map[string]any, error) {
	space, err := c.SpaceID()
	if err != nil {
		return nil, err
	}
	findings := []any{}
	publication, err := c.selectPublication("", 0)
	if err != nil {
		return nil, err
	}
	if publication == nil {
		return map[string]any{"space": space, "publication": nil, "findings": findings}, nil
	}
	validation, err := c.validateManifest(publication)
	if err != nil {
		return nil, err
	}
	pubID := publication["id"].(string)
	join, where := manifestJoin(pubID), "pub.id="+literal(pubID)
	pages, err := c.batches(func(after string, limit int) string {
		return "SELECT r.*, p.slug, p.kind " + join + "WHERE " + where + " AND r.archived=0 AND r.id>" + literal(after) + fmt.Sprintf(" ORDER BY r.id LIMIT %d", limit)
	})
	if err != nil {
		return nil, err
	}
	if active, _ := asInt(validation["active"]); int(active) != len(pages) {
		return nil, fail(1, "incomplete publication")
	}
	relations := func(table, column string) ([]map[string]any, error) {
		return c.batches(func(after string, limit int) string {
			return "SELECT rel.id, rel.page_revision, rel." + column + " " + join + "JOIN " + table + " rel ON rel.page_revision=r.id WHERE " + where +
				" AND r.archived=0 AND rel.id>" + literal(after) + fmt.Sprintf(" ORDER BY rel.id LIMIT %d", limit)
		})
	}
	links, err := relations("page_links", "target")
	if err != nil {
		return nil, err
	}
	citations, err := relations("citations", "marker")
	if err != nil {
		return nil, err
	}
	linksBy := map[string][]string{}
	for _, l := range links {
		linksBy[l["page_revision"].(string)] = append(linksBy[l["page_revision"].(string)], fmt.Sprint(l["target"]))
	}
	cited := map[string]map[string]bool{}
	for _, ci := range citations {
		rev := ci["page_revision"].(string)
		if cited[rev] == nil {
			cited[rev] = map[string]bool{}
		}
		cited[rev][fmt.Sprint(ci["marker"])] = true
	}
	incoming := map[string]int{}
	catalogs := map[string]any{}
	for _, p := range pages {
		incoming[p["page"].(string)] = 0
		catalogs[p["page"].(string)] = decodeJSONField(p["properties"])["catalog_type"]
	}
	for _, p := range pages {
		slug, rev := p["slug"], p["id"].(string)
		properties, evidence := decodeJSONField(p["properties"]), decodeJSONField(p["property_evidence"])
		targets := map[string]bool{}
		for _, t := range linksBy[rev] {
			targets[t] = true
		}
		keys := make([]string, 0, len(properties))
		for k := range properties {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		extra := []string{}
		for _, key := range keys {
			if !relationshipProperties[key] {
				continue
			}
			for _, target := range stringList(properties[key]) {
				if want, ok := targetCatalogs[key]; ok {
					if got, known := catalogs[target]; known && got != want {
						findings = append(findings, map[string]any{"page": slug, "kind": "invalid-property-target", "property": key, "target": target})
					}
				}
				if !targets[target] {
					targets[target] = true
					extra = append(extra, target)
				}
			}
		}
		for key, markers := range evidence {
			for _, marker := range stringList(markers) {
				if !cited[rev][marker] {
					findings = append(findings, map[string]any{"page": slug, "kind": "missing-property-citation", "property": key, "marker": marker})
				}
			}
		}
		for _, target := range append(linksBy[rev], extra...) {
			if _, ok := incoming[target]; !ok {
				findings = append(findings, map[string]any{"page": slug, "kind": "broken-link", "target": target})
			} else {
				incoming[target]++
			}
		}
		if body, _ := p["body"].(string); needsVerification.MatchString(body) {
			findings = append(findings, map[string]any{"page": slug, "kind": "needs-verification"})
		}
		if len(cited[rev]) == 0 {
			findings = append(findings, map[string]any{"page": slug, "kind": "no-citations"})
		}
	}
	for _, p := range pages {
		if incoming[p["page"].(string)] == 0 {
			findings = append(findings, map[string]any{"page": p["slug"], "kind": "orphan"})
		}
	}
	return map[string]any{"space": space, "publication": pubID, "findings": findings,
		"semantic_review": "Contradictions, claim support and outdated evidence require agent review of source passages."}, nil
}

// HomeFields captures an explicit staging home choice; publishing never refreshes its base.
func (c *Client) HomeFields(command, runID, home string, clearHome bool, homeBase *string) (map[string]any, error) {
	changing := home != "" || clearHome
	if homeBase != nil && !changing {
		return nil, fail(2, "--home-base requires --home or --clear-home")
	}
	if !changing {
		return map[string]any{}, nil
	}
	if homeBase != nil && *homeBase != "" && !idPattern.MatchString(*homeBase) {
		return nil, fail(2, "--home-base must be a page ID or an empty string")
	}
	if command == "publish" && homeBase == nil {
		return nil, fail(2, "publish home changes require explicit --home-base; use stage-home to capture the expected home earlier")
	}
	if home != "" && !regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`).MatchString(home) {
		return nil, fail(2, "--home must be a page slug")
	}
	var base string
	runs, err := c.Rows("SELECT space, home, clear_home FROM ingestion_runs WHERE id = " + literal(runID) + " LIMIT 1")
	if err != nil {
		return nil, err
	}
	if len(runs) == 0 {
		return nil, fail(1, "staging run not found")
	}
	space, _ := runs[0]["space"].(string)
	if !idPattern.MatchString(space) {
		return nil, fail(1, "staging run has an invalid space")
	}
	if homeBase == nil {
		staged, _ := runs[0]["home"].(string)
		clear, _ := asInt(runs[0]["clear_home"])
		if staged != "" || clear != 0 {
			return nil, fail(2, "run already has a staged home choice; preserve it with publish, or reassess and supply explicit --home-base")
		}
		publications, err := c.Rows("SELECT home FROM publications WHERE space = " + literal(space) + " ORDER BY sequence DESC LIMIT 1")
		if err != nil {
			return nil, err
		}
		if len(publications) > 0 {
			base, _ = publications[0]["home"].(string)
		}
	} else {
		base = *homeBase
	}
	homeID := ""
	if home != "" {
		pages, err := c.Rows("SELECT id FROM pages WHERE slug = " + literal(home) + " AND space = " + literal(space) + " LIMIT 1")
		if err != nil {
			return nil, err
		}
		if len(pages) == 0 {
			return nil, fail(2, "home page slug not found: %s", home)
		}
		homeID = pages[0]["id"].(string)
	}
	return map[string]any{"home": homeID, "home_base": base, "clear_home": clearHome}, nil
}
