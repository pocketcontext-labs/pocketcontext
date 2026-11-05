// Package mcpobserve emits bounded operational metadata, never protocol payloads.
package mcpobserve

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"strings"
	"sync"
	"time"
)

type requestKey struct{}
type writerKey struct{}
type request struct{ ID, Domain, Revision string }

var outputMu sync.Mutex

// WithWriter supplies a private diagnostic sink, primarily for isolated tests.
func WithWriter(ctx context.Context, w io.Writer) context.Context {
	return context.WithValue(ctx, writerKey{}, w)
}

// WithRequest creates a server-generated identifier, never trusting client IDs.
// Domain and revision must come from validated server configuration, not headers.
func WithRequest(ctx context.Context, domain, revision string) (context.Context, string) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		panic("request identifier unavailable")
	}
	id := hex.EncodeToString(raw[:])
	return context.WithValue(ctx, requestKey{}, request{id, bounded(domain, 253), bounded(revision, 100)}), id
}

// Event has no arbitrary attribute map or error field: callers provide only
// fixed classifications and aggregate counts. Payloads must never enter it.
type Event struct {
	Event                 string `json:"event"`
	Method                string `json:"method,omitempty"`
	Tool                  string `json:"tool,omitempty"`
	Outcome               string `json:"outcome"`
	Reason                string `json:"reason,omitempty"`
	HTTPStatus            int    `json:"http_status,omitempty"`
	DurationMS            int64  `json:"duration_ms"`
	APICalls              int64  `json:"api_calls,omitempty"`
	ResponseBytes         int64  `json:"response_bytes,omitempty"`
	APIRoute              string `json:"api_route,omitempty"`
	APIStatus             int    `json:"api_status,omitempty"`
	WriteMayHaveSucceeded bool   `json:"write_may_have_succeeded,omitempty"`
}

func bounded(s string, n int) string {
	if len(s) > n {
		return "unknown"
	}
	return s
}
func listed(value, values string) string {
	if value == "" {
		return ""
	}
	for _, v := range strings.Fields(values) {
		if value == v {
			return v
		}
	}
	return "unknown"
}

// SafeMethod and SafeTool collapse client-controlled unknown names to a fixed label.
func SafeMethod(s string) string {
	return listed(s, "GET POST PATCH HEAD DELETE OPTIONS initialize ping tools/list tools/call notifications/initialized notifications/cancelled logging/setLevel")
}
func SafeTool(s string) string {
	return listed(s, "whoami schema query search search_sources get new_id create update batch list_spaces create_space rename_space archive_space restore_space default_space set_default_space ingest_text ingest_file extract pending original passages get_page lint stage check_run publish stage_home")
}

// Emit writes one JSON line atomically. Logging failures never change an operation's result.
func Emit(ctx context.Context, e Event) {
	r, ok := ctx.Value(requestKey{}).(request)
	if !ok {
		return
	}
	e.Event = listed(e.Event, "mcp_http oauth_complete mcp_complete mcp_api mcp_request")
	e.Method = SafeMethod(e.Method)
	e.Tool = SafeTool(e.Tool)
	e.Outcome = listed(e.Outcome, "success protocol_error tool_error transport_error internal_error error rejected denied cancelled timeout expected_probe")
	e.Reason = listed(e.Reason, `response_write_failed none operation_failed unavailable ok invalid_input invalid_arguments invalid_request unknown_method unknown_tool protocol_error tool_error internal_error conflict not_found limit_exceeded cancelled timeout unauthorized forbidden api_error result_too_large request_budget response_budget response_limit invalid_json invalid_params parse_error method_not_found validation_error cancellation deadline_exceeded auth_required invalid_token token_expired grant_revoked account_unavailable method_not_allowed registration_complete consent_required consent_approved consent_denied token_issued token_refreshed revoked connections_listed discovery script invalid_client_metadata invalid_redirect_uri unsupported_grant_type unsupported_response_type registration_unavailable duplicate_parameter unknown_client redirect_mismatch resource_mismatch pkce_method pkce_challenge state_too_large invalid_scope login_required approval_required pending_limit form_required invalid_client invalid_grant invalid_refresh refresh_replay persistence_failure token_required connection_required rate_limited invalid_target slow_down temporarily_unavailable`)
	// Routes are templates selected by code. No IDs, filenames or query strings.
	e.APIRoute = listed(e.APIRoute, `/mcp /.well-known/oauth-protected-resource /.well-known/oauth-protected-resource/mcp /.well-known/oauth-authorization-server /oauth/authorize /oauth/register /oauth/token /oauth/revoke /oauth/connections /oauth/app.js /api/context/schema /api/context/query /api/context/search /api/spaces/default /api/batch /api/files/token /api/files/sources/{id}/{filename} /api/pocketcontext/runs/{id}/check /api/collections/{collection}/records /api/collections/{collection}/records/{id}`)
	entry := struct {
		Time      string `json:"time"`
		Domain    string `json:"domain"`
		Revision  string `json:"revision"`
		RequestID string `json:"request_id"`
		Event
	}{time.Now().UTC().Format(time.RFC3339Nano), r.Domain, r.Revision, r.ID, e}
	data, err := json.Marshal(entry)
	if err != nil {
		return
	}
	data = append(data, '\n')
	w, _ := ctx.Value(writerKey{}).(io.Writer)
	if w == nil {
		w = os.Stderr
	}
	outputMu.Lock()
	defer outputMu.Unlock()
	_, _ = w.Write(data)
}
