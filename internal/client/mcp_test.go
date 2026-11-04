package client

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ganigeorgiev.com/pocketbase/pocketbase/tools/router"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/pocketcontext-labs/pocketcontext/internal/bundle"
)

// The protocol fixture injects the ordinary user identity that the separately
// tested OAuth middleware supplies in production. A shared stateless SDK handler
// must never retain one HTTP request's identity for the next one.
func mcpTestHandler(api http.Handler) http.Handler {
	s := mcp.NewServer(&mcp.Implementation{Name: "PocketContext test", Version: "test"}, nil)
	addMCPTools(s, api)
	return mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return s }, &mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true, MaxRequestBodyBytes: mcpInputLimit})
}
func mcpRequest(t *testing.T, h http.Handler, token, method string, params any) map[string]any {
	t.Helper()
	payload, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
	req := httptest.NewRequest("POST", "https://knowledge.example.com/mcp", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("MCP-Protocol-Version", "2025-11-25")
	caller := &mcpCaller{ctx: req.Context(), host: req.Host, token: token}
	req = req.WithContext(context.WithValue(req.Context(), mcpRequestContextKey{}, caller))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("MCP %s: %d %s", method, rec.Code, rec.Body)
	}
	var result map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if rec.Header().Get("Mcp-Session-Id") != "" {
		t.Fatal("stateless endpoint assigned a session")
	}
	return result
}
func mcpCall(t *testing.T, h http.Handler, token, name string, args any, wantError bool) any {
	t.Helper()
	result := mcpRequest(t, h, token, "tools/call", map[string]any{"name": name, "arguments": args})
	if result["error"] != nil {
		if wantError {
			return result
		}
		t.Fatalf("protocol error: %v", result)
	}
	r, _ := result["result"].(map[string]any)
	if (r["isError"] == true) != wantError {
		t.Fatalf("%s: unexpected result %v", name, result)
	}
	if wantError {
		return r
	}
	content, _ := r["content"].([]any)
	if len(content) == 0 {
		t.Fatalf("%s returned no content: %v", name, result)
	}
	text, _ := dig(content[0], "text").(string)
	var out any
	if err := json.Unmarshal([]byte(text), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestMCPProtocolAndPrincipalIsolation(t *testing.T) {
	type key struct{}
	var calls atomic.Int64
	api := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Host != "knowledge.example.com" || r.RemoteAddr == "127.0.0.1:0" || r.Header.Get("X-PocketContext-Local-Key") != "" {
			t.Errorf("unsafe in-process authority: %v", r)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"token_seen_by_api": r.Header.Get("Authorization"), "context_seen": r.Context().Value(key{})})
	})
	h := mcpTestHandler(api)
	init := mcpRequest(t, h, "first", "initialize", map[string]any{"protocolVersion": "2025-11-25", "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "synthetic", "version": "1"}})
	if dig(init, "result", "protocolVersion") != "2025-11-25" {
		t.Fatalf("protocol negotiation: %v", init)
	}
	listed := mcpRequest(t, h, "first", "tools/list", map[string]any{})
	tools, _ := dig(listed, "result", "tools").([]any)
	if len(tools) < 25 {
		t.Fatalf("missing tools: %v", listed)
	}
	for _, tool := range tools {
		name, _ := dig(tool, "name").(string)
		if strings.Contains(name, "password") || strings.Contains(name, "shell") || strings.Contains(name, "stop") {
			t.Fatalf("administration exposed: %s", name)
		}
		if name == "ingest_text" && dig(tool, "annotations", "readOnlyHint") != false {
			t.Fatal("write marked read-only")
		}
	}
	for _, token := range []string{"first", "second", "third"} {
		v := mcpCall(t, h, token, "schema", map[string]any{}, false)
		if dig(v, "token_seen_by_api") != token {
			t.Fatalf("cross-request identity leak: %v", v)
		}
	}
	before := calls.Load()
	for _, tc := range []struct {
		name string
		args map[string]any
	}{
		{"create", map[string]any{"collection": "users", "fields": map[string]any{"password": "no"}}},
		{"get", map[string]any{"collection": "_superusers", "id": "aaaaaaaaaaaaaaa"}},
		{"update", map[string]any{"collection": "settings/../../users", "id": "aaaaaaaaaaaaaaa", "fields": map[string]any{"expected_revision": 1}}},
		{"batch", map[string]any{"requests": []any{map[string]any{"method": "POST", "url": "/api/collections/users/auth-refresh", "body": map[string]any{}}}}},
		{"batch", map[string]any{"requests": []any{map[string]any{"method": "POST", "url": "https://other.example.com/api/collections/pages/records", "body": map[string]any{}}}}},
		{"batch", map[string]any{"requests": []any{map[string]any{"method": "POST", "url": "/api/collections/pages/records?expand=users", "body": map[string]any{}}}}},
		{"ingest_text", map[string]any{"filename": "../../secret.txt", "text": "x"}},
		{"ingest_file", map[string]any{"filename": "C:\\secret.txt", "content_base64": "eA=="}},
		{"ingest_file", map[string]any{"filename": "note.bin", "content_base64": "invalid"}},
		{"schema", map[string]any{"unknown": "not accepted"}},
		{"publish", map[string]any{"run": "bad", "expected_revision": 1}},
		{"shutdown", map[string]any{}},
	} {
		mcpCall(t, h, "first", tc.name, tc.args, true)
	}
	if calls.Load() != before {
		t.Fatal("invalid MCP arguments reached API")
	}
	// Auth middleware absence fails closed even for initialize/list.
	req := httptest.NewRequest("POST", "https://knowledge.example.com/mcp", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()
	newMCPHandler(api).ServeHTTP(rec, req)
	if rec.Code != 401 {
		t.Fatal("missing OAuth accepted")
	}
}

// Exercise PocketBase's actual request-body cleanup without an HTTP hop. The
// network-backed knowledge fixture normalizes nil bodies before the router sees
// them, which hid the bodyless GET crash in the production in-process adapter.
func TestMCPTransportDirectRouterRequestBodies(t *testing.T) {
	routes := router.NewRouter(func(w http.ResponseWriter, r *http.Request) (*router.Event, router.EventCleanupFunc) {
		return &router.Event{Response: w, Request: r}, nil
	})
	handler := func(e *router.Event) error {
		var body []byte
		if e.Request.Method == http.MethodPost {
			var err error
			body, err = io.ReadAll(e.Request.Body)
			if err != nil {
				return err
			}
		}
		return e.JSON(http.StatusOK, map[string]string{"body": string(body), "token": e.Request.Header.Get("Authorization")})
	}
	routes.GET("/api/context/schema", handler)
	routes.POST("/api/context/query", handler)
	api, err := routes.BuildMux()
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, method, path, wantBody string
		body                         io.Reader
	}{
		{"nil GET body", "GET", "/api/context/schema", "", nil},
		{"explicit empty GET body", "GET", "/api/context/schema", "", http.NoBody},
		{"JSON POST body", "POST", "/api/context/query", `{"sql":"SELECT 1"}`, strings.NewReader(`{"sql":"SELECT 1"}`)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tr := &mcpTransport{ctx: context.Background(), caller: &mcpCaller{ctx: context.Background(), host: "knowledge.example.com", token: "synthetic"}, api: api}
			req, err := http.NewRequest(tc.method, "https://knowledge.example.com"+tc.path, tc.body)
			if err != nil {
				t.Fatal(err)
			}
			resp, err := tr.RoundTrip(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			var got map[string]string
			if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
				t.Fatal(err)
			}
			if resp.StatusCode != http.StatusOK || got["body"] != tc.wantBody || got["token"] != "synthetic" {
				t.Fatalf("direct router response: status=%d body=%v", resp.StatusCode, got)
			}
			if tc.body == nil && req.Body != nil {
				t.Fatal("transport changed the caller's request body")
			}
		})
	}
}

