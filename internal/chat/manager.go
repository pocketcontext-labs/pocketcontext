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
	CreatedMode  string            `json:"createdMode"`
	RequestID    string            `json:"requestId"`
	AgentID      string            `json:"agentId"`
	Load         bool              `json:"load"`
	Events       []Event           `json:"events"`
	Requests     map[string]string `json:"requests"`
	mu           sync.Mutex
	process      *rpc
	permissions  map[string]pendingPermission
	decisions    map[string]string
	changingMode string
	replay       bool
	turn         uint64
	generation   uint64
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
	c.Env = env
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
		for _, event := range s.Events {
			if s.Title == "" && event.Type == "user" {
				s.Title = conversationTitle(event.Text)
				break
			}
		}
		if s.Mode == "" {
			s.Mode = "read-only"
		}
		if s.CreatedMode == "" {
			s.CreatedMode = s.Mode
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
func (m *Manager) Organize(id, action string) error {
	s, err := m.get(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	previous := s.Summary
	switch action {
	case "pin":
		if s.Archived {
			return ErrConflict
		}
		s.Pinned = true
	case "unpin":
		s.Pinned = false
	case "archive":
		s.Archived = true
		s.Pinned = false
	case "restore":
		s.Archived = false
	default:
		return ErrInvalid
	}
	if err := m.save(s); err != nil {
		s.Summary = previous
		return err
	}
	return nil
}
func historySummary(s *session) Summary {
	row := s.Summary
	row.NeedsApproval = len(s.permissions) > 0
	for i := len(s.Events) - 1; i >= 0; i-- {
		e := s.Events[i]
		if e.Type != "agent" && e.Type != "user" {
			continue
		}
		if e.Type == "user" && e.Text == "" {
			row.Preview = "Image attachment"
			break
		}
		if e.Text == "" {
			continue
		}
		start := i
		if e.Type == "agent" {
			for start > 0 && s.Events[start-1].Type == "agent" {
				start--
			}
		}
		var text strings.Builder
		for j := start; j <= i && text.Len() < 512; j++ {
			text.WriteString(s.Events[j].Text)
		}
		row.Preview = conversationTitle(text.String())
		break
	}
	return row
}
func snapshot(s *session, after uint64) Snapshot {
	v := Snapshot{Summary: historySummary(s), Events: []Event{}, Permissions: []Permission{}}
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
func conversationTitle(text string) string {
	chars := []rune(strings.Join(strings.Fields(text), " "))
	if len(chars) > 80 {
		return string(chars[:79]) + "…"
	}
	return string(chars)
}
func (m *Manager) List() []Summary {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Summary{}
	for _, s := range m.sessions {
		s.mu.Lock()
		out = append(out, historySummary(s))
		s.mu.Unlock()
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Updated > out[j].Updated })
	return out
}
func (m *Manager) Status() Status {
	list := m.List()
	v := Status{AllowFullAccess: true, AllowWorkspace: true, Enabled: true, Agent: "codex-acp", Sessions: len(list)}
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
	return m.CreateWithMode(ctx, requestID, space, "read-only")
}
func (m *Manager) CreateWithMode(ctx context.Context, requestID, space, mode string) (Snapshot, error) {
	if mode == "" {
		mode = "read-only"
	}
	if !m.allowsMode(mode) || !validKey(requestID) || !validKey(space) {
		return Snapshot{}, ErrInvalid
	}
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return Snapshot{}, ErrClosed
	}

	for _, s := range m.sessions {
		s.mu.Lock()
		if s.RequestID == requestID {
			if s.Space != space || s.CreatedMode != mode {
				s.mu.Unlock()
				m.mu.Unlock()
				return Snapshot{}, ErrConflict
			}
			v := snapshot(s, 0)
			s.mu.Unlock()
			m.mu.Unlock()
			return v, nil
		}

		s.mu.Unlock()
	}
	if len(m.sessions) >= m.c.MaxSessions {
		m.mu.Unlock()
		return Snapshot{}, ErrLimit
	}
	if err := m.makeRoom(); err != nil {
		m.mu.Unlock()
		return Snapshot{}, err
	}
	id := randomID()
	s := &session{Summary: Summary{Mode: mode, ID: id, Space: space, Status: "initializing", Created: now(), Updated: now()}, RequestID: requestID, CreatedMode: mode, Events: []Event{}, Requests: map[string]string{}, permissions: map[string]pendingPermission{}, decisions: map[string]string{}, generation: 1}
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
func (m *Manager) allowsMode(mode string) bool {
	return mode == "read-only" || mode == "workspace-write" || mode == "agent-full-access"
}
func (m *Manager) start(ctx context.Context, s *session, resume bool, generation uint64) error {
	if !m.allowsMode(s.Mode) {
		return m.failed(s, generation, errors.New("invalid conversation permission mode"))
	}
	dir := filepath.Join(m.c.Dir, s.ID)
	if e := os.MkdirAll(dir, 0700); e != nil {
		return m.failed(s, generation, errors.New("Could not prepare or start the configured agent"))
	}
	instructions := m.c.Instructions + "\n\nThe selected PocketContext space ID is " + s.Space + ". Use this space explicitly for all knowledge operations. In replies, link each page result with [Title](page:slug) and each source result with [Title](source:id), using the exact slug or source ID returned by the authenticated query. Retrieve those identifiers with the results; never guess them.\n"
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
	config := m.c
	approval, sandbox := "on-request", s.Mode
	if s.Mode == "agent-full-access" {
		approval, sandbox = "never", "danger-full-access"
	}
	config.Env = append(append([]string{}, config.Env...), "INITIAL_AGENT_MODE="+s.Mode, fmt.Sprintf(`CODEX_CONFIG={"approval_policy":%q,"sandbox_mode":%q}`, approval, sandbox))
	r, e := launch(config, dir, func(w wire) { m.receive(s, generation, w) }, func() { m.exited(s, generation) })
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
			Prompt      struct {
				Image bool `json:"image"`
			} `json:"promptCapabilities"`
		} `json:"agentCapabilities"`
	}
	e = r.call(ctx, "initialize", map[string]any{"protocolVersion": 1, "clientInfo": map[string]string{"name": "pocketcontext", "version": "0.21.1"}, "clientCapabilities": map[string]any{"fs": map[string]bool{"readTextFile": false, "writeTextFile": false}, "terminal": false}}, &init)
	if e != nil || init.ProtocolVersion != 1 {
		r.stop()
		return m.failed(s, generation, errors.New("agent initialization failed; verify adapter installation and provider authentication"))
	}
	var result struct {
		Models    *ModelState `json:"models"`
		SessionID string      `json:"sessionId"`
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
	supported := false
	if result.Modes != nil {
		for _, mode := range result.Modes.AvailableModes {
			if mode.ID == s.Mode {
				supported = true
			}
		}
	}
	if !supported {
		r.stop()
		return m.failed(s, generation, errors.New("adapter does not support the selected permission mode"))
	}
	if e = r.call(ctx, "session/set_mode", map[string]string{"sessionId": agentID, "modeId": s.Mode}, nil); e != nil {
		r.stop()
		return m.failed(s, generation, errors.New("agent refused the selected permission mode"))
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.process != r || s.Status != "initializing" || s.generation != generation {
		r.stop()
		return ErrClosed
	}
	// Keep the adapter-selected starting pair distinct from the mutable current
	// model. Older histories without this field cannot reconstruct that default.
	if result.Models != nil {
		result.Models.Default = ""
		if !resume {
			result.Models.Default = result.Models.Current
		} else if s.Models != nil {
			result.Models.Default = s.Models.Default
		}
	}
	s.Models = result.Models
	s.Images = init.AgentCapabilities.Prompt.Image
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

// makeRoom is called with the manager locked before reserving an active slot.
func (m *Manager) makeRoom() error {
	active := 0
	var oldest *session
	var updated string
	for _, v := range m.sessions {
		v.mu.Lock()
		if v.process != nil || v.Status == "initializing" {
			active++
		}
		if v.changingMode == "" && v.Status == "idle" && v.process != nil && v.CanResume && (oldest == nil || v.Updated < updated) {
			oldest = v
			updated = v.Updated
		}
		v.mu.Unlock()
	}
	if active < m.c.MaxActive {
		return nil
	}
	if oldest == nil {
		return ErrLimit
	}
	oldest.mu.Lock()
	defer oldest.mu.Unlock()
	if oldest.changingMode != "" || oldest.Status != "idle" || oldest.process == nil {
		return ErrLimit
	}
	oldest.Status = "closed"
	if err := m.save(oldest); err != nil {
		oldest.Status = "idle"
		return err
	}
	oldest.generation++
	oldest.process.stop()
	oldest.process = nil
	return nil
}
func (m *Manager) Resume(ctx context.Context, id string) error {
	s, e := m.get(id)
	if e != nil {
		return e
	}
	m.mu.Lock()
	s.mu.Lock()
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
	s.mu.Unlock()
	if err := m.makeRoom(); err != nil {
		m.mu.Unlock()
		return err
	}
	s.mu.Lock()
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
