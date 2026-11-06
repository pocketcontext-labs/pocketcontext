package client

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func throttleFixture(w http.ResponseWriter, status int, nested bool) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Retry-After", "7")
	w.Header().Set("RateLimit-Limit", "1200")
	w.Header().Set("RateLimit-Remaining", "2")
	w.Header().Set("RateLimit-Reset", "60")
	response := map[string]any{"status": 429, "message": "Too Many Requests.", "data": map[string]any{"rate_limit": RateLimitInfo{Limit: "authenticated_knowledge", RetryAfterSeconds: 7, Capacity: 1200, Remaining: 2, ResetAfterSeconds: 60}}}
	if nested {
		response = map[string]any{"status": 400, "data": map[string]any{"requests": map[string]any{"3": map[string]any{"code": "batch_request_failed", "response": response}}}}
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(response)
}

func TestClientPreservesRateLimit(t *testing.T) {
	for _, tc := range []struct {
		name, method, path string
		status             int
		nested             bool
	}{
		{"write", "POST", "/api/collections/sources/records", 429, false},
		{"read", "POST", "/api/context/query", 429, false},
		{"batch", "POST", "/api/batch", 400, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { calls.Add(1); throttleFixture(w, tc.status, tc.nested) }))
			defer s.Close()
			c, _ := newClient(s.URL, "")
			_, err := c.Must(tc.method, tc.path, map[string]any{})
			var limited *RateLimitError
			var failure *Fail
			if !errors.As(err, &limited) || !errors.As(err, &failure) || failure.Code != 1 {
				t.Fatalf("missing typed throttle/exit code: %v", err)
			}
			want := RateLimitInfo{Limit: "authenticated_knowledge", RetryAfterSeconds: 7, Capacity: 1200, Remaining: 2, ResetAfterSeconds: 60}
			if limited.RateLimit != want {
				t.Fatalf("metadata = %#v, want %#v", limited.RateLimit, want)
			}
			if calls.Load() != 1 {
				t.Fatalf("retried before advertised cooldown: %d calls", calls.Load())
			}
		})
	}
}

func TestClientRateLimitHeadersWithoutJSON(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "9")
		w.Header().Set("RateLimit-Limit", "10")
		w.Header().Set("RateLimit-Remaining", "0")
		w.Header().Set("RateLimit-Reset", "12")
		http.Error(w, "Too many requests", 429)
	}))
	defer s.Close()
	c, _ := newClient(s.URL, "")
	_, _, err := c.send("POST", records("sources"), nil, nil, "application/octet-stream", []byte("synthetic source"))
	var limited *RateLimitError
	if !errors.As(err, &limited) || limited.RateLimit.RetryAfterSeconds != 9 || limited.RateLimit.Capacity != 10 || limited.RateLimit.ResetAfterSeconds != 12 {
		t.Fatalf("lost upload throttle headers: %v", err)
	}
}

func TestMCPStageThrottleMetadata(t *testing.T) {
	api := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { throttleFixture(w, 400, true) })
	server := mcp.NewServer(&mcp.Implementation{Name: "throttle test", Version: "test"}, nil)
	addMCPTool(server, api, "stage_test", "Synthetic staging throttle", false, func(c *Client, _ mcpSpace) (any, error) {
		_, err := c.Must("POST", "/api/batch", map[string]any{"requests": []any{}})
		return nil, stageBatchError(err, 2, 3, "syntheticrun001")
	})
	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, &mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true})
	response := mcpRequest(t, handler, "synthetic-user-token", "tools/call", map[string]any{"name": "stage_test", "arguments": map[string]any{}})
	result, _ := response["result"].(map[string]any)
	if result["isError"] != true {
		t.Fatalf("throttle must be a tool error: %v", response)
	}
	structured := dig(result, "structuredContent", "error")
	if dig(structured, "code") != "rate_limited" || dig(structured, "rate_limit", "retry_after_seconds") != float64(7) {
		t.Fatalf("lost structured throttle: %v", response)
	}
	message, _ := dig(structured, "message").(string)
	if strings.Contains(message, "Fix the spec") || !strings.Contains(message, "same run_key") || !strings.Contains(message, "batch 2 of 3") {
		t.Fatalf("wrong staging advice: %s", message)
	}
	content := result["content"].([]any)[0].(map[string]any)["text"].(string)
	var text map[string]any
	if err := json.Unmarshal([]byte(content), &text); err != nil || dig(text, "error", "code") != "rate_limited" {
		t.Fatalf("text-only clients lost retry details: %s", content)
	}
}

func TestStageBatchErrorPreservesConflict(t *testing.T) {
	err := stageBatchError(&Fail{4, "conflict"}, 1, 2, "syntheticrun001")
	var failure *Fail
	if !errors.As(err, &failure) || failure.Code != 4 || !strings.Contains(err.Error(), "Fix the spec") {
		t.Fatalf("changed non-throttle behavior: %v", err)
	}
}

func TestCommandReportsWrappedStageThrottle(t *testing.T) {
	limited := responseRateLimit("POST", "/api/batch", 429, nil, http.Header{"Retry-After": {"7"}})
	err := stageBatchError(limited, 2, 3, "syntheticrun001")
	var stderr bytes.Buffer
	if code := commandResult(err, &stderr); code != 1 {
		t.Fatalf("exit code = %d", code)
	}
	if output := stderr.String(); !strings.Contains(output, "Wait 7 seconds") || !strings.Contains(output, "same run_key") || !strings.Contains(output, "batch 2 of 3") {
		t.Fatalf("lost wrapped staging advice: %s", output)
	}
}

func TestBatchThrottleOuterMetadataAndLegacyFallback(t *testing.T) {
	data := map[string]any{"data": map[string]any{
		"requests":   map[string]any{"0": map[string]any{"response": map[string]any{"status": json.Number("429")}}},
		"rate_limit": map[string]any{"limit": "outer_batch", "retry_after_seconds": 8, "capacity": 20, "remaining": 0, "reset_after_seconds": 8},
	}}
	limited := responseRateLimit("POST", "/api/batch", 400, data, nil)
	if limited == nil || limited.RateLimit.Limit != "outer_batch" || limited.RateLimit.RetryAfterSeconds != 8 {
		t.Fatalf("lost outer metadata: %+v", limited)
	}
	limited = responseRateLimit("POST", "/api/batch", 429, nil, nil)
	if limited.RateLimit.Limit != "unknown" || limited.RateLimit.RetryAfterSeconds != 10 {
		t.Fatalf("unsafe legacy fallback: %+v", limited)
	}
}
