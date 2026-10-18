package client

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/textproto"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Text extensions accepted by the bundle. Everything else is rejected before
// upload: the bundle stores and extracts text notes only.
var textExtensions = map[string]string{
	".txt": "text/plain", ".md": "text/markdown", ".markdown": "text/markdown",
	".csv": "text/csv", ".json": "application/json", ".rst": "text/x-rst", ".log": "text/plain",
}

const (
	maxSource  = 100 << 20
	chunkRunes = 24000
	processor  = "utf-8 text / wikicontext-1"
)

var alnum = regexp.MustCompile(`^[a-z0-9]+$`)

type passage struct {
	Locator string
	Body    string
}

// pythonSpace mirrors Python's str.isspace, which decides empty chunks.
func pythonSpace(r rune) bool { return unicode.IsSpace(r) || (r >= 0x1c && r <= 0x1f) }

// chunks splits text into 24000-character passages, as the Python client did.
func chunks(text, locator string) []passage {
	runes := []rune(text)
	var out []passage
	for offset := 0; offset < len(runes); offset += chunkRunes {
		end := offset + chunkRunes
		if end > len(runes) {
			end = len(runes)
		}
		body := string(runes[offset:end])
		if strings.TrimFunc(body, pythonSpace) == "" {
			continue
		}
		out = append(out, passage{fmt.Sprintf("%s; characters %d-%d", locator, offset+1, end), body})
	}
	return out
}

// pyString encodes s like Python's json.dumps with ensure_ascii=True, so
// rendition manifests stay identical to those written by the Python client.
func pyString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		default:
			switch {
			case r < 0x20 || (r >= 0x7f && r < 0x10000 && r != 0x7f):
				fmt.Fprintf(&b, `\u%04x`, r)
			case r == 0x7f:
				b.WriteRune(r)
			case r >= 0x10000:
				r -= 0x10000
				fmt.Fprintf(&b, `\u%04x\u%04x`, 0xd800+(r>>10), 0xdc00+(r&0x3ff))
			default:
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}

// passagesDigest is sha256(json.dumps(passages, sort_keys=True)) in Python.
func passagesDigest(passages []passage) string {
	parts := make([]string, len(passages))
	for i, p := range passages {
		parts[i] = `{"body": ` + pyString(p.Body) + `, "locator": ` + pyString(p.Locator) + `}`
	}
	sum := sha256.Sum256([]byte("[" + strings.Join(parts, ", ") + "]"))
	return hex.EncodeToString(sum[:])
}

func manifest(passages []passage) string {
	return fmt.Sprintf(`{"passages": %d, "sha256": "%s"}`, len(passages), passagesDigest(passages))
}

