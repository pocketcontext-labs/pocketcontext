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
	"strconv"
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
	maxSource = 100 << 20
	// The default rendition version. Version labels are free text; the splitter
	// is chosen by the rendition's processor, so v1 renditions stay valid.
	defaultVersion = "v2"
	processor      = "utf-8 text / pocketcontext-2 structure"
	processorV1    = "utf-8 text / pocketcontext-1"
	chunkRunes     = 24000 // v1 fixed cut
	passageRunes   = 4000  // v2 upper bound, far below the server's 30,000
	locatorRunes   = 500
	titleRunes     = 500
	dateRunes      = 100
)

var alnum = regexp.MustCompile(`^[a-z0-9]+$`)

type passage struct {
	Locator string
	Body    string
}

// pythonSpace mirrors Python's str.isspace, which decides empty chunks.
func pythonSpace(r rune) bool { return unicode.IsSpace(r) || (r >= 0x1c && r <= 0x1f) }

// chunksV1 splits text into 24000-character passages, as the Python client did.
// It is kept byte for byte so v1 renditions can still be verified and resumed.
func chunksV1(text, locator string) []passage {
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

// splitFor returns the passages a rendition with this processor holds.
func splitFor(proc, text string, markdown bool) []passage {
	if proc == processorV1 {
		return chunksV1(text, "document")
	}
	return chunks(text, markdown)
}

var (
	headingLine = regexp.MustCompile(`^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$`)
	closingHash = regexp.MustCompile(`(?:^|[ \t]+)#+$`)
	fenceLine   = regexp.MustCompile("^ {0,3}(```|~~~)")
	fmKey       = regexp.MustCompile(`^([A-Za-z_][A-Za-z0-9_-]*)[ \t]*:(.*)$`)
)

func splitLines(text string) []string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	return strings.Split(strings.ReplaceAll(text, "\r", "\n"), "\n")
}

func blank(s string) bool { return strings.TrimFunc(s, pythonSpace) == "" }

func runes(s string) int { return utf8.RuneCountInString(s) }

// frontMatterEnd returns the number of lines in a leading `---` block, or 0.
func frontMatterEnd(lines []string) int {
	if len(lines) < 2 || strings.TrimRight(lines[0], " \t") != "---" {
		return 0
	}
	seenKey := false
	for i := 1; i < len(lines); i++ {
		l := strings.TrimRight(lines[i], " \t")
		if l == "---" || l == "..." {
			if seenKey {
				return i + 1
			}
			return 0
		}
		if !seenKey && !blank(l) {
			if !fmKey.MatchString(l) {
				return 0
			}
			seenKey = true
		}
	}
	return 0
}

// frontMatter reads top-level scalar `key: value` lines. It is not YAML:
// lists, maps and block scalars are skipped, quotes are removed.
func frontMatter(lines []string) map[string]string {
	out := map[string]string{}
	end := frontMatterEnd(lines)
	for _, l := range lines[min(1, end):max(end-1, 0)] {
		m := fmKey.FindStringSubmatch(l)
		if m == nil {
			continue
		}
		key := strings.ToLower(m[1])
		if _, seen := out[key]; seen {
			continue
		}
		if v := scalar(m[2]); v != "" {
			out[key] = v
		}
	}
	return out
}

func scalar(v string) string {
	v = strings.TrimSpace(v)
	if v == "" {
		return ""
	}
	switch v[0] {
	case '"':
		for i := 1; i < len(v); i++ {
			if v[i] == '\\' {
				i++
			} else if v[i] == '"' {
				if s, err := strconv.Unquote(v[:i+1]); err == nil {
					return strings.TrimSpace(s)
				}
				return strings.TrimSpace(v[1:i])
			}
		}
		return ""
	case '\'':
		for i := 1; i < len(v); i++ {
			if v[i] == '\'' {
				if i+1 < len(v) && v[i+1] == '\'' {
					i++
					continue
				}
				return strings.TrimSpace(strings.ReplaceAll(v[1:i], "''", "'"))
			}
		}
		return ""
	case '[', '{', '|', '>', '&', '*', '!', '#':
		return ""
	}
	if i := strings.Index(v, " #"); i >= 0 {
		v = v[:i]
	}
	return strings.TrimSpace(v)
}

