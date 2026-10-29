package client

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/pocketcontext-labs/pocketcontext/internal/bundle"
)

// Files that are not text are converted by the user's agent, never by the
// binary. `extract` records that UTF-8 text as an agent-text rendition: derived
// evidence split like a v3 text rendition, not an exact copy of the original.

const (
	kindAgent      = "agent-text"
	processorAgent = "agent text / pocketcontext-3 structure"
	defaultAgent   = "agent-1"
	toolRunes      = 300
	conversionRune = 2000
	notesBytes     = 10000
)

var sha256Pattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// ExtractOptions are the extract flags; Version defaults to agent-1.
type ExtractOptions struct {
	Text, Tool, Version, OriginalSHA256, Conversion string
	VersionSet, OriginalSet, ConversionSet          bool
}

// agentNotes is the agent-text rendition manifest: the passage digest of a
// text rendition plus the converted text's hash and its provenance.
func agentNotes(passages []passage, textSHA string, o ExtractOptions) string {
	notes := map[string]any{"passages": len(passages), "sha256": passagesDigest(passages), "text_sha256": textSHA, "tool": o.Tool, "derived": true}
	if o.OriginalSet {
		notes["original_sha256"] = o.OriginalSHA256
	}
	if o.ConversionSet {
		notes["conversion"] = o.Conversion
	}
	var b bytes.Buffer
	encoder := json.NewEncoder(&b)
	encoder.SetEscapeHTML(false)
	encoder.Encode(notes)
	return strings.TrimSuffix(b.String(), "\n")
}

