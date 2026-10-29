package client

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Reading one source's passages in bulk as plain text, so an agent can read
// every passage of a source without paging SQL results by hand.

const derivedMark = "derived: agent text"

// sourcePassage is one passage as `passages` prints it.
type sourcePassage struct {
	ordinal     int64
	id, locator string
	body        string
}

// SourcePassages is the rendition `passages` read and its passages in ordinal order.
type SourcePassages struct {
	Source, Rendition, Version string
	Derived                    bool // an agent-text rendition, not an exact copy of the original
	Expected                   int  // passage count from the rendition manifest, -1 when unknown
	passages                   []sourcePassage
}

// SourcePassages reads the passages of one source in the selected space, from
// the rendition ingest reuses (v3, else v2, else the newest) or the given version.
// A source without a text rendition reads its newest agent-text rendition.
func (c *Client) SourcePassages(sourceID, version string, versionSet bool) (*SourcePassages, error) {
	if !idPattern.MatchString(sourceID) {
		return nil, fail(2, "source ID must be 15 lowercase letters or digits; list sources with `pocketcontext sql \"SELECT id, title FROM sources ORDER BY created DESC LIMIT 20\"`")
	}
	if versionSet && (version == "" || len([]rune(version)) > 100) {
		return nil, fail(2, "rendition version must contain 1–100 characters")
	}
	space, err := c.SpaceID()
	if err != nil {
		return nil, err
	}
	found, err := c.Rows("SELECT id FROM sources WHERE id = " + literal(sourceID) + " AND space = " + literal(space) + " LIMIT 1")
	if err != nil {
		return nil, err
	}
	if len(found) == 0 {
		return nil, fail(1, "source %s not found in this space", sourceID)
	}
	all, err := c.Rows("SELECT id, kind, version_label, notes FROM renditions WHERE source = " + literal(sourceID) + " AND kind IN ('text', " + literal(kindAgent) + ") ORDER BY created, id LIMIT 1000")
	if err != nil {
		return nil, err
	}
	// Text renditions first, so a label shared with an agent-text one reads the text.
	var renditions, agent []map[string]any
	for _, r := range all {
		if r["kind"] == "text" {
			renditions = append(renditions, r)
		} else {
			agent = append(agent, r)
		}
	}
	pick := preferredRendition(renditions)
	if pick < 0 && len(agent) > 0 {
		pick = len(renditions) + len(agent) - 1
	}
	renditions = append(renditions, agent...)
	if versionSet {
		pick = -1
		for i := len(renditions) - 1; i >= 0; i-- {
			if renditions[i]["version_label"] == version {
				pick = i
			}
		}
	}
	if pick < 0 {
		var labels []string
		for _, r := range renditions {
			labels = append(labels, fmt.Sprint(r["version_label"]))
		}
		if len(labels) == 0 {
			return nil, fail(1, "source %s has no rendition; run `pocketcontext ingest PATH` for a text note, or convert the original and run `pocketcontext extract %s --text FILE --tool TOOL`", sourceID, sourceID)
		}
		return nil, fail(1, "source %s has no rendition %q (it has %s)", sourceID, version, strings.Join(labels, ", "))
	}
	r := renditions[pick]
	out := &SourcePassages{Source: sourceID, Rendition: fmt.Sprint(r["id"]), Version: fmt.Sprint(r["version_label"]), Derived: r["kind"] == kindAgent, Expected: -1}
	var manifest struct {
		Passages *int `json:"passages"`
	}
	if notes, _ := r["notes"].(string); json.Unmarshal([]byte(notes), &manifest) == nil && manifest.Passages != nil {
		out.Expected = *manifest.Passages
	}

	// Bounded pages in ordinal order; a page the server would truncate is halved.
	after, limit := int64(0), batchSize
	for {
		rows, err := c.Rows(fmt.Sprintf("SELECT id, ordinal, locator, body FROM passages WHERE rendition = %s AND ordinal > %d ORDER BY ordinal LIMIT %d",
			literal(out.Rendition), after, limit))
		if err != nil {
			if limit > 1 && (strings.Contains(err.Error(), "truncated") || strings.Contains(err.Error(), "HTTP 413")) {
				limit = max(1, limit/2)
				continue
			}
			return nil, err
		}
		if len(rows) == 0 {
			return out, nil
		}
		for _, row := range rows {
			ordinal, ok := asInt(row["ordinal"])
			if !ok || ordinal <= after {
				return nil, fail(1, "invalid passage pagination")
			}
			after = ordinal
			locator, _ := row["locator"].(string)
			body, _ := row["body"].(string)
			out.passages = append(out.passages, sourcePassage{ordinal, fmt.Sprint(row["id"]), locator, body})
		}
	}
}

// Text renders the passages: a header line `=== ORDINAL · PASSAGE_ID · LOCATOR`
// before each body, a blank line between passages, LF line endings throughout.
// Headers of agent-text passages end in ` · derived: agent text`.
func (s *SourcePassages) Text() string {
	var b strings.Builder
	mark := ""
	if s.Derived {
		mark = " · " + derivedMark
	}
	for i, p := range s.passages {
		if i > 0 {
			b.WriteString("\n")
		}
		fmt.Fprintf(&b, "=== %d · %s · %s%s\n", p.ordinal, p.id, p.locator, mark)
		body := strings.ReplaceAll(strings.ReplaceAll(p.body, "\r\n", "\n"), "\r", "\n")
		b.WriteString(strings.TrimRight(body, "\n"))
		b.WriteString("\n")
	}
	return b.String()
}

// Count is the number of passages read.
func (s *SourcePassages) Count() int { return len(s.passages) }

// writePassages prints the passages, or writes them to a file and prints a summary.
func writePassages(s *SourcePassages, out string, pretty bool) error {
	if s.Expected >= 0 && s.Count() < s.Expected {
		again := "`pocketcontext ingest PATH`"
		if s.Derived {
			again = "`pocketcontext extract " + s.Source + "` with the same --text, --tool and --version"
		}
		fmt.Fprintf(os.Stderr, "WARNING: rendition %s holds %d of %d passages; extraction is incomplete, rerun %s for this source\n",
			s.Rendition, s.Count(), s.Expected, again)
	}
	if out == "" {
		_, err := os.Stdout.WriteString(s.Text())
		return err
	}
	abs, err := filepath.Abs(out)
	if err != nil {
		return err
	}
	if err := os.WriteFile(abs, []byte(s.Text()), 0644); err != nil {
		return fail(2, "cannot write %s: %v", out, err)
	}
	summary := map[string]any{"source": s.Source, "rendition": s.Rendition, "version": s.Version, "passages": s.Count(), "file": abs}
	if s.Derived {
		summary["derived"] = true
	}
	Print(summary, pretty)
	return nil
}