type section struct {
	path     []string
	level    int
	from, to int // line indices, to exclusive
	empty    bool
	size     int
}

// chunks splits text by structure for v2 renditions: Markdown front matter and
// headings first (outside code fences), then blank-line paragraphs, then lines,
// then a hard cut, each passage at most passageRunes characters. Locators name
// the heading path and the 1-based line range of the original text.
func chunks(text string, markdown bool) []passage {
	lines := splitLines(text)
	var out []passage
	start := 0
	if markdown {
		if end := frontMatterEnd(lines); end > 0 {
			out = splitBlock(out, lines, nil, "front matter", 0, end)
			start = end
		}
	}
	var secs []section
	var stack []section
	cur := section{from: start}
	fenced := false
	for i := start; markdown && i < len(lines); i++ {
		if fenceLine.MatchString(lines[i]) {
			fenced = !fenced
			continue
		}
		m := headingLine.FindStringSubmatch(lines[i])
		if fenced || m == nil {
			continue
		}
		cur.to = i
		secs = append(secs, cur)
		level := len(m[1])
		title := strings.TrimSpace(closingHash.ReplaceAllString(m[2], ""))
		for len(stack) > 0 && stack[len(stack)-1].level >= level {
			stack = stack[:len(stack)-1]
		}
		label := strings.TrimSpace(m[1] + " " + strings.Join(strings.Fields(title), " "))
		path := append(append([]string{}, pathOf(stack)...), label)
		cur = section{path: path, level: level, from: i}
		stack = append(stack, cur)
	}
	cur.to = len(lines)
	secs = append(secs, cur)
	var live []section
	for _, s := range secs {
		body := s.from
		if s.level > 0 {
			body++
		}
		s.empty = true
		for _, l := range lines[body:s.to] {
			if !blank(l) {
				s.empty = false
				break
			}
		}
		if s.level == 0 && s.empty {
			continue // blank preamble
		}
		s.size = runes(strings.Join(lines[s.from:s.to], "\n"))
		live = append(live, s)
	}
	carry := -1 // first line of empty headings folded into the next group
	for i := 0; i < len(live); {
		g, size, j := live[i], live[i].size, i+1
		for j < len(live) && descends(live[j], g) && size+1+live[j].size <= passageRunes {
			size += 1 + live[j].size
			j++
		}
		empty := true
		for _, sec := range live[i:j] {
			empty = empty && sec.empty
		}
		if empty && j < len(live) {
			if carry < 0 {
				carry = g.from
			}
			i = j
			continue
		}
		// The locator names the deepest heading path shared by the sections
		// with text; empty headings only lead into them.
		path, first := g.path, true
		for _, sec := range live[i:j] {
			if sec.empty {
				continue
			}
			if first {
				path, first = sec.path, false
			}
			for k := 0; k < len(path); k++ {
				if k >= len(sec.path) || sec.path[k] != path[k] {
					path = path[:k]
					break
				}
			}
		}
		from := g.from
		if carry >= 0 {
			from, carry = carry, -1
		}
		out = splitBlock(out, lines, path, "", from, live[j-1].to)
		i = j
	}
	return out
}

func pathOf(stack []section) []string {
	if len(stack) == 0 {
		return nil
	}
	return stack[len(stack)-1].path
}

func descends(s, parent section) bool {
	return parent.level > 0 && s.level > parent.level && s.from >= parent.from && hasPrefix(s.path, parent.path)
}

func hasPrefix(path, prefix []string) bool {
	if len(prefix) > len(path) {
		return false
	}
	for i := range prefix {
		if path[i] != prefix[i] {
			return false
		}
	}
	return true
}

// locator formats "PATH; SPAN", shortening the path from the front so it
// fits the server's 500-character limit.
func locator(path []string, name, lines string) string {
	if name == "" {
		name = "document"
		if len(path) > 0 {
			name = strings.Join(path, " > ")
		}
	}
	for cut := 1; runes(name+"; "+lines) > locatorRunes && cut < len(path); cut++ {
		name = "… > " + strings.Join(path[cut:], " > ")
	}
	if over := runes(name+"; "+lines) - locatorRunes; over > 0 {
		r := []rune(name)
		name = string(r[:len(r)-over-1]) + "…"
	}
	return name + "; " + lines
}