func TestMCPTransportBoundsAndCancellation(t *testing.T) {
	if mcpAPIAllowed("POST", "/api/bundle/token") || mcpAPIAllowed("GET", "/api/collections/users/records/aaaaaaaaaaaaaaa") || mcpAPIAllowed("DELETE", "/api/collections/pages/records/aaaaaaaaaaaaaaa") {
		t.Fatal("administration admitted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var called bool
	tr := &mcpTransport{ctx: context.Background(), caller: &mcpCaller{ctx: ctx, host: "knowledge.example.com", token: "synthetic"}, api: http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true })}
	req, _ := http.NewRequest("POST", "https://knowledge.example.com/api/context/query", strings.NewReader(`{}`))
	if _, err := tr.RoundTrip(req); !errors.Is(err, context.Canceled) || called {
		t.Fatalf("cancelled operation reached router: %v", err)
	}
	tr.caller.ctx = context.Background()
	tr.api = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(bytes.Repeat([]byte("x"), mcpAPILimit+1)) })
	if _, err := tr.RoundTrip(req); err == nil {
		t.Fatal("unbounded API output accepted")
	}
	// Cancellation during handler execution reaches the underlying API.
	ctx, cancel = context.WithCancel(context.Background())
	defer cancel()
	tr.caller.ctx = ctx
	entered := make(chan struct{})
	tr.api = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(entered); <-r.Context().Done() })
	done := make(chan error, 1)
	go func() { _, err := tr.RoundTrip(req); done <- err }()
	<-entered
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancel: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("API context did not cancel")
	}
}

