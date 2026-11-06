package client

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Exercises the real stage planner, immutable evidence hooks, MCP error path,
// and same-run recovery. Hosted rate budgets are exercised separately against
// the same API in bundle.TestHostedBulkConsecutiveBatches.
func TestMCPBulkMigrationResume(t *testing.T) {
	api, token := mcpRealAPI(t)
	batches, interrupted := 0, false
	h := mcpTestHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/batch" {
			batches++
			if batches == 4 {
				interrupted = true
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Retry-After", "1")
				w.WriteHeader(429)
				_, _ = w.Write([]byte(`{"status":429,"message":"Synthetic throttle","data":{"rate_limit":{"limit":"authenticated_knowledge","retry_after_seconds":1,"capacity":1200,"remaining":0,"reset_after_seconds":12}}}`))
				return
			}
		}
		api.ServeHTTP(w, r)
	}))
	call := func(name string, args map[string]any) any { t.Helper(); return mcpCall(t, h, token, name, args, false) }
	sources, passages := make([]string, 40), make([]string, 40)
	// A barrier starts eight independent MCP requests together. Workers return
	// errors rather than calling testing.Fatal from outside the test goroutine.
	type ingested struct {
		index           int
		source, passage string
		err             error
	}
	ready := make(chan struct{})
	results := make(chan ingested, 8)
	for i := range 8 {
		go func() {
			<-ready
			result, err := mcpBulkCall(h, token, "ingest_text", map[string]any{"filename": fmt.Sprintf("note-%d.md", i), "text": fmt.Sprintf("Synthetic migration evidence number %d is independently identifiable.\n", i)})
			source, _ := dig(result, "source").(string)
			if err != nil || source == "" {
				results <- ingested{index: i, err: fmt.Errorf("source %d: %v (%v)", i, err, result)}
				return
			}
			result, err = mcpBulkCall(h, token, "passages", map[string]any{"source": source})
			rows, _ := dig(result, "passages").([]any)
			if err != nil || len(rows) != 1 {
				results <- ingested{index: i, err: fmt.Errorf("passages %d: %v (%v)", i, err, result)}
				return
			}
			passage, _ := dig(rows[0], "id").(string)
			results <- ingested{index: i, source: source, passage: passage}
		}()
	}
	close(ready)
	failedBurst := false
	for range 8 {
		result := <-results
		if result.err != nil {
			t.Error(result.err)
			failedBurst = true
			continue
		}
		sources[result.index], passages[result.index] = result.source, result.passage
	}
	if failedBurst {
		t.Fatal("parallel ingestion failed")
	}
	for i := 8; i < 40; i++ {
		text := fmt.Sprintf("Synthetic migration evidence number %d is independently identifiable.\n", i)
		var result any
		if i < 32 {
			result = call("ingest_text", map[string]any{"filename": fmt.Sprintf("note-%d.md", i), "text": text})
		} else {
			original := []byte(fmt.Sprintf("Synthetic binary original %d; not a real PDF.\x00", i))
			result = call("ingest_file", map[string]any{"filename": fmt.Sprintf("note-%d.pdf", i), "content_base64": base64.StdEncoding.EncodeToString(original)})
			call("extract", map[string]any{"source": dig(result, "source"), "text": text, "tool": "synthetic fixture conversion", "original_sha256": dig(result, "sha256")})
		}
		sources[i] = dig(result, "source").(string)
		evidence := call("passages", map[string]any{"source": sources[i]})
		rows := dig(evidence, "passages").([]any)
		passages[i] = dig(rows[0], "id").(string)
		if i >= 32 && dig(evidence, "derived") != true {
			t.Fatalf("source %d lost derived evidence label", i)
		}
	}
	pages := make([]any, 30)
	for i := range pages {
		pages[i] = map[string]any{"slug": fmt.Sprintf("migration-%d", i), "kind": "concept", "title": fmt.Sprintf("Migration %d", i), "summary": "Synthetic migration", "body": fmt.Sprintf("Synthetic migration evidence number %d.[^1] Related: [[migration-%d]].", i, (i+1)%30), "citations": map[string]string{"1": passages[i]}}
	}
	spec := map[string]any{"run_key": "bulk-migration-resume", "sources": sources, "pages": pages}
	failed := mcpCall(t, h, token, "stage", map[string]any{"spec": spec}, true)
	if !interrupted || !strings.Contains(fmt.Sprint(failed), "same run_key") {
		t.Fatalf("missing resumable failure: %v", failed)
	}
	resumed := call("stage", map[string]any{"spec": spec})
	run := dig(resumed, "run").(string)
	if len(dig(resumed, "skipped").([]any)) == 0 {
		t.Fatal("resume did not skip saved revisions")
	}
	before := batches
	replay := call("stage", map[string]any{"spec": spec})
	if dig(replay, "run") != run || len(dig(replay, "skipped").([]any)) != 30 || batches != before {
		t.Fatalf("same-run replay wrote again: %v batches=%d->%d", replay, before, batches)
	}
	for collection, want := range map[string]int{"sources": 40, "renditions": 40, "passages": 40, "pages": 30, "page_revisions": 30, "citations": 30, "page_links": 30, "ingestion_runs": 1} {
		result := call("query", map[string]any{"sql": "SELECT COUNT(*) FROM " + collection})
		rows := dig(result, "rows").([]any)
		got := rows[0].([]any)[0]
		if got != float64(want) {
			t.Fatalf("%s count=%v want=%d", collection, got, want)
		}
	}
	checked := call("check_run", map[string]any{"run": run})
	if dig(checked, "ok") != true {
		t.Fatalf("check: %v", checked)
	}
	record := call("get", map[string]any{"collection": "ingestion_runs", "id": run})
	call("publish", map[string]any{"run": run, "expected_revision": dig(record, "revision")})
}

// mcpBulkCall is the error-returning counterpart of mcpCall for burst workers.
func mcpBulkCall(h http.Handler, token, name string, args map[string]any) (any, error) {
	payload, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": name, "arguments": args}})
	if err != nil {
		return nil, err
	}
	req := httptest.NewRequest("POST", "https://knowledge.example.com/mcp", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("MCP-Protocol-Version", "2025-11-25")
	caller := &mcpCaller{ctx: req.Context(), host: req.Host, token: token}
	req = req.WithContext(context.WithValue(req.Context(), mcpRequestContextKey{}, caller))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 200 {
		return nil, fmt.Errorf("%s: HTTP %d: %s", name, rec.Code, rec.Body)
	}
	var response map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		return nil, err
	}
	if response["error"] != nil || dig(response, "result", "isError") == true {
		return nil, fmt.Errorf("%s: %v", name, response)
	}
	content, _ := dig(response, "result", "content").([]any)
	if len(content) == 0 {
		return nil, fmt.Errorf("%s: missing content", name)
	}
	text, _ := dig(content[0], "text").(string)
	var result any
	if err := json.Unmarshal([]byte(text), &result); err != nil {
		return nil, err
	}
	return result, nil
}
