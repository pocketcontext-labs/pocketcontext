package client

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/pocketcontext-labs/pocketcontext/internal/mcpobserve"
)

// Diagnostic reasons are assigned at controlled call sites. Error messages may
// contain SQL, document content or API responses and must never reach the log.
type mcpClassifiedError struct {
	reason string
	err    error
}

func (e *mcpClassifiedError) Error() string { return e.err.Error() }
func (e *mcpClassifiedError) Unwrap() error { return e.err }
func mcpDiagnosticError(reason, message string) error {
	return &mcpClassifiedError{reason: reason, err: errors.New(message)}
}
func mcpFailureReason(err error, status int) string {
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	if errors.Is(err, context.Canceled) {
		return "cancelled"
	}
	var classified *mcpClassifiedError
	if errors.As(err, &classified) {
		return classified.reason
	}
	var limited *RateLimitError
	if errors.As(err, &limited) {
		return "rate_limited"
	}
	var failure *Fail
	if errors.As(err, &failure) && failure.Code == 4 {
		return "conflict"
	}
	switch status {
	case 400, 422:
		return "invalid_input"
	case 401:
		return "unauthorized"
	case 403:
		return "forbidden"
	case 404:
		return "not_found"
	case 409:
		return "conflict"
	case 429:
		return "rate_limited"
	case 503:
		return "unavailable"
	}
	if status >= 500 {
		return "internal_error"
	}
	if status >= 400 {
		return "api_error"
	}
	if err != nil {
		return "operation_failed"
	}
	return "none"
}

type mcpObservationKey struct{}
type mcpObservation struct {
	mu                     sync.Mutex
	calls, bytes           int64
	reason, route          string
	status                 int
	invoked, possibleWrite bool
}

func mcpObservationFrom(ctx context.Context) *mcpObservation {
	o, _ := ctx.Value(mcpObservationKey{}).(*mcpObservation)
	return o
}
func (o *mcpObservation) startedTool() { o.mu.Lock(); o.invoked = true; o.mu.Unlock() }
func (o *mcpObservation) toolError(err, contextErr error) {
	if err == nil {
		return
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	reason := mcpFailureReason(err, 0)
	if contextErr != nil {
		reason = mcpFailureReason(contextErr, 0)
	}
	if reason != "operation_failed" || o.reason == "" {
		o.reason = reason
	}
}
func (o *mcpObservation) api(method, route string, status int, size int64, dispatched bool, err error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if dispatched {
		o.calls++
	}
	o.bytes += size
	// POST query/search/token routes do not mutate knowledge. Other allowed
	// POST/PATCH operations may have committed before a failure reaches us.
	mutation := (method == "POST" || method == "PATCH") && route != "/api/context/query" && route != "/api/context/search" && route != "/api/files/token"
	if dispatched && mutation && (status == 0 || status >= 500 || status >= 200 && status < 300 || err != nil) {
		o.possibleWrite = true
	}
	if err != nil || status >= 400 {
		o.reason, o.route, o.status = mcpFailureReason(err, status), route, status
	}
}

func observeMCPMethods(next mcp.MethodHandler) mcp.MethodHandler {
	return func(ctx context.Context, method string, req mcp.Request) (result mcp.Result, err error) {
		started := time.Now()
		o := &mcpObservation{}
		ctx = context.WithValue(ctx, mcpObservationKey{}, o)
		tool := ""
		if params, ok := req.GetParams().(*mcp.CallToolParamsRaw); ok && params != nil {
			tool = mcpobserve.SafeTool(params.Name)
		}
		event := mcpobserve.Event{Event: "mcp_complete", Method: mcpobserve.SafeMethod(method), Tool: tool, Outcome: "internal_error", Reason: "internal_error"}
		// The default event also covers a panic without intercepting it or logging
		// its arbitrary value. The surrounding HTTP server keeps its panic policy.
		defer func() {
			event.DurationMS = time.Since(started).Milliseconds()
			o.mu.Lock()
			event.APICalls, event.ResponseBytes = o.calls, o.bytes
			event.APIRoute, event.APIStatus = o.route, o.status
			event.WriteMayHaveSucceeded = event.Outcome != "success" && o.possibleWrite
			o.mu.Unlock()
			mcpobserve.Emit(ctx, event)
		}()
		result, err = next(ctx, method, req)
		o.mu.Lock()
		defer o.mu.Unlock()
		event.Outcome, event.Reason = "success", "none"
		if err != nil {
			event.Outcome, event.Reason = "protocol_error", "invalid_input"
			if method == "tools/call" && tool == "unknown" {
				event.Reason = "unknown_tool"
			}
		}
		if call, ok := result.(*mcp.CallToolResult); ok && call != nil && call.IsError {
			event.Outcome, event.Reason = "tool_error", "invalid_input"
			if o.invoked {
				event.Reason = "operation_failed"
			}
		}
		if event.Outcome != "success" && o.reason != "" {
			event.Reason = o.reason
		}
		if ctx.Err() != nil {
			event.Reason = mcpFailureReason(ctx.Err(), 0)
		}
		if event.Reason == "cancelled" || event.Reason == "timeout" {
			event.Outcome = event.Reason
		}
		return result, err
	}
}

// Route templates retain diagnostic value without IDs, filenames or queries.
func mcpAPIRoute(method, path string) string {
	if !mcpAPIAllowed(method, path) {
		return "unknown"
	}
	switch path {
	case "/api/context/schema", "/api/spaces/default", "/api/context/query", "/api/context/search", "/api/batch", "/api/files/token":
		return path
	}
	if strings.HasPrefix(path, "/api/files/sources/") {
		return "/api/files/sources/{id}/{filename}"
	}
	if strings.HasPrefix(path, "/api/pocketcontext/runs/") {
		return "/api/pocketcontext/runs/{id}/check"
	}
	if strings.HasSuffix(path, "/records") {
		return "/api/collections/{collection}/records"
	}
	return "/api/collections/{collection}/records/{id}"
}