// Extract records the agent's UTF-8 conversion of a source that is not text
// as an agent-text rendition, resuming it like ingest resumes text renditions.
func (c *Client) Extract(sourceID string, o ExtractOptions) (map[string]any, error) {
	if !idPattern.MatchString(sourceID) {
		return nil, fail(2, "source ID must be 15 lowercase letters or digits; list sources awaiting extraction with `pocketcontext pending`")
	}
	if o.Text == "" {
		return nil, fail(2, "--text FILE is required: the UTF-8 text or Markdown converted from the original")
	}
	if n := utf8.RuneCountInString(o.Tool); n < 1 || n > toolRunes || strings.ContainsAny(o.Tool, "\r\n") {
		return nil, fail(2, "--tool must be one line of 1–300 characters naming how the text was produced, e.g. \"claude-opus-5-5 read the PDF\"")
	}
	version := defaultAgent
	if o.VersionSet {
		if version = o.Version; version == "" || utf8.RuneCountInString(version) > 100 {
			return nil, fail(2, "rendition version must contain 1–100 characters")
		}
	}
	if o.OriginalSet && !sha256Pattern.MatchString(o.OriginalSHA256) {
		return nil, fail(2, "--original-sha256 must be 64 lowercase hexadecimal characters")
	}
	if o.ConversionSet && (o.Conversion == "" || utf8.RuneCountInString(o.Conversion) > conversionRune) {
		return nil, fail(2, "--conversion must contain 1–2000 characters")
	}
	abs, err := filepath.Abs(o.Text)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(abs)
	if err != nil || !info.Mode().IsRegular() {
		return nil, fail(2, "--text must be a regular file")
	}
	if info.Size() > maxSource {
		return nil, fail(2, "--text file must be no larger than 100 MiB")
	}
	content, err := os.ReadFile(abs)
	if err != nil {
		return nil, fail(2, "cannot read --text file: %v", err)
	}
	text := strings.TrimPrefix(string(content), "\ufeff")
	if !utf8.ValidString(text) {
		return nil, fail(2, "--text file is not UTF-8; convert it to UTF-8 first")
	}
	suffix := strings.ToLower(filepath.Ext(abs))
	markdown := suffix == ".md" || suffix == ".markdown"
	if len(content) == 0 || len(chunks(text, markdown)) == 0 {
		return nil, fail(2, "--text file contains no text")
	}
	sum := sha256.Sum256(content)
	textSHA := hex.EncodeToString(sum[:])
	if probe := agentNotes(nil, textSHA, o); len(probe) > notesBytes-100 {
		return nil, fail(2, "--tool and --conversion are too long for the rendition notes")
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
	texts, err := c.Rows("SELECT id FROM renditions WHERE source = " + literal(sourceID) + " AND kind = 'text' LIMIT 1")
	if err != nil {
		return nil, err
	}
	if len(texts) > 0 {
		return nil, fail(2, "source is a text source; ingest extracts it")
	}
	split := func(proc string) []passage { return splitFor(proc, text, markdown) }
	notes := func(ps []passage) string { return agentNotes(ps, textSHA, o) }
	rendition, passages, err := c.extraction(sourceID, kindAgent, processorAgent, version, split, notes)
	if err != nil {
		return nil, err
	}
	return map[string]any{"space": space, "source": sourceID, "rendition": rendition["id"], "version": version, "passages": len(passages),
		"status": "extracted", "derived": true, "next": nextSynthesize}, nil
}

// Pending lists the sources of the selected space without any rendition,
// newest first: originals that wait for the agent to convert them.
func (c *Client) Pending(limit int) (map[string]any, error) {
	if limit < 1 || limit > 500 {
		return nil, fail(2, "--limit must be 1-500")
	}
	space, err := c.SpaceID()
	if err != nil {
		return nil, err
	}
	rows, err := c.Rows(fmt.Sprintf("SELECT s.id, s.title, s.original_name, s.media_type, s.source_date, s.created FROM sources s "+
		"WHERE s.space = %s AND NOT EXISTS (SELECT 1 FROM renditions r WHERE r.source = s.id) ORDER BY s.created DESC, s.id DESC LIMIT %d", literal(space), limit+1))
	if err != nil {
		return nil, err
	}
	truncated := len(rows) > limit
	if truncated {
		rows = rows[:limit]
	}
	return map[string]any{"space": space, "sources": rows, "truncated": truncated}, nil
}

// Original downloads the protected original of one source in the selected
// space, verifies it against the source's SHA-256 and writes it atomically to
// a new file.
func (c *Client) Original(sourceID, out string) (map[string]any, error) {
	if !idPattern.MatchString(sourceID) {
		return nil, fail(2, "source ID must be 15 lowercase letters or digits; list sources awaiting extraction with `pocketcontext pending`")
	}
	if out == "" {
		return nil, fail(2, "--out FILE is required")
	}
	abs, err := filepath.Abs(out)
	if err != nil {
		return nil, err
	}
	if _, err := os.Lstat(abs); !errors.Is(err, os.ErrNotExist) {
		return nil, fail(2, "%s already exists; choose a new --out file", out)
	}
	space, err := c.SpaceID()
	if err != nil {
		return nil, err
	}
	found, err := c.Rows("SELECT id, sha256, media_type, original FROM sources WHERE id = " + literal(sourceID) + " AND space = " + literal(space) + " LIMIT 1")
	if err != nil {
		return nil, err
	}
	if len(found) == 0 {
		return nil, fail(1, "source %s not found in this space", sourceID)
	}
	source := found[0]
	name, _ := source["original"].(string)
	if name == "" {
		return nil, fail(1, "source %s has no stored original", sourceID)
	}
	data, err := c.Must("POST", "/api/files/token", nil)
	if err != nil {
		return nil, err
	}
	token, _ := dig(data, "token").(string)
	if token == "" {
		return nil, fail(1, "the server returned no file token")
	}
	content, err := c.download("/api/files/sources/" + url.PathEscape(sourceID) + "/" + url.PathEscape(name) + "?token=" + url.QueryEscape(token))
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(content)
	digest := hex.EncodeToString(sum[:])
	if digest != source["sha256"] {
		return nil, fail(1, "downloaded original checksum differs from the source record; nothing was written")
	}
	tmp, err := os.CreateTemp(filepath.Dir(abs), ".pocketcontext-original-*")
	if err != nil {
		return nil, fail(2, "cannot write %s: %v", out, err)
	}
	_, err = tmp.Write(content)
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		if _, serr := os.Lstat(abs); !errors.Is(serr, os.ErrNotExist) {
			err = fmt.Errorf("it was created meanwhile")
		} else {
			err = os.Rename(tmp.Name(), abs)
		}
	}
	if err != nil {
		os.Remove(tmp.Name())
		return nil, fail(2, "cannot write %s: %v", out, err)
	}
	return map[string]any{"source": sourceID, "sha256": digest, "media_type": source["media_type"], "bytes": len(content), "out": abs}, nil
}

// download reads one protected file, at most maxSource bytes.
func (c *Client) download(path string) ([]byte, error) {
	req, err := http.NewRequest("GET", c.Base+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "PocketContext/"+bundle.Version)
	if c.token != "" {
		req.Header.Set("Authorization", c.token)
	}
	client := *c.http
	client.Timeout = 3 * time.Minute
	resp, err := client.Do(req)
	if err != nil {
		return nil, fail(1, "cannot reach the PocketContext server at %s: %v", c.Base, err)
	}
	defer resp.Body.Close()
	if c.remote && resp.StatusCode == http.StatusUnauthorized {
		return nil, expired(c.Base)
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, fail(1, "HTTP %d from GET /api/files/sources: %s", resp.StatusCode, bytes.TrimSpace(body))
	}
	content, err := io.ReadAll(io.LimitReader(resp.Body, maxSource+1))
	if err != nil {
		return nil, fail(1, "reading the original: %v", err)
	}
	if len(content) > maxSource {
		return nil, fail(1, "the original is larger than 100 MiB")
	}
	return content, nil
}
