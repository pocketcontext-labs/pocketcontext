package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/pocketcontext-labs/pocketcontext/internal/mcpobserve"
)

func diagnosticMCPHandler(s *mcp.Server, logs *bytes.Buffer) http.Handler {
	h := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return s }, &mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true, MaxRequestBodyBytes: mcpInputLimit})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx, _ := mcpobserve.WithRequest(mcpobserve.WithWriter(r.Context(), logs), "knowledge.example.com", "diagnostic-test")
		h.ServeHTTP(w, r.WithContext(ctx))
	})
}
func diagnosticEvents(t *testing.T, logs *bytes.Buffer) []map[string]any {
	t.Helper()
	var events []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(logs.String()), "\n") {
		if line == "" {
			continue
		}
		var e map[string]any
		if err := json.Unmarshal([]byte(line), &e); err != nil {
			t.Fatal(err)
		}
		events = append(events, e)
	}
	return events
}
func TestMCPDiagnosticsResultsAndPrivacy(t *testing.T) {
	for _, tc := range []struct {
		name            string
		args            any
		status          int
		outcome, reason string
	}{
		{"schema", map[string]any{}, 200, "success", "none"},
		{"query", map[string]any{"sql": "SECRET_QUERY"}, 409, "tool_error", "conflict"},
		{"query", map[string]any{"sql": map[string]any{"SECRET_ARGUMENT": "SECRET_VALUE"}}, 200, "tool_error", "invalid_input"},
		{"SECRET_TOOL", map[string]any{}, 200, "protocol_error", "unknown_tool"},
	} {
		t.Run(tc.name+tc.outcome, func(t *testing.T) {
			var logs bytes.Buffer
			s := mcp.NewServer(&mcp.Implementation{Name: "test", Version: "test"}, nil)
			addMCPTools(s, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(`{"message":"SECRET_RESULT","value":"SECRET_RESULT"}`))
			}))
			h := diagnosticMCPHandler(s, &logs)
			mcpCall(t, h, "SECRET_TOKEN", tc.name, tc.args, tc.outcome != "success")
			events := diagnosticEvents(t, &logs)
			if len(events) == 0 {
				t.Fatal("missing MCP diagnostic")
			}
			last := events[len(events)-1]
			if last["event"] != "mcp_complete" || last["outcome"] != tc.outcome || last["reason"] != tc.reason {
				t.Fatalf("unexpected completion: %v", last)
			}
			for _, e := range events {
				if e["request_id"] != last["request_id"] || len(e["request_id"].(string)) != 32 {
					t.Fatalf("uncorrelated events: %v", events)
				}
			}
			if strings.Contains(logs.String(), "SECRET_") {
				t.Fatal("diagnostic leaked request, response, tool name or token")
			}
			if tc.status == 409 {
				if len(events) != 2 || events[0]["api_status"] != float64(409) || events[0]["api_route"] != "/api/context/query" || last["api_calls"] != float64(1) {
					t.Fatalf("missing API failure metadata: %v", events)
				}
			}
		})
	}
}

func TestMCPDiagnosticsWriteUncertainty(t *testing.T) {
	for _, reason := range []string{"limit_exceeded", "cancelled", "timeout", "operation_failed"} {
		t.Run(reason, func(t *testing.T) {
			var logs bytes.Buffer
			s := mcp.NewServer(&mcp.Implementation{Name: "test", Version: "test"}, nil)
			s.AddReceivingMiddleware(observeMCPMethods)
			api := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(201)
				_, _ = w.Write([]byte(`{"id":"SECRET_RECORD"}`))
			})
			addMCPTool(s, api, "create", "test", false, func(c *Client, _ mcpSpace) (any, error) {
				if _, err := c.Must("POST", "/api/collections/pages/records", map[string]any{"slug": "SECRET_SLUG"}); err != nil {
					return nil, err
				}
				switch reason {
				case "limit_exceeded":
					return strings.Repeat("x", mcpResultLimit+1), nil
				case "cancelled":
					return nil, context.Canceled
				case "timeout":
					return nil, context.DeadlineExceeded
				default:
					return nil, errors.New("SECRET_ERROR")
				}
			})
			mcpCall(t, diagnosticMCPHandler(s, &logs), "SECRET_TOKEN", "create", map[string]any{}, true)
			events := diagnosticEvents(t, &logs)
			last := events[len(events)-1]
			if last["reason"] != reason || last["write_may_have_succeeded"] != true || last["api_calls"] != float64(1) {
				t.Fatalf("lost write uncertainty: %v", last)
			}
			if strings.Contains(logs.String(), "SECRET_") {
				t.Fatal("diagnostic leaked data")
			}
		})
	}
}