// A real headless server fixture exercises the same JS request hooks, SQL
// authorizer, protected file path and publication transactions used in release.
func mcpRealAPI(t *testing.T) (http.Handler, string) {
	t.Helper()
	root := t.TempDir()
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(cwd) })
	t.Setenv("HOME", root)
	t.Setenv("XDG_CACHE_HOME", filepath.Join(root, "cache"))
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(root, "config"))
	t.Setenv("LOCALAPPDATA", filepath.Join(root, "cache"))
	t.Setenv("APPDATA", filepath.Join(root, "config"))
	t.Setenv("POCKETCONTEXT_URL", "")
	t.Setenv("POCKETCONTEXT_SPACE", "")
	p, err := bundle.Resolve(filepath.Join(root, "project", "pocketcontext.db"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(p.Dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := p.EnsureInstance(); err != nil {
		t.Fatal(err)
	}
	if err := p.SaveConfig(); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- bundle.ServeContext(ctx, p, bundle.ServeOptions{Headless: true}) }()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(15 * time.Second):
			t.Error("server failed to stop")
		}
	})
	deadline := time.Now().Add(15 * time.Second)
	for {
		if _, err := bundle.Health(p); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("server did not become healthy")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if _, err := bundle.LocalCall(p, "/api/bundle/account", map[string]string{"password": "synthetic-mcp-password"}); err != nil {
		t.Fatal(err)
	}
	c, err := New(p, "")
	if err != nil {
		t.Fatal(err)
	}
	// Proxy only the test's adapter to the actual private transport. Production
	// receives the raw router directly and retains the public-request marker.
	api := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		inner := r.Clone(r.Context())
		inner.URL.Scheme = "http"
		u := strings.TrimPrefix(p.URL(), "http://")
		inner.URL.Host = u
		inner.Host = u
		inner.RequestURI = ""
		response, err := c.http.Do(inner)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		defer response.Body.Close()
		for k, values := range response.Header {
			for _, v := range values {
				w.Header().Add(k, v)
			}
		}
		w.WriteHeader(response.StatusCode)
		_, _ = io.Copy(w, response.Body)
	})
	return api, c.token
}