// splitBlock emits lines[from:to] as one passage, or as paragraph, line and
// character pieces of roughly equal size when it is too long.
func splitBlock(out []passage, lines []string, path []string, name string, from, to int) []passage {
	for from < to && blank(lines[from]) {
		from++
	}
	for to > from && blank(lines[to-1]) {
		to--
	}
	if from == to {
		return out
	}
	body := strings.Join(lines[from:to], "\n")
	size := runes(body)
	if size <= passageRunes {
		span := fmt.Sprintf("lines %d-%d", from+1, to)
		if from+1 == to {
			span = fmt.Sprintf("line %d", to)
		}
		return append(out, passage{locator(path, name, span), body})
	}
	// Paragraphs: runs of lines separated by blank lines outside code fences.
	var paras [][2]int
	fenced, p := false, from
	for i := from; i <= to; i++ {
		if i == to || (!fenced && blank(lines[i])) {
			if p < i {
				paras = append(paras, [2]int{p, i})
			}
			p = i + 1
			continue
		}
		if fenceLine.MatchString(lines[i]) {
			fenced = !fenced
		}
	}
	if len(paras) == 1 {
		// One paragraph: split by lines, then cut single long lines.
		paras = paras[:0]
		for i := from; i < to; i++ {
			paras = append(paras, [2]int{i, i + 1})
		}
		if len(paras) == 1 {
			return cutLine(out, lines, path, name, from, from)
		}
	}
	target := size / ((size + passageRunes - 1) / passageRunes)
	gFrom := -1
	for _, pr := range paras {
		n := runes(strings.Join(lines[pr[0]:pr[1]], "\n"))
		single := pr[1]-pr[0] == 1
		if gFrom >= 0 && n > passageRunes && single && runes(strings.Join(lines[gFrom:pr[0]], "\n")) <= passageRunes/4 {
			// A short lead-in such as a heading joins the first cut of a long line.
			out = cutLine(out, lines, path, name, gFrom, pr[0])
			gFrom = -1
			continue
		}
		if gFrom >= 0 {
			// Measure the joined text itself, so a group never exceeds the bound.
			had, with := runes(strings.Join(lines[gFrom:pr[0]], "\n")), runes(strings.Join(lines[gFrom:pr[1]], "\n"))
			if had >= target || with > passageRunes {
				out = splitBlock(out, lines, path, name, gFrom, pr[0])
				gFrom = -1
			}
		}
		if n > passageRunes && single {
			out = cutLine(out, lines, path, name, pr[0], pr[0])
			continue
		} else if n > passageRunes {
			out = splitBlock(out, lines, path, name, pr[0], pr[1])
			continue
		}
		if gFrom < 0 {
			gFrom = pr[0]
		}
	}
	if gFrom >= 0 {
		out = splitBlock(out, lines, path, name, gFrom, to)
	}
	return out
}

