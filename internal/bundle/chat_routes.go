package bundle

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"ganigeorgiev.com/pocketbase/pocketbase/apis"
	"ganigeorgiev.com/pocketbase/pocketbase/core"
	"github.com/pocketcontext-labs/pocketcontext/internal/chat"
)

// chatPublicRoute deliberately admits only the browser-facing conversation API.
func chatPublicRoute(method, path string) bool {
	if path == "/api/chat/status" {
		return method == http.MethodGet
	}
	if path == "/api/chat/sessions" {
		return method == http.MethodGet || method == http.MethodPost
	}
	parts := strings.Split(strings.TrimPrefix(path, "/api/chat/sessions/"), "/")
	if !strings.HasPrefix(path, "/api/chat/sessions/") || len(parts) < 1 || parts[0] == "" {
		return false
	}
	for _, c := range parts[0] {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	if len(parts) == 1 {
		return method == http.MethodGet
	}
	if len(parts) != 2 || method != http.MethodPost {
		return false
	}
	switch parts[1] {
	case "mode", "organize", "prompt", "permission", "cancel", "resume", "close":
		return true
	}
	return false
}

func chatJSON(re *core.RequestEvent, out any) error {
	limit := int64(64 << 10)
	if strings.HasSuffix(re.Request.URL.Path, "/prompt") {
		limit = 2 << 20
	}
	re.Request.Body = http.MaxBytesReader(re.Response, re.Request.Body, limit)
	data, err := io.ReadAll(re.Request.Body)
	if err != nil || len(bytes.TrimSpace(data)) == 0 || bytes.TrimSpace(data)[0] != '{' {
		return re.BadRequestError("Invalid chat request body.", nil)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		return re.BadRequestError("Invalid chat request body.", nil)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return re.BadRequestError("Invalid chat request body.", nil)
	}
	return nil
}
func chatError(re *core.RequestEvent, err error) error {
	switch {
	case errors.Is(err, chat.ErrNotFound):
		return re.NotFoundError("Conversation not found.", nil)
	case errors.Is(err, chat.ErrInvalid):
		return re.BadRequestError("Invalid chat request.", nil)
	case errors.Is(err, chat.ErrLimit):
		return apis.NewApiError(http.StatusConflict, "Chat limit reached. If all agents are busy, try again when a turn finishes. For a full transcript, start a new chat.", nil)
	case errors.Is(err, chat.ErrBusy), errors.Is(err, chat.ErrConflict):
		return apis.NewApiError(http.StatusConflict, "Conversation is busy or the request conflicts with its current state.", nil)
	default:
		return apis.NewApiError(http.StatusServiceUnavailable, "Chat is unavailable. Check the agent on the host computer.", nil)
	}
}

func registerChat(e *core.ServeEvent, manager *chat.Manager) {
	handler := func(re *core.RequestEvent) error {
		re.Response.Header().Set("Cache-Control", "no-store")
		scheme, host := "http", re.Request.Host
		if re.Request.TLS != nil {
			scheme = "https"
			host = strings.TrimSuffix(host, ":443")
		} else {
			host = strings.TrimSuffix(host, ":80")
		}
		if origin := re.Request.Header.Get("Origin"); origin != "" && origin != scheme+"://"+host {
			return re.ForbiddenError("Unexpected chat origin.", nil)
		}
		if re.Request.URL.RawQuery != "" {
			return re.BadRequestError("Chat requests do not accept query parameters.", nil)
		}
		if re.Request.URL.Path == "/api/chat/status" {
			if manager == nil {
				return re.JSON(http.StatusOK, map[string]bool{"enabled": false})
			}
			return re.JSON(http.StatusOK, manager.Status())
		}
		if manager == nil {
			return chatError(re, chat.ErrClosed)
		}
		path := re.Request.URL.Path
		if path == "/api/chat/sessions" {
			if re.Request.Method == http.MethodGet {
				return re.JSON(http.StatusOK, map[string]any{"sessions": manager.List()})
			}
			var body struct {
				RequestID string `json:"requestId"`
				Space     string `json:"space"`
				Mode      string `json:"mode"`
			}
			if err := chatJSON(re, &body); err != nil {
				return err
			}
			if _, err := re.App.FindRecordById("spaces", body.Space); err != nil {
				return re.BadRequestError("Choose an existing space.", nil)
			}
			snapshot, err := manager.CreateWithMode(re.Request.Context(), body.RequestID, body.Space, body.Mode)
			if err != nil {
				return chatError(re, err)
			}
			return re.JSON(http.StatusOK, snapshot)
		}
		id := re.Request.PathValue("id")
		if re.Request.Method == http.MethodPost {
			var err error
			switch {
			case strings.HasSuffix(path, "/mode"):
				var body struct {
					Mode string `json:"mode"`
				}
				if err := chatJSON(re, &body); err != nil {
					return err
				}
				err = manager.SetMode(re.Request.Context(), id, body.Mode)
			case strings.HasSuffix(path, "/organize"):
				var body struct {
					Action string `json:"action"`
				}
				if err := chatJSON(re, &body); err != nil {
					return err
				}
				err = manager.Organize(id, body.Action)
			case strings.HasSuffix(path, "/prompt"):
				var body struct {
					RequestID string             `json:"requestId"`
					Text      string             `json:"text"`
					Images    []chat.PromptImage `json:"images"`
					Model     string             `json:"model"`
				}
				if err := chatJSON(re, &body); err != nil {
					return err
				}
				err = manager.PromptWithOptions(id, body.RequestID, body.Text, body.Model, body.Images)
			case strings.HasSuffix(path, "/permission"):
				var body struct {
					RequestID string `json:"requestId"`
					OptionID  string `json:"optionId"`
				}
				if err := chatJSON(re, &body); err != nil {
					return err
				}
				err = manager.Permission(id, body.RequestID, body.OptionID)
			default:
				if err := chatJSON(re, &struct{}{}); err != nil {
					return err
				}
				switch {
				case strings.HasSuffix(path, "/cancel"):
					err = manager.Cancel(id)
				case strings.HasSuffix(path, "/resume"):
					err = manager.Resume(re.Request.Context(), id)
				case strings.HasSuffix(path, "/close"):
					err = manager.CloseSession(id)
				}
			}
			if err != nil {
				return chatError(re, err)
			}
		}
		snapshot, err := manager.Snapshot(id, 0)
		if err != nil {
			return chatError(re, err)
		}
		return re.JSON(http.StatusOK, snapshot)
	}
	for _, path := range []string{"/api/chat/status", "/api/chat/sessions", "/api/chat/sessions/{id}"} {
		e.Router.GET(path, handler).Bind(apis.RequireAuth("users"))
	}
	for _, path := range []string{"/api/chat/sessions", "/api/chat/sessions/{id}/mode", "/api/chat/sessions/{id}/organize", "/api/chat/sessions/{id}/prompt", "/api/chat/sessions/{id}/permission", "/api/chat/sessions/{id}/cancel", "/api/chat/sessions/{id}/resume", "/api/chat/sessions/{id}/close"} {
		e.Router.POST(path, handler).Bind(apis.RequireAuth("users"))
	}
}