func TestMCPDiagnosticsAPILimitsAndTemplates(t *testing.T) {
	var logs bytes.Buffer
	s := mcp.NewServer(&mcp.Implementation{Name: "test", Version: "test"}, nil)
	s.AddReceivingMiddleware(observeMCPMethods)
	api := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("x", mcpAPILimit+1)))
	})
	addMCPTool(s, api, "original", "test", true, func(c *Client, _ mcpSpace) (any, error) {
		return c.Must("GET", "/api/files/sources/abcdefghijklmno/SECRET_FILENAME", nil)
	})
	mcpCall(t, diagnosticMCPHandler(s, &logs), "SECRET_TOKEN", "original", map[string]any{}, true)
	events := diagnosticEvents(t, &logs)
	last := events[len(events)-1]
	if last["reason"] != "limit_exceeded" || last["api_route"] != "/api/files/sources/{id}/{filename}" || last["write_may_have_succeeded"] != nil {
		t.Fatalf("unexpected limit metadata: %v", events)
	}
	if strings.Contains(logs.String(), "SECRET_") || strings.Contains(logs.String(), "abcdefghijklmno") {
		t.Fatal("diagnostic leaked file identity")
	}
}

func TestMCPDiagnosticsPreDispatchBoundary(t *testing.T) {
	// This SDK rejects unknown methods before receiving middleware. Do not imply
	// that absence of a method event proves protocol success; HTTP logging is a
	// separate transport observation and deliberately never buffers response bodies.
	var logs bytes.Buffer
	s := mcp.NewServer(&mcp.Implementation{Name: "test", Version: "test"}, nil)
	addMCPTools(s, http.NotFoundHandler())
	req := httptest.NewRequest("POST", "https://knowledge.example.com/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"SECRET_METHOD","params":{}}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("MCP-Protocol-Version", "2025-11-25")
	rec := httptest.NewRecorder()
	diagnosticMCPHandler(s, &logs).ServeHTTP(rec, req)
	if rec.Code != 400 {
		t.Fatalf("unknown method status %d", rec.Code)
	}
	if logs.Len() != 0 {
		t.Fatalf("unexpected pre-dispatch events: %s", logs.String())
	}
}

func TestMCPDiagnosticsBatchConflict(t *testing.T) {
	var logs bytes.Buffer
	s := mcp.NewServer(&mcp.Implementation{Name: "test", Version: "test"}, nil)
	s.AddReceivingMiddleware(observeMCPMethods)
	api := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(400)
		_, _ = w.Write([]byte(`{"data":{"requests":{"0":{"response":{"status":409,"message":"SECRET_CONFLICT"}}}}}`))
	})
	addMCPTool(s, api, "batch", "test", false, func(c *Client, _ mcpSpace) (any, error) { return c.Must("POST", "/api/batch", map[string]any{}) })
	mcpCall(t, diagnosticMCPHandler(s, &logs), "SECRET_TOKEN", "batch", map[string]any{}, true)
	events := diagnosticEvents(t, &logs)
	last := events[len(events)-1]
	if last["reason"] != "conflict" || last["api_status"] != float64(400) || last["write_may_have_succeeded"] != nil {
		t.Fatalf("missing batch conflict classification: %v", events)
	}
	if strings.Contains(logs.String(), "SECRET_") {
		t.Fatal("diagnostic leaked conflict body")
	}
}
