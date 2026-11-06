package bundle

import (
	"encoding/json"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"ganigeorgiev.com/pocketbase/pocketbase/apis"
	"ganigeorgiev.com/pocketbase/pocketbase/core"
	"ganigeorgiev.com/pocketbase/pocketbase/tools/hook"
)

func TestHostedRateLimitAuthenticatedAndInvalidToken(t *testing.T) {
	a, h := hostedTestApp(t)
	request := func(token string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "http://knowledge.example.com/api/collections/pages/records", strings.NewReader(`{}`))
		r.RemoteAddr = "192.0.2.50:1000"
		r.Header.Set("Authorization", token)
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	// Empty payloads deliberately fail validation; valid authentication, rather
	// than successful writes or merely having an Authorization header, sets budget.
	for i := 0; i < 40; i++ {
		if w := request(a.token); w.Code == 429 {
			t.Fatalf("authenticated request %d: %s", i, w.Body)
		}
	}
	if w := request("invalid-token"); w.Code != 401 {
		t.Fatalf("invalid token admitted: %d", w.Code)
	}
	var last *httptest.ResponseRecorder
	for i := 0; i < 21; i++ {
		last = request("")
	}
	if last.Code != 429 {
		t.Fatalf("anonymous request got %d: %s", last.Code, last.Body)
	}
	assertRateMetadata(t, last, "pocketbase:*:create", 20, 5)
}

func assertRateMetadata(t *testing.T, w *httptest.ResponseRecorder, label string, capacity, retry int) {
	t.Helper()
	var body struct {
		Data struct {
			Rate rateLimitInfo `json:"rate_limit"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Data.Rate.Limit != label || body.Data.Rate.Capacity != capacity || body.Data.Rate.RetryAfterSeconds != retry {
		t.Fatalf("metadata: %+v, body %s", body.Data.Rate, w.Body)
	}
	for _, header := range []string{"Retry-After", "RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset"} {
		if w.Header().Get(header) == "" {
			t.Errorf("missing %s", header)
		}
	}
}

func TestHostedRateLimitChargesBatchBeforeExecution(t *testing.T) {
	a := newTestApp(t)
	configureHostedRateLimits(a.app)
	router, err := apis.NewRouter(a.app)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	registerHostedRateLimitsClock(&core.ServeEvent{App: a.app, Router: router}, func() time.Time { return now })
	// A small probe route demonstrates the middleware budget independent of DB
	// speed. It also verifies that rejected batch requests never enter a handler.
	calls := 0
	router.Bind(&hook.Handler[*core.RequestEvent]{Id: "probe", Priority: apis.DefaultLoadAuthTokenMiddlewarePriority + 7, Func: func(e *core.RequestEvent) error { calls++; return e.NoContent(204) }})
	h, err := router.BuildMux()
	if err != nil {
		t.Fatal(err)
	}
	// Freeze time so only admission cost determines the result.
	start := time.Now()
	var rejected bool
	for i := 0; i < 61; i++ {
		r := httptest.NewRequest("POST", "http://localhost/api/batch", nil)
		token, err := a.user.NewAuthToken()
		if err != nil {
			t.Fatal(err)
		}
		r.Header.Set("Authorization", token)
		r.RemoteAddr = "192.0.2." + strconv.Itoa(i+1) + ":1234"
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code == 429 {
			rejected = true
			assertRateMetadata(t, w, "authenticated_knowledge", hostedKnowledgeBurst, 1)
			if calls != 60 {
				t.Fatalf("premature limit: %d", calls)
			}
			break
		}
	}
	if !rejected {
		t.Fatalf("no bounded limit after %s", time.Since(start))
	}
}

func TestPublicAuthRejectionMetadata(t *testing.T) {
	l := &publicAuthLimiter{}
	for i := 0; i < 10; i++ {
		if !l.allow("192.0.2.1:1") {
			t.Fatal("early rejection")
		}
	}
	if l.allow("192.0.2.1:2") {
		t.Fatal("port changed budget")
	}
	info := l.rejection("192.0.2.1:3", "public_auth")
	if info.RetryAfterSeconds != 6 || info.Capacity != 10 || info.Remaining != 0 {
		t.Fatalf("%+v", info)
	}
}

func TestHostedRateLimitNestedBatchPreservesCustomRule(t *testing.T) {
	a := newTestApp(t)
	a.app.Settings().RateLimits.Rules = append([]core.RateLimitRule{{Label: "pages:create", Audience: core.RateLimitRuleAudienceAuth, MaxRequests: 1, Duration: 60}}, a.app.Settings().RateLimits.Rules...)
	configureHostedRateLimits(a.app)
	r, err := apis.NewRouter(a.app)
	if err != nil {
		t.Fatal(err)
	}
	registerHostedRateLimits(&core.ServeEvent{App: a.app, Router: r})
	if err := a.app.OnServe().Trigger(&core.ServeEvent{App: a.app, Router: r}); err != nil {
		t.Fatal(err)
	}
	h, err := r.BuildMux()
	if err != nil {
		t.Fatal(err)
	}
	body := `{"requests":[{"method":"POST","url":"/api/collections/pages/records","body":{"slug":"rate-first","kind":"concept"}},{"method":"POST","url":"/api/collections/pages/records","body":{"slug":"rate-second","kind":"concept"}}]}`
	req := httptest.NewRequest("POST", "http://localhost/api/batch", strings.NewReader(body))
	req.Header.Set("Authorization", a.token)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 400 {
		t.Fatalf("want outer400: %d %s", w.Code, w.Body)
	}
	assertRateMetadata(t, w, "pocketbase:pages:create", 1, 60)
	var parsed map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &parsed); err != nil {
		t.Fatal(err)
	}
	inner := parsed["data"].(map[string]any)["requests"].(map[string]any)["1"].(map[string]any)["response"].(map[string]any)
	if inner["status"] != float64(429) || inner["data"].(map[string]any)["rate_limit"] == nil {
		t.Fatalf("inner metadata missing: %v", inner)
	}
	pages, err := a.app.FindAllRecords("pages")
	if err != nil || len(pages) != 0 {
		t.Fatalf("batch rollback: %d pages, %v", len(pages), err)
	}
}