// Ingest stores one immutable text source and its evidence passages.
func (c *Client) Ingest(path, title, version string) (map[string]any, error) {
	if version == "" || utf8.RuneCountInString(version) > 100 {
		return nil, fail(2, "rendition version must contain 1–100 characters")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(abs)
	if err != nil || !info.Mode().IsRegular() {
		return nil, fail(2, "source must be a regular file")
	}
	suffix := strings.ToLower(filepath.Ext(abs))
	media, ok := textExtensions[suffix]
	if suffix == "" {
		media, ok = "application/octet-stream", true
	}
	if !ok {
		names := make([]string, 0, len(textExtensions))
		for ext := range textExtensions {
			names = append(names, ext)
		}
		sort.Strings(names)
		return nil, fail(2, "unsupported source type %s: this WikiContext accepts UTF-8 text notes only (%s); nothing was uploaded", suffix, strings.Join(names, " "))
	}
	if info.Size() > maxSource {
		return nil, fail(2, "source must be no larger than 100 MiB")
	}
	content, err := os.ReadFile(abs)
	if err != nil {
		return nil, fail(2, "cannot read source: %v", err)
	}
	if len(content) == 0 || bytes.HasPrefix(content, []byte("version https://git-lfs.github.com/spec/v1\n")) {
		return nil, fail(2, "source is empty or a Git LFS pointer; retrieve actual source bytes first")
	}
	text := strings.TrimPrefix(string(content), "\ufeff")
	if !utf8.ValidString(text) {
		return nil, fail(2, "text source is not UTF-8; convert it to UTF-8 first")
	}
	passages := chunks(text, "document")
	if len(passages) == 0 {
		return nil, fail(2, "source contains no text")
	}
	sum := sha256.Sum256(content)
	digest := hex.EncodeToString(sum[:])
	space, err := c.SpaceID()
	if err != nil {
		return nil, err
	}
	// Deduplication is per space: the same bytes in another space are a separate source.
	findSource := "SELECT id, sha256 FROM sources WHERE sha256 = " + literal(digest) + " AND space = " + literal(space) + " LIMIT 1"
	found, err := c.Rows(findSource)
	if err != nil {
		return nil, err
	}
	var source map[string]any
	if len(found) > 0 {
		source = found[0]
	} else {
		if title == "" {
			title = strings.TrimSuffix(filepath.Base(abs), filepath.Ext(abs))
		}
		uploadName := digest + suffix
		if !alnum.MatchString(strings.TrimPrefix(suffix, ".")) {
			uploadName = digest + ".bin"
		}
		source, err = c.upload(map[string]string{"space": space, "title": title, "original_name": filepath.Base(abs), "media_type": media}, uploadName, content)
		if err != nil {
			// A lost response can already have persisted this exact original.
			if again, qerr := c.Rows(findSource); qerr == nil && len(again) > 0 {
				source = again[0]
			} else {
				return nil, err
			}
		}
	}
	if source["sha256"] != digest {
		return nil, fail(1, "server original checksum differs; stop and investigate before extraction")
	}
	sourceID, _ := source["id"].(string)
	expectedManifest := manifest(passages)
	result := map[string]any{"space": space, "source": sourceID, "passages": len(passages), "sha256": digest,
		"status": "extracted", "next": "Synthesize cited page revisions in a staging ingestion run, then publish."}

	findRendition := "SELECT id, notes FROM renditions WHERE source = " + literal(sourceID) + " AND kind = 'text' AND version_label = " + literal(version) + " LIMIT 1"
	existing, err := c.Rows(findRendition)
	if err != nil {
		return nil, err
	}
	var rendition map[string]any
	if len(existing) == 0 {
		data, err := c.Must("POST", records("renditions"), map[string]any{"source": sourceID, "kind": "text", "processor": processor, "version_label": version, "notes": expectedManifest})
		if err != nil {
			again, qerr := c.Rows(findRendition)
			if qerr != nil || len(again) == 0 {
				return nil, err
			}
			rendition = again[0]
		} else {
			rendition, _ = data.(map[string]any)
		}
	} else {
		rendition = existing[0]
	}
	if notes, _ := rendition["notes"].(string); notes != expectedManifest {
		var previous, expected any
		if json.Unmarshal([]byte(notes), &previous) != nil || json.Unmarshal([]byte(expectedManifest), &expected) != nil || fmt.Sprint(previous) != fmt.Sprint(expected) {
			return nil, fail(4, "existing rendition has different extracted content; preserve it and select a new --version")
		}
	}
	renditionID, _ := rendition["id"].(string)
	result["rendition"] = renditionID
	for i, p := range passages {
		ordinal := i + 1
		query := fmt.Sprintf("SELECT id, locator, body FROM passages WHERE rendition = %s AND ordinal = %d LIMIT 1", literal(renditionID), ordinal)
		previous, err := c.Rows(query)
		if err != nil {
			return nil, err
		}
		if len(previous) == 0 {
			_, err := c.Must("POST", records("passages"), map[string]any{"rendition": renditionID, "ordinal": ordinal, "locator": p.Locator, "body": p.Body})
			if err == nil {
				continue
			}
			if previous, _ = c.Rows(query); len(previous) == 0 {
				return nil, err
			}
		}
		if previous[0]["locator"] != p.Locator || previous[0]["body"] != p.Body {
			return nil, fail(4, "existing passage differs from extraction; select a new rendition version")
		}
	}
	return result, nil
}

func (c *Client) upload(fields map[string]string, filename string, content []byte) (map[string]any, error) {
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	keys := make([]string, 0, len(fields))
	for k := range fields {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		_ = w.WriteField(k, fields[k])
	}
	header := textproto.MIMEHeader{}
	// The filename is generated locally, never an unsanitized source label.
	header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="original"; filename="%s"`, filename))
	header.Set("Content-Type", "application/octet-stream")
	part, err := w.CreatePart(header)
	if err != nil {
		return nil, err
	}
	part.Write(content)
	w.Close()
	c.LongTimeout = 3 * time.Minute
	defer func() { c.LongTimeout = 0 }()
	status, data, err := c.send("POST", records("sources"), nil, nil, w.FormDataContentType(), body.Bytes())
	if err != nil {
		return nil, err
	}
	out, err := checked("POST", records("sources"), status, data)
	if err != nil {
		return nil, err
	}
	record, _ := out.(map[string]any)
	return record, nil
}
