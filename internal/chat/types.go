// Package chat supervises opt-in ACP conversations independently of HTTP clients.
package chat

import (
	"encoding/json"
	"errors"
	"time"
)

var (
	ErrNotFound = errors.New("conversation not found")
	ErrBusy     = errors.New("conversation is busy")
	ErrConflict = errors.New("request conflicts with an earlier request")
	ErrLimit    = errors.New("chat limit reached; close an active conversation or start a new conversation after removing old history locally")
	ErrClosed   = errors.New("chat is stopping")
)

// Config is supplied by the host, never by browser requests. Command must name
// an installed executable. Dir and StateDir must be private machine-local paths.
type Config struct {
	KnowledgeBinary  string
	KnowledgeDB      string
	Command          string
	Args             []string
	Dir              string
	StateDir         string
	Env              []string
	Instructions     string
	MaxSessions      int
	MaxActive        int
	HandshakeTimeout time.Duration
	PromptTimeout    time.Duration
	CancelTimeout    time.Duration
}

type Status struct {
	AllowFullAccess bool   `json:"allowFullAccess"`
	AllowWorkspace  bool   `json:"allowWorkspace"`
	Enabled         bool   `json:"enabled"`
	Agent           string `json:"agent"`
	Active          int    `json:"active"`
	Sessions        int    `json:"sessions"`
}

type Event struct {
	Seq  uint64          `json:"seq"`
	Type string          `json:"type"`
	Text string          `json:"text,omitempty"`
	Data json.RawMessage `json:"data,omitempty"`
	Time string          `json:"time"`
}

type PermissionOption struct {
	OptionID string `json:"optionId"`
	Name     string `json:"name"`
	Kind     string `json:"kind"`
}

type Permission struct {
	ImportFile string             `json:"importFile,omitempty"`
	ID         string             `json:"id"`
	ToolCall   json.RawMessage    `json:"toolCall"`
	Options    []PermissionOption `json:"options"`
}

type ChatModel struct {
	ID   string `json:"modelId"`
	Name string `json:"name"`
}
type ModelState struct {
	Current string      `json:"currentModelId"`
	Default string      `json:"defaultModelId,omitempty"`
	Options []ChatModel `json:"availableModels"`
}
type PromptImage struct {
	MIME string `json:"mimeType"`
	Data string `json:"data"`
}
type Summary struct {
	Preview       string      `json:"preview,omitempty"`
	NeedsApproval bool        `json:"needsApproval,omitempty"`
	Models        *ModelState `json:"models,omitempty"`
	Images        bool        `json:"images,omitempty"`
	Pinned        bool        `json:"pinned,omitempty"`
	Archived      bool        `json:"archived,omitempty"`
	Title         string      `json:"title,omitempty"`
	Mode          string      `json:"mode"`
	ID            string      `json:"id"`
	Space         string      `json:"space"`
	Status        string      `json:"status"`
	Error         string      `json:"error,omitempty"`
	CanResume     bool        `json:"canResume"`
	LastSeq       uint64      `json:"lastSeq"`
	Created       string      `json:"created"`
	Updated       string      `json:"updated"`
}

type Snapshot struct {
	Summary
	Events      []Event      `json:"events"`
	Permissions []Permission `json:"permissions"`
}
