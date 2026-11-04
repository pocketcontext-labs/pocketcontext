package client

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
)

func mcpOriginal(c *Client, a mcpSource) (any, error) {
	if !idPattern.MatchString(a.Source) {
		return nil, errors.New("invalid source ID")
	}
	space, err := c.SpaceID()
	if err != nil {
		return nil, err
	}
	rows, err := c.Rows("SELECT id,sha256,media_type,original,original_name FROM sources WHERE id=" + literal(a.Source) + " AND space=" + literal(space) + " LIMIT 1")
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, errors.New("source not found in selected space")
	}
	source := rows[0]
	name, _ := source["original"].(string)
	if name == "" {
		return nil, errors.New("source has no stored original")
	}
	tokenResult, err := c.Must("POST", "/api/files/token", nil)
	if err != nil {
		return nil, err
	}
	token, _ := dig(tokenResult, "token").(string)
	if token == "" {
		return nil, errors.New("server returned no file token")
	}
	content, err := c.download("/api/files/sources/" + a.Source + "/" + url.PathEscape(name) + "?token=" + url.QueryEscape(token))
	if err != nil {
		return nil, err
	}
	if len(content) > mcpFileLimit {
		return nil, errors.New("original exceeds 4 MiB MCP limit; use the authenticated reader or CLI")
	}
	hash := sha256.Sum256(content)
	digest := hex.EncodeToString(hash[:])
	if digest != source["sha256"] {
		return nil, errors.New("original checksum differs from source record")
	}
	return map[string]any{"source": a.Source, "sha256": digest, "media_type": source["media_type"], "filename": source["original_name"], "bytes": len(content), "content_base64": base64.StdEncoding.EncodeToString(content), "url": c.Base + "/#/sources/" + a.Source + "?space=" + url.QueryEscape(space)}, nil
}

func mcpReadPassages(c *Client, a mcpPassages) (any, error) {
	if !idPattern.MatchString(a.Source) {
		return nil, errors.New("invalid source ID")
	}
	if a.Limit == 0 {
		a.Limit = 20
	}
	if a.Limit < 1 || a.Limit > 100 || a.After < 0 || len(a.Version) > 100 {
		return nil, errors.New("limit must be 1-100, after nonnegative, version at most 100 bytes")
	}
	space, err := c.SpaceID()
	if err != nil {
		return nil, err
	}
	rows, err := c.Rows("SELECT id FROM sources WHERE id=" + literal(a.Source) + " AND space=" + literal(space) + " LIMIT 1")
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, errors.New("source not found in selected space")
	}
	all, err := c.Rows("SELECT id,kind,version_label,notes FROM renditions WHERE source=" + literal(a.Source) + " AND kind IN ('text','agent-text') ORDER BY created,id LIMIT 1000")
	if err != nil {
		return nil, err
	}
	var text, agent []map[string]any
	for _, r := range all {
		if r["kind"] == "text" {
			text = append(text, r)
		} else {
			agent = append(agent, r)
		}
	}
	pick := preferredRendition(text)
	if pick < 0 && len(agent) > 0 {
		pick = len(text) + len(agent) - 1
	}
	all = append(text, agent...)
	if a.Version != "" {
		pick = -1
		for i := len(all) - 1; i >= 0; i-- {
			if all[i]["version_label"] == a.Version {
				pick = i
			}
		}
	}
	if pick < 0 {
		return nil, errors.New("no matching rendition; convert a non-text original on the client and submit extract first")
	}
	rendition := all[pick]
	id := fmt.Sprint(rendition["id"])
	passages, err := c.Rows(fmt.Sprintf("SELECT id,ordinal,locator,body FROM passages WHERE rendition=%s AND ordinal>%d ORDER BY ordinal LIMIT %d", literal(id), a.After, a.Limit+1))
	if err != nil {
		return nil, err
	}
	more := len(passages) > a.Limit
	if more {
		passages = passages[:a.Limit]
	}
	after := int64(a.After)
	for _, p := range passages {
		after, _ = asInt(p["ordinal"])
		p["url"] = c.Base + "/#/passages/" + fmt.Sprint(p["id"]) + "?space=" + url.QueryEscape(space)
	}
	var expected struct {
		Passages *int `json:"passages"`
	}
	notes, _ := rendition["notes"].(string)
	_ = json.Unmarshal([]byte(notes), &expected)
	// Count separately: a paged response must not imply extraction is complete.
	counts, err := c.Rows("SELECT count(*) AS n FROM passages WHERE rendition=" + literal(id))
	if err != nil {
		return nil, err
	}
	var total int64
	if len(counts) > 0 {
		total, _ = asInt(counts[0]["n"])
	}
	complete := expected.Passages != nil && total == int64(*expected.Passages)
	return map[string]any{"source": a.Source, "rendition": id, "version": rendition["version_label"], "derived": rendition["kind"] == "agent-text", "passages": passages, "has_more": more, "next_after": after, "total_passages": total, "expected_passages": expected.Passages, "extraction_complete": complete}, nil
}