func TestMCPKnowledgePublicationAndFiles(t *testing.T) {
	api, token := mcpRealAPI(t)
	h := mcpTestHandler(api)
	call := func(name string, args map[string]any) any { return mcpCall(t, h, token, name, args, false) }
	denied := func(name string, args map[string]any) { mcpCall(t, h, token, name, args, true) }
	call("schema", map[string]any{})
	denied("query", map[string]any{"sql": "SELECT * FROM users"})
	denied("query", map[string]any{"sql": "DELETE FROM sources"})
	note := "# Synthetic MCP evidence\n\nThe synthetic reading routine runs every Friday.\n"
	ingested := call("ingest_text", map[string]any{"text": note, "filename": "mcp-note.md", "title": "Synthetic MCP evidence"})
	source := dig(ingested, "source").(string)
	again := call("ingest_text", map[string]any{"text": note, "filename": "mcp-note.md"})
	if dig(again, "source") != source {
		t.Fatal("ingest did not deduplicate")
	}
	passages := call("passages", map[string]any{"source": source, "limit": 1})
	rows := dig(passages, "passages").([]any)
	if len(rows) != 1 {
		t.Fatal("passages missing")
	}
	passage := dig(rows[0], "id").(string)
	original := call("original", map[string]any{"source": source})
	if dig(original, "content_base64") != base64.StdEncoding.EncodeToString([]byte(note)) {
		t.Fatal("original bytes changed")
	}
	spec := map[string]any{"run_key": "synthetic-mcp-run", "description": "MCP protocol rehearsal", "sources": []string{source}, "pages": []any{map[string]any{"slug": "mcp-reading", "kind": "concept", "title": "Synthetic reading", "summary": "A synthetic routine", "body": "The synthetic reading routine runs every Friday.[^1]", "citations": map[string]string{"1": passage}}}}
	dry := call("stage", map[string]any{"spec": spec, "dry_run": true})
	if dig(dry, "problems") != nil {
		t.Logf("dry run: %v", dry)
	}
	staged := call("stage", map[string]any{"spec": spec})
	run := dig(staged, "run").(string)
	checked := call("check_run", map[string]any{"run": run})
	if dig(checked, "ok") != true {
		t.Fatalf("check: %v", checked)
	}
	record := call("get", map[string]any{"collection": "ingestion_runs", "id": run})
	revision := dig(record, "revision")
	call("publish", map[string]any{"run": run, "expected_revision": revision})
	page := call("get_page", map[string]any{"slug": "mcp-reading"})
	if dig(page, "page", "body") != "The synthetic reading routine runs every Friday.[^1]" {
		t.Fatalf("page: %v", page)
	}
	call("search", map[string]any{"query": "Friday"})
	call("search_sources", map[string]any{"query": "Friday"})
	call("lint", map[string]any{})
	if !strings.Contains(dig(page, "url").(string), "&space=") {
		t.Fatal("page link lost its space")
	}
	// Two competing runs start from the same published revision. Publishing the
	// first must make the second conflict without exposing a partial revision.
	competing := func(key, body string) string {
		value := call("stage", map[string]any{"spec": map[string]any{"run_key": key, "pages": []any{map[string]any{"slug": "mcp-reading", "body": body, "citations": map[string]string{"1": passage}}}}})
		return dig(value, "run").(string)
	}
	first := competing("mcp-conflict-first", "First revised synthetic statement.[^1]")
	second := competing("mcp-conflict-second", "Second competing synthetic statement.[^1]")
	firstRun := call("get", map[string]any{"collection": "ingestion_runs", "id": first})
	secondRun := call("get", map[string]any{"collection": "ingestion_runs", "id": second})
	call("publish", map[string]any{"run": first, "expected_revision": dig(firstRun, "revision")})
	denied("publish", map[string]any{"run": second, "expected_revision": dig(secondRun, "revision")})
	current := call("get_page", map[string]any{"slug": "mcp-reading"})
	if dig(current, "page", "body") != "First revised synthetic statement.[^1]" {
		t.Fatal("conflicting publication changed selected page")
	}
	// Citation structural validation still runs through the request hooks.
	bad := call("stage", map[string]any{"spec": map[string]any{"run_key": "mcp-invalid-citation", "pages": []any{map[string]any{"slug": "unsupported", "kind": "concept", "title": "Unsupported", "summary": "Synthetic invalid", "body": "Unsupported prose."}}}})
	badID, _ := dig(bad, "run").(string)
	if badID != "" {
		badRecord := call("get", map[string]any{"collection": "ingestion_runs", "id": badID})
		denied("publish", map[string]any{"run": badID, "expected_revision": dig(badRecord, "revision")})
	}
	// Publication cannot be replayed and immutable sources cannot be edited.
	denied("publish", map[string]any{"run": run, "expected_revision": revision})
	denied("update", map[string]any{"collection": "sources", "id": source, "fields": map[string]any{"expected_revision": 1, "title": "Changed"}})
	binary := call("ingest_file", map[string]any{"filename": "synthetic.pdf", "content_base64": base64.StdEncoding.EncodeToString([]byte("synthetic non-PDF bytes"))})
	binaryID := dig(binary, "source").(string)
	call("pending", map[string]any{})
	call("extract", map[string]any{"source": binaryID, "text": "Synthetic agent-derived text.", "tool": "synthetic fixture; not a real PDF conversion", "original_sha256": dig(binary, "sha256")})
	derived := call("passages", map[string]any{"source": binaryID})
	if dig(derived, "derived") != true {
		t.Fatal("derived evidence not labelled")
	}
	other := call("create_space", map[string]any{"name": "Other synthetic space"})
	otherID := dig(other, "id").(string)
	call("rename_space", map[string]any{"target": otherID, "name": "Renamed synthetic space"})
	call("set_default_space", map[string]any{"target": otherID})
	call("default_space", map[string]any{})
	// Space argument is request-local even when calls are concurrent.
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); call("whoami", map[string]any{"space": otherID}) }()
	}
	wg.Wait()
}

func TestMCPOriginalTransportErrorsDoNotExposeFileTokens(t *testing.T) {
	for _, kind := range []string{"oversized", "cancelled"} {
		t.Run(kind, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			tr := &mcpTransport{ctx: ctx, caller: &mcpCaller{ctx: ctx, host: "knowledge.example.com", token: "synthetic-account-token"}, api: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if kind == "cancelled" {
					cancel()
					return
				}
				_, _ = w.Write(bytes.Repeat([]byte("x"), mcpAPILimit+1))
			})}
			c := &Client{Base: "https://knowledge.example.com", http: &http.Client{Transport: tr}}
			_, err := c.download("/api/files/sources/aaaaaaaaaaaaaaa/note.pdf?token=synthetic-file-secret")
			if err == nil || strings.Contains(err.Error(), "synthetic-file-secret") || strings.Contains(err.Error(), "token=") {
				t.Fatalf("file token leaked: %v", err)
			}
		})
	}
}

func TestMCPRejectsOversizedAndMalformedProtocolBodies(t *testing.T) {
	h := mcpTestHandler(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("malformed protocol reached API") }))
	for _, body := range []string{`{"jsonrpc":"2.0",`, strings.Repeat(" ", mcpInputLimit+1)} {
		req := httptest.NewRequest("POST", "https://knowledge.example.com/mcp", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code < 400 {
			t.Fatalf("malformed/oversized body accepted: %d", rec.Code)
		}
	}
}
