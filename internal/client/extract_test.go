package client

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func exitCode(err error) int {
	var f *Fail
	if errors.As(err, &f) {
		return f.Code
	}
	return -1
}

// fakeServer answers SQL with rows chosen by answer and serves one protected file.
func fakeServer(t *testing.T, answer func(sql string) ([]string, [][]any), file []byte) *Client {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/context/query":
			var body struct{ SQL string }
			json.NewDecoder(r.Body).Decode(&body)
			columns, rows := answer(body.SQL)
			if rows == nil {
				rows = [][]any{}
			}
			json.NewEncoder(w).Encode(map[string]any{"columns": columns, "rows": rows})
		case r.URL.Path == "/api/files/token" && r.Method == "POST":
			w.Write([]byte(`{"token":"filetoken"}`))
		case strings.HasPrefix(r.URL.Path, "/api/files/sources/") && r.URL.Query().Get("token") == "filetoken":
			w.Write(file)
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(server.Close)
	return &Client{Base: server.URL, Space: "space0000000001", spaceOK: true, http: server.Client()}
}

func TestBinaryMediaTypes(t *testing.T) {
	for ext, want := range map[string]string{".pdf": "application/pdf", ".jpeg": "image/jpeg", ".m4a": "audio/mp4", ".opus": "audio/opus", ".epub": "application/epub+zip"} {
		if binaryTypes[ext] != want {
			t.Errorf("%s = %q", ext, binaryTypes[ext])
		}
	}
	for ext, want := range map[string]string{".srt": "application/x-subrip", ".org": "text/org"} {
		if textExtensions[ext] != want {
			t.Errorf("%s = %q", ext, textExtensions[ext])
		}
	}
	for ext := range binaryTypes {
		if _, text := textExtensions[ext]; text {
			t.Errorf("%s is both text and binary", ext)
		}
	}
}

func TestAgentNotes(t *testing.T) {
	ps := chunksV3("# Report\n\nRevenue grew.\n", true)
	digest := passagesDigest(ps)
	got := agentNotes(ps, "ab", ExtractOptions{Tool: "a <b> tool"})
	want := `{"derived":true,"passages":1,"sha256":"` + digest + `","text_sha256":"ab","tool":"a <b> tool"}`
	if got != want {
		t.Fatalf("notes %s, want %s", got, want)
	}
	got = agentNotes(ps, "ab", ExtractOptions{Tool: "t", OriginalSHA256: strings.Repeat("0", 64), OriginalSet: true, Conversion: "m4a to Opus", ConversionSet: true})
	if !strings.HasPrefix(got, `{"conversion":"m4a to Opus","derived":true,"original_sha256":"000`) {
		t.Fatalf("notes %s", got)
	}
	if splitFor(processorAgent, "# A\n\nBody.\n", true)[0].Locator != "# A; lines 1-3" {
		t.Fatal("agent text splits like v3")
	}
}