// cutLine hard-cuts line n, preferring whitespace near the limit. Lines from
// head to n join the first piece; character ranges count within line n.
func cutLine(out []passage, lines []string, path []string, name string, head, n int) []passage {
	prefix := ""
	if head < n {
		prefix = strings.Join(lines[head:n], "\n") + "\n"
	}
	r := []rune(lines[n])
	for at := 0; at < len(r); {
		limit := passageRunes - runes(prefix)
		end := at + limit
		if end >= len(r) {
			end = len(r)
		} else {
			for k := end; k > at+limit/2; k-- {
				if unicode.IsSpace(r[k-1]) {
					end = k
					break
				}
			}
		}
		span := fmt.Sprintf("line %d, characters %d-%d", n+1, at+1, end)
		if prefix != "" {
			span = fmt.Sprintf("lines %d-%d, characters %d-%d of line %d", head+1, n+1, at+1, end, n+1)
		}
		if piece := prefix + string(r[at:end]); !blank(piece) {
			out = append(out, passage{locator(path, name, span), piece})
		}
		at, prefix = end, ""
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

// IngestOptions are the optional ingest flags. An empty Version selects an
// existing text rendition of the source (v2 first) or creates v2. DateSet
// distinguishes an explicit empty --date from no --date.
type IngestOptions struct {
	Title, Date, Version string
	VersionSet, DateSet  bool
}

// Ingest stores one immutable text source and its evidence passages.
//
// Compatibility: v1 renditions (processor pocketcontext-1) hold fixed
// 24,000-character passages and stay valid; passages are immutable and resume
// compares them by ordinal, so each rendition is always checked with the
// splitter of its own processor. Without --version a source that already has a
// text rendition reuses it (v2 if present, else the latest), so re-running
// ingest never adds a second extraction silently; --version v2 re-extracts.
func (c *Client) Ingest(path string, o IngestOptions) (map[string]any, error) {
	version := o.Version
	if o.VersionSet && (version == "" || utf8.RuneCountInString(version) > 100) {
		return nil, fail(2, "rendition version must contain 1–100 characters")
	}
	if o.DateSet && (utf8.RuneCountInString(o.Date) > dateRunes || strings.ContainsAny(o.Date, "\r\n")) {
		return nil, fail(2, "source date must be one line of at most 100 characters")
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
		return nil, fail(2, "unsupported source type %s: PocketContext accepts UTF-8 text notes only (%s); nothing was uploaded", suffix, strings.Join(names, " "))
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
	markdown := media == "text/markdown"
	if len(chunks(text, markdown)) == 0 {
		return nil, fail(2, "source contains no text")
	}
	title, date := o.Title, o.Date
	if markdown {
		fm := frontMatter(splitLines(text))
		if v := fm["title"]; title == "" && runes(v) <= titleRunes {
			title = v
		}
		v := fm["published"]
		if v == "" {
			v = fm["date"]
		}
		if !o.DateSet && runes(v) <= dateRunes {
			date = v
		}
	}
	sum := sha256.Sum256(content)
	digest := hex.EncodeToString(sum[:])
	space, err := c.SpaceID()
	if err != nil {
		return nil, err
	}
	// Deduplication is per space: the same bytes in another space are a separate source.
	findSource := "SELECT id, sha256, title, source_date FROM sources WHERE sha256 = " + literal(digest) + " AND space = " + literal(space) + " LIMIT 1"
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
		fields := map[string]string{"space": space, "title": title, "original_name": filepath.Base(abs), "media_type": media}
		if date != "" {
			fields["source_date"] = date
		}
		source, err = c.upload(fields, uploadName, content)
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
	result := map[string]any{"space": space, "source": sourceID, "sha256": digest, "title": source["title"], "source_date": source["source_date"],
		"status": "extracted", "next": "Synthesize cited page revisions in a staging ingestion run, then publish."}
	if len(found) > 0 && (o.Title != "" || o.DateSet) {
		result["note"] = "source already stored; its title and date are immutable and were not changed"
	}
	if !o.VersionSet {
		version = defaultVersion
		labels, err := c.Rows("SELECT version_label FROM renditions WHERE source = " + literal(sourceID) + " AND kind = 'text' ORDER BY created, id LIMIT 1000")
		if err != nil {
			return nil, err
		}
		for _, r := range labels {
			if version, _ = r["version_label"].(string); version == defaultVersion {
				break
			}
		}
	}
	findRendition := "SELECT id, processor, notes FROM renditions WHERE source = " + literal(sourceID) + " AND kind = 'text' AND version_label = " + literal(version) + " LIMIT 1"
	existing, err := c.Rows(findRendition)
	if err != nil {
		return nil, err
	}
	var rendition map[string]any
	passages := chunks(text, markdown)
	if len(existing) > 0 {
		proc, _ := existing[0]["processor"].(string)
		passages = splitFor(proc, text, markdown)
	}
	expectedManifest := manifest(passages)
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
	result["rendition"], result["version"], result["passages"] = renditionID, version, len(passages)
	if proc, _ := rendition["processor"].(string); proc == processorV1 {
		result["processor"] = proc
		result["note"] = "passages come from a v1 extraction (fixed 24,000-character cuts); run with --version v2 for structure-aware passages"
	}
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
