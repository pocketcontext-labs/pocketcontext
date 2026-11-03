package chat

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const maxEvents = 4096
const maxHistoryBytes = 8 << 20

var ErrInvalid = errors.New("invalid chat request")

type session struct {
	Summary
	RequestID   string            `json:"requestId"`
	AgentID     string            `json:"agentId"`
	Load        bool              `json:"load"`
	Events      []Event           `json:"events"`
	Requests    map[string]string `json:"requests"`
	mu          sync.Mutex
	process     *rpc
	permissions map[string]pendingPermission
	decisions   map[string]string
	replay      bool
	turn        uint64
	generation  uint64
}
type pendingPermission struct {
	Permission
	wireID json.RawMessage
}
type Manager struct {
	mu       sync.Mutex
	c        Config
	sessions map[string]*session
	closed   bool
}

func now() string { return time.Now().UTC().Format(time.RFC3339Nano) }
func randomID() string {
	b := make([]byte, 16)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b)
}
func New(c Config) (*Manager, error) {
	if !filepath.IsAbs(c.Command) || !filepath.IsAbs(c.Dir) || !filepath.IsAbs(c.StateDir) {
		return nil, fmt.Errorf("chat paths must be absolute")
	}
	if c.MaxSessions <= 0 {
		c.MaxSessions = 64
	}
	if c.MaxActive <= 0 {
		c.MaxActive = 4
	}
	if c.HandshakeTimeout <= 0 {
		c.HandshakeTimeout = 30 * time.Second
	}
	if c.PromptTimeout <= 0 {
		c.PromptTimeout = 30 * time.Minute
	}
	if c.CancelTimeout <= 0 {
		c.CancelTimeout = 3 * time.Second
	}
	for _, p := range []string{c.Dir, c.StateDir} {
		if e := os.MkdirAll(p, 0700); e != nil {
			return nil, e
		}
	}
	// These constraints override inherited or locally configured provider policy.
	env := []string{}
	for _, v := range c.Env {
		if !strings.HasPrefix(v, "INITIAL_AGENT_MODE=") && !strings.HasPrefix(v, "CODEX_CONFIG=") {
			env = append(env, v)
		}
	}
	c.Env = append(env, "INITIAL_AGENT_MODE=read-only", `CODEX_CONFIG={"approval_policy":"on-request","sandbox_mode":"read-only"}`)
	m := &Manager{c: c, sessions: map[string]*session{}}
	files, e := os.ReadDir(c.StateDir)
	if e != nil {
		return nil, e
	}
	for _, f := range files {
		if !strings.HasSuffix(f.Name(), ".json") {
			continue
		}
		if len(m.sessions) >= c.MaxSessions {
			return nil, ErrLimit
		}
		info, e := f.Info()
		if e != nil || !info.Mode().IsRegular() || info.Size() > maxHistoryBytes {
			return nil, errors.New("invalid chat history file")
		}
		b, e := os.ReadFile(filepath.Join(c.StateDir, f.Name()))
		if e != nil {
			return nil, e
		}
		s := &session{}
		if e = json.Unmarshal(b, s); e != nil {
			return nil, e
		}
		if len(s.ID) != 32 || f.Name() != s.ID+".json" || len(s.Events) > maxEvents {
			return nil, errors.New("invalid conversation history")
		}
		if _, e = hex.DecodeString(s.ID); e != nil {
			return nil, e
		}
		s.permissions = map[string]pendingPermission{}
		s.decisions = map[string]string{}
		if s.Requests == nil {
			s.Requests = map[string]string{}
		}
		s.Status = "interrupted"
		s.Error = "Server restarted; previous work was not replayed."
		s.CanResume = s.Load && s.AgentID != ""
		m.sessions[s.ID] = s
	}
	return m, nil
}
func (m *Manager) save(s *session) error {
	b, e := json.Marshal(s)
	if e != nil {
		return e
	}
	if len(b) > maxHistoryBytes {
		return ErrLimit
	}
	f, e := os.CreateTemp(m.c.StateDir, ".chat-")
	if e != nil {
		return e
	}
	name := f.Name()
	defer os.Remove(name)
	if _, e = f.Write(b); e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e == nil {
		e = ce
	}
	if e != nil {
		return e
	}
	if err := os.Rename(name, filepath.Join(m.c.StateDir, s.ID+".json")); err != nil {
		return err
	}
	return syncStateDirectory(m.c.StateDir)
}
func (s *session) add(typ, text string, data json.RawMessage) error {
	if len(s.Events) >= maxEvents {
		return ErrLimit
	}
	s.LastSeq++
	s.Updated = now()
	s.Events = append(s.Events, Event{Seq: s.LastSeq, Type: typ, Text: text, Data: data, Time: s.Updated})
	return nil
}
func (m *Manager) get(id string) (*session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, ErrClosed
	}
	s := m.sessions[id]
	if s == nil {
		return nil, ErrNotFound
	}
	return s, nil
}
func snapshot(s *session, after uint64) Snapshot {
	v := Snapshot{Summary: s.Summary, Events: []Event{}, Permissions: []Permission{}}
	for _, e := range s.Events {
		if e.Seq > after {
			e.Data = append(json.RawMessage(nil), e.Data...)
			v.Events = append(v.Events, e)
		}
	}
	for _, p := range s.permissions {
		v.Permissions = append(v.Permissions, p.Permission)
	}
	return v
}
func (m *Manager) Snapshot(id string, after uint64) (Snapshot, error) {
	s, e := m.get(id)
	if e != nil {
		return Snapshot{}, e
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return snapshot(s, after), nil
}
func (m *Manager) List() []Summary {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Summary{}
	for _, s := range m.sessions {
		s.mu.Lock()
		out = append(out, s.Summary)
		s.mu.Unlock()
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Updated > out[j].Updated })
	return out
}
func (m *Manager) Status() Status {
	list := m.List()
	v := Status{Enabled: true, Agent: "codex-acp", Sessions: len(list)}
	for _, s := range list {
		if s.Status == "idle" || s.Status == "running" || s.Status == "initializing" || s.Status == "cancelling" {
			v.Active++
		}
	}
	return v
}
func validKey(s string) bool {
	return len(s) > 0 && len(s) <= 128 && !strings.ContainsAny(s, "\x00\r\n")
}
func (m *Manager) Create(ctx context.Context, requestID, space string) (Snapshot, error) {
	if !validKey(requestID) || !validKey(space) {
		return Snapshot{}, ErrInvalid
	}
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return Snapshot{}, ErrClosed
	}
	active := 0
	for _, s := range m.sessions {
		s.mu.Lock()
		if s.RequestID == requestID {
			if s.Space != space {
				s.mu.Unlock()
				m.mu.Unlock()
				return Snapshot{}, ErrConflict
			}
			v := snapshot(s, 0)
			s.mu.Unlock()
			m.mu.Unlock()
			return v, nil
		}
		if s.process != nil || s.Status == "initializing" {
			active++
		}
		s.mu.Unlock()
	}
	if len(m.sessions) >= m.c.MaxSessions || active >= m.c.MaxActive {
		m.mu.Unlock()
		return Snapshot{}, ErrLimit
	}
	id := randomID()
	s := &session{Summary: Summary{ID: id, Space: space, Status: "initializing", Created: now(), Updated: now()}, RequestID: requestID, Events: []Event{}, Requests: map[string]string{}, permissions: map[string]pendingPermission{}, decisions: map[string]string{}, generation: 1}
	if e := m.save(s); e != nil {
		m.mu.Unlock()
		return Snapshot{}, e
	}
	m.sessions[id] = s
	m.mu.Unlock()
	e := m.start(ctx, s, false, 1)
	s.mu.Lock()
	defer s.mu.Unlock()
	return snapshot(s, 0), e
}
func (m *Manager) start(ctx context.Context, s *session, resume bool, generation uint64) error {
	dir := filepath.Join(m.c.Dir, s.ID)
	if e := os.MkdirAll(dir, 0700); e != nil {
		return m.failed(s, generation, errors.New("Could not prepare or start the configured agent"))
	}
	instructions := m.c.Instructions + "\n\nThe selected PocketContext space ID is " + s.Space + ". Use this space explicitly for all knowledge operations.\n"
	if e := os.WriteFile(filepath.Join(dir, "AGENTS.md"), []byte(instructions), 0600); e != nil {
		return m.failed(s, generation, errors.New("Could not prepare or start the configured agent"))
	}
	m.mu.Lock()
	s.mu.Lock()
	if m.closed || s.Status != "initializing" || s.generation != generation || s.process != nil {
		s.mu.Unlock()
		m.mu.Unlock()
		return ErrClosed
	}
	s.replay = resume
	resumeID := s.AgentID
	r, e := launch(m.c, dir, func(w wire) { m.receive(s, generation, w) }, func() { m.exited(s, generation) })
	if e != nil {
		s.mu.Unlock()
		m.mu.Unlock()
		return m.failed(s, generation, errors.New("Could not prepare or start the configured agent"))
	}
	s.process = r
	s.mu.Unlock()
	m.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), m.c.HandshakeTimeout)
	defer cancel()
	var init struct {
		ProtocolVersion   int `json:"protocolVersion"`
		AgentCapabilities struct {
			LoadSession bool `json:"loadSession"`
		} `json:"agentCapabilities"`
	}
	e = r.call(ctx, "initialize", map[string]any{"protocolVersion": 1, "clientInfo": map[string]string{"name": "pocketcontext", "version": "0.19.0"}, "clientCapabilities": map[string]any{"fs": map[string]bool{"readTextFile": false, "writeTextFile": false}, "terminal": false}}, &init)
	if e != nil || init.ProtocolVersion != 1 {
		r.stop()
		return m.failed(s, generation, errors.New("agent initialization failed; verify adapter installation and provider authentication"))
	}
	var result struct {
		SessionID string `json:"sessionId"`
		Modes     *struct {
			CurrentModeID  string `json:"currentModeId"`
			AvailableModes []struct {
				ID string `json:"id"`
			} `json:"availableModes"`
		} `json:"modes"`
	}
	params := map[string]any{"cwd": dir, "mcpServers": []any{}}
	method := "session/new"
	if resume {
		if !init.AgentCapabilities.LoadSession {
			r.stop()
			return m.failed(s, generation, errors.New("adapter does not support conversation loading"))
		}
		method = "session/load"
		params["sessionId"] = resumeID
	}
	if e = r.call(ctx, method, params, &result); e != nil {
		r.stop()
		return m.failed(s, generation, errors.New("agent could not open conversation; verify provider authentication"))
	}
	agentID := result.SessionID
	if resume {
		agentID = resumeID
	}
	if agentID == "" {
		r.stop()
		return m.failed(s, generation, errors.New("agent returned no session ID"))
	}
	readonly := false
	if result.Modes != nil {
		for _, mode := range result.Modes.AvailableModes {
			if mode.ID == "read-only" {
				readonly = true
			}
		}
	}
	if !readonly {
		r.stop()
		return m.failed(s, generation, errors.New("adapter must support read-only mode"))
	}
	if e = r.call(ctx, "session/set_mode", map[string]string{"sessionId": agentID, "modeId": "read-only"}, nil); e != nil {
		r.stop()
		return m.failed(s, generation, errors.New("agent refused read-only mode"))
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.process != r || s.Status != "initializing" || s.generation != generation {
		r.stop()
		return ErrClosed
	}
	s.AgentID = agentID
	s.Load = init.AgentCapabilities.LoadSession
	s.CanResume = s.Load
	s.replay = false
	s.Status = "idle"
	s.Error = ""
	s.add("status", "Ready", nil)
	if e = m.save(s); e != nil {
		r.stop()
		s.Status = "error"
		return e
	}
	return nil
}
func (m *Manager) failed(s *session, generation uint64, e error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.Status == "closed" || s.generation != generation {
		return e
	}
	s.Status = "error"
	s.Error = e.Error()
	s.add("error", e.Error(), nil)
	_ = m.save(s)
	return e
}
func (m *Manager) exited(s *session, generation uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if generation != s.generation {
		return
	}
	s.process = nil
	s.permissions = map[string]pendingPermission{}
	if s.Status != "closed" && s.Status != "error" {
		s.Status = "interrupted"
		s.Error = "Agent stopped; work was not replayed."
		s.add("error", s.Error, nil)
	}
	_ = m.save(s)
}
func (m *Manager) Resume(ctx context.Context, id string) error {
	s, e := m.get(id)
	if e != nil {
		return e
	}
	m.mu.Lock()
	active := 0
	for _, v := range m.sessions {
		v.mu.Lock()
		if v.process != nil || v.Status == "initializing" {
			active++
		}
		v.mu.Unlock()
	}
	s.mu.Lock()
	if active >= m.c.MaxActive {
		s.mu.Unlock()
		m.mu.Unlock()
		return ErrLimit
	}
	if s.process != nil || s.Status == "initializing" {
		s.mu.Unlock()
		m.mu.Unlock()
		return ErrBusy
	}
	if !s.CanResume {
		s.mu.Unlock()
		m.mu.Unlock()
		return ErrConflict
	}
	if m.closed {
		s.mu.Unlock()
		m.mu.Unlock()
		return ErrClosed
	}
	s.generation++
	generation := s.generation
	s.Status = "initializing"
	e = m.save(s)
	if e != nil {
		s.Status = "error"
		s.Error = "Conversation could not be resumed because history could not be saved."
	}
	s.mu.Unlock()
	m.mu.Unlock()
	if e != nil {
		return e
	}
	return m.start(ctx, s, true, generation)
}
