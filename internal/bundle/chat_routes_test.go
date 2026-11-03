package bundle

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"ganigeorgiev.com/pocketbase/pocketbase/apis"
	"ganigeorgiev.com/pocketbase/pocketbase/core"
	"github.com/pocketcontext-labs/pocketcontext/internal/chat"
)

func TestChatPublicAllowlist(t *testing.T) {
	for _, route := range []struct {
		method, path string
		want         bool
	}{
		{"GET", "/api/chat/status", true}, {"GET", "/api/chat/sessions", true}, {"POST", "/api/chat/sessions", true}, {"GET", "/api/chat/sessions/abc-123", true}, {"POST", "/api/chat/sessions/abc/permission", true}, {"POST", "/api/chat/sessions/abc/close", true},
		{"GET", "/api/chat/settings", false}, {"POST", "/api/chat/status", false}, {"DELETE", "/api/chat/sessions/abc", false}, {"GET", "/api/chat/sessions/abc/prompt", false}, {"POST", "/api/chat/sessions/abc/prompt/more", false}, {"POST", "/api/chat/sessions/../close", false}, {"GET", "/api/chat/sessions/a%2fb", false}, {"GET", "/api/chat/sessions/", false},
	} {
		if got := chatPublicRoute(route.method, route.path); got != route.want {
			t.Errorf("%s %s = %v", route.method, route.path, got)
		}
	}
}

func TestChatRoutesAuthenticationOriginAndStrictBodies(t *testing.T) {
	a := newTestApp(t)
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	manager, err := chat.New(chat.Config{Command: exe, Dir: t.TempDir(), StateDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { manager.Close() })
	router, err := apis.NewRouter(a.app)
	if err != nil {
		t.Fatal(err)
	}
	registerChat(&core.ServeEvent{App: a.app, Router: router}, manager)
	handler, err := router.BuildMux()
	if err != nil {
		t.Fatal(err)
	}
	request := func(method, path, body, token, origin string, want int) {
		t.Helper()
		req := httptest.NewRequest(method, "http://127.0.0.1:8096"+path, strings.NewReader(body))
		req.Header.Set("Authorization", token)
		req.Header.Set("Content-Type", "application/json")
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != want {
			t.Fatalf("%s %s: got %d want %d: %s", method, path, rec.Code, want, rec.Body.String())
		}
	}
	request("GET", "/api/chat/status", "", "", "", http.StatusUnauthorized)
	request("GET", "/api/chat/status", "", a.token, "http://evil.example", http.StatusForbidden)
	request("GET", "/api/chat/status", "", a.token, "http://127.0.0.1:8096", http.StatusOK)
	request("GET", "/api/chat/status?token=secret", "", a.token, "", http.StatusBadRequest)
	request("GET", "/api/chat/sessions", "", a.token, "", http.StatusOK)
	request("GET", "/api/chat/sessions/missing", "", a.token, "", http.StatusNotFound)
	for _, body := range []string{`{"requestId":"a","space":"missing","command":"sh"}`, `{} {}`, strings.Repeat(" ", 65<<10) + `{}`, `{"requestId":"a","space":"missing"}`} {
		request("POST", "/api/chat/sessions", body, a.token, "", http.StatusBadRequest)
	}
	request("POST", "/api/chat/sessions/missing/cancel", `{"anything":true}`, a.token, "", http.StatusBadRequest)
	request("POST", "/api/chat/sessions/missing/prompt", `{"requestId":"x","text":"hello","cwd":"/tmp"}`, a.token, "", http.StatusBadRequest)
	request("POST", "/api/chat/sessions/missing/permission", `{"requestId":"x","optionId":"allow","extra":true}`, a.token, "", http.StatusBadRequest)
}

func TestChatDisabledStatusStillRequiresAuthentication(t *testing.T) {
	a := newTestApp(t)
	router, err := apis.NewRouter(a.app)
	if err != nil {
		t.Fatal(err)
	}
	registerChat(&core.ServeEvent{App: a.app, Router: router}, nil)
	a.handler, err = router.BuildMux()
	if err != nil {
		t.Fatal(err)
	}
	a.request(t, "GET", "/api/chat/status", "", "", 401)
	status := a.request(t, "GET", "/api/chat/status", a.token, "", 200)
	if status["enabled"] != false {
		t.Fatal(status)
	}
	a.request(t, "POST", "/api/chat/sessions", a.token, "{}", 503)
}