func TestExtractRefusesBeforeAnyRequest(t *testing.T) {
	dir := t.TempDir()
	write := func(name, content string) string {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
		return path
	}
	good, latin, empty, blankFile := write("good.md", "# A\n\nText.\n"), write("latin.txt", "caf\xe9"), write("empty.txt", ""), write("blank.txt", " \n\n")
	c := &Client{Base: "http://127.0.0.1:1"}
	ok := ExtractOptions{Text: good, Tool: "agent read it"}
	for name, tc := range map[string]struct {
		id string
		o  ExtractOptions
	}{
		"source id":       {"Report", ok},
		"no text":         {"source000000001", ExtractOptions{Tool: "t"}},
		"no tool":         {"source000000001", ExtractOptions{Text: good}},
		"tool newline":    {"source000000001", ExtractOptions{Text: good, Tool: "a\nb"}},
		"tool length":     {"source000000001", ExtractOptions{Text: good, Tool: strings.Repeat("t", 301)}},
		"version":         {"source000000001", ExtractOptions{Text: good, Tool: "t", VersionSet: true}},
		"original sha":    {"source000000001", ExtractOptions{Text: good, Tool: "t", OriginalSHA256: strings.Repeat("A", 64), OriginalSet: true}},
		"conversion":      {"source000000001", ExtractOptions{Text: good, Tool: "t", ConversionSet: true}},
		"conversion long": {"source000000001", ExtractOptions{Text: good, Tool: "t", Conversion: strings.Repeat("c", 2001), ConversionSet: true}},
		"not utf-8":       {"source000000001", ExtractOptions{Text: latin, Tool: "t"}},
		"empty":           {"source000000001", ExtractOptions{Text: empty, Tool: "t"}},
		"blank":           {"source000000001", ExtractOptions{Text: blankFile, Tool: "t"}},
		"missing":         {"source000000001", ExtractOptions{Text: filepath.Join(dir, "none.md"), Tool: "t"}},
	} {
		if _, err := c.Extract(tc.id, tc.o); exitCode(err) != 2 {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestExtractRefusesTextSource(t *testing.T) {
	path := filepath.Join(t.TempDir(), "report.md")
	os.WriteFile(path, []byte("# Report\n\nRevenue grew.\n"), 0644)
	c := fakeServer(t, func(sql string) ([]string, [][]any) {
		if strings.HasPrefix(sql, "SELECT id FROM sources") {
			return []string{"id"}, [][]any{{"source000000001"}}
		}
		if strings.Contains(sql, "kind = 'text'") {
			return []string{"id"}, [][]any{{"rendition000001"}}
		}
		t.Errorf("unexpected SQL %s", sql)
		return nil, nil
	}, nil)
	_, err := c.Extract("source000000001", ExtractOptions{Text: path, Tool: "t"})
	if exitCode(err) != 2 || !strings.Contains(err.Error(), "text source") {
		t.Fatalf("extract on a text source: %v", err)
	}
}

func TestIngestBinaryRefusals(t *testing.T) {
	dir := t.TempDir()
	pdf := filepath.Join(dir, "report.pdf")
	os.WriteFile(pdf, []byte("%PDF-1.7\n\x00\xff"), 0644)
	c := &Client{Base: "http://127.0.0.1:1"}
	if _, err := c.Ingest(pdf, IngestOptions{Version: "v3", VersionSet: true}); exitCode(err) != 2 || !strings.Contains(err.Error(), "pocketcontext extract") {
		t.Fatalf("--version with a binary: %v", err)
	}
	big := filepath.Join(dir, "big.wav")
	f, _ := os.Create(big)
	f.Truncate(maxBinarySource + 1)
	f.Close()
	if _, err := c.Ingest(big, IngestOptions{}); exitCode(err) != 2 || !strings.Contains(err.Error(), "50 MiB") {
		t.Fatalf("large binary: %v", err)
	}
	pointer := filepath.Join(dir, "lfs.png")
	os.WriteFile(pointer, []byte("version https://git-lfs.github.com/spec/v1\noid sha256:00\n"), 0644)
	if _, err := c.Ingest(pointer, IngestOptions{}); exitCode(err) != 2 {
		t.Fatalf("LFS pointer: %v", err)
	}
}

func TestPendingLimit(t *testing.T) {
	c := &Client{Base: "http://127.0.0.1:1"}
	for _, n := range []int{0, -1, 501} {
		if _, err := c.Pending(n); exitCode(err) != 2 {
			t.Errorf("limit %d: %v", n, err)
		}
	}
	c = fakeServer(t, func(sql string) ([]string, [][]any) {
		if !strings.Contains(sql, "NOT EXISTS") || !strings.HasSuffix(sql, "LIMIT 3") {
			t.Errorf("SQL %s", sql)
		}
		return []string{"id"}, [][]any{{"a"}, {"b"}, {"c"}}
	}, nil)
	out, err := c.Pending(2)
	if err != nil || !out["truncated"].(bool) || len(out["sources"].([]map[string]any)) != 2 {
		t.Fatalf("pending %v %v", out, err)
	}
}

func TestOriginal(t *testing.T) {
	file := []byte("%PDF-1.7\n\x00\xff synthetic")
	sum := sha256.Sum256(file)
	digest := hex.EncodeToString(sum[:])
	stored := digest
	c := fakeServer(t, func(sql string) ([]string, [][]any) {
		return []string{"id", "sha256", "media_type", "original"}, [][]any{{"source000000001", stored, "application/pdf", "abc_x1.pdf"}}
	}, file)
	dir := t.TempDir()
	out := filepath.Join(dir, "report.pdf")
	got, err := c.Original("source000000001", out)
	if err != nil || got["sha256"] != digest || got["bytes"] != len(file) || got["media_type"] != "application/pdf" {
		t.Fatalf("original %v %v", got, err)
	}
	if data, _ := os.ReadFile(out); string(data) != string(file) {
		t.Fatal("original bytes differ")
	}
	if _, err := c.Original("source000000001", out); exitCode(err) != 2 {
		t.Fatalf("existing --out: %v", err)
	}
	stored = strings.Repeat("0", 64)
	other := filepath.Join(dir, "other.pdf")
	if _, err := c.Original("source000000001", other); exitCode(err) != 1 || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("checksum mismatch: %v", err)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 1 {
		t.Fatalf("a failed download leaves files behind: %v", entries)
	}
}

func TestPassagesReadAgentText(t *testing.T) {
	renditions := [][]any{{"agent000000001", "agent-text", "agent-1", `{"passages":1}`}, {"agent000000002", "agent-text", "agent-2", `{"passages":1}`}}
	c := fakeServer(t, func(sql string) ([]string, [][]any) {
		switch {
		case strings.HasPrefix(sql, "SELECT id FROM sources"):
			return []string{"id"}, [][]any{{"source000000001"}}
		case strings.Contains(sql, "FROM renditions"):
			return []string{"id", "kind", "version_label", "notes"}, renditions
		case strings.Contains(sql, "ordinal > 0"):
			return []string{"id", "ordinal", "locator", "body"}, [][]any{{"passage00000001", 1, "# R; lines 1-3", "# R\n\nText."}}
		}
		return []string{"id"}, nil
	}, nil)
	s, err := c.SourcePassages("source000000001", "", false)
	if err != nil || s.Rendition != "agent000000002" || !s.Derived {
		t.Fatalf("newest agent-text rendition: %+v %v", s, err)
	}
	if want := "=== 1 · passage00000001 · # R; lines 1-3 · derived: agent text\n# R\n\nText.\n"; s.Text() != want {
		t.Fatalf("text %q", s.Text())
	}
	if s, err = c.SourcePassages("source000000001", "agent-1", true); err != nil || s.Rendition != "agent000000001" {
		t.Fatalf("--version agent-1: %+v %v", s, err)
	}
	// A text rendition wins over agent text.
	renditions = append(renditions, []any{"text0000000001", "text", "v3", `{"passages":1}`})
	if s, err = c.SourcePassages("source000000001", "", false); err != nil || s.Rendition != "text0000000001" || s.Derived {
		t.Fatalf("text rendition: %+v %v", s, err)
	}
	renditions = nil
	if _, err = c.SourcePassages("source000000001", "", false); exitCode(err) != 1 || !strings.Contains(err.Error(), "pocketcontext extract") {
		t.Fatalf("no rendition: %v", err)
	}
}
