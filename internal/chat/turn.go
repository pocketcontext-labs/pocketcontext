package chat

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"
)

func (m *Manager) Prompt(id, requestID, text string) error {
	if !validKey(requestID) || len(text) == 0 || len(text) > 65536 {
		return ErrInvalid
	}
	s, e := m.get(id)
	if e != nil {
		return e
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	hash := sha256.Sum256([]byte(text))
	h := hex.EncodeToString(hash[:])
	if old, ok := s.Requests[requestID]; ok {
		if old == h {
			return nil
		}
		return ErrConflict
	}
	if s.Status != "idle" || s.process == nil {
		return ErrBusy
	}
	if len(s.Requests) >= 256 || len(s.Events) > maxEvents-64 {
		return ErrLimit
	}
	s.Requests[requestID] = h
	s.Status = "running"
	s.turn++
	turn := s.turn
	if e = s.add("user", text, nil); e != nil {
		return e
	}
	if e = m.save(s); e != nil {
		s.Status = "error"
		s.Error = "Prompt was not sent because conversation history could not be saved."
		s.process.stop()
		return e
	}
	r := s.process
	agentID := s.AgentID
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), m.c.PromptTimeout)
		defer cancel()
		var result struct {
			StopReason string `json:"stopReason"`
		}
		err := r.call(ctx, "session/prompt", map[string]any{"sessionId": agentID, "prompt": []any{map[string]string{"type": "text", "text": text}}}, &result)
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.turn != turn || s.process != r {
			return
		}
		m.cancelPermissions(s)
		if err != nil {
			s.Status = "error"
			s.Error = "Agent turn failed or timed out; it was not replayed."
			s.add("error", s.Error, nil)
			r.stop()
		} else {
			s.Status = "idle"
			s.add("status", result.StopReason, nil)
		}
		if m.save(s) != nil {
			s.Status = "error"
			r.stop()
		}
	}()
	return nil
}
func (m *Manager) receive(s *session, generation uint64, w wire) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.process
	if r == nil || generation != s.generation {
		return
	}
	if w.Method == "session/update" {
		var p struct {
			SessionID string          `json:"sessionId"`
			Update    json.RawMessage `json:"update"`
		}
		if json.Unmarshal(w.Params, &p) != nil {
			return
		}
		if s.AgentID != "" && p.SessionID != s.AgentID {
			return
		}
		if s.replay {
			return
		}
		var u struct {
			SessionUpdate string `json:"sessionUpdate"`
			Content       struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		}
		if json.Unmarshal(p.Update, &u) != nil {
			return
		}
		typ := "status"
		text := ""
		switch u.SessionUpdate {
		case "agent_message_chunk":
			typ = "agent"
			if u.Content.Type == "text" {
				text = u.Content.Text
			}
		case "tool_call", "tool_call_update":
			typ = "tool"
		case "agent_thought_chunk":
			return
		case "current_mode_update":
			var mode struct {
				CurrentModeID string `json:"currentModeId"`
			}
			_ = json.Unmarshal(p.Update, &mode)
			if mode.CurrentModeID != "read-only" && s.Status != "initializing" {
				s.Status = "error"
				s.Error = "Agent left read-only mode"
				r.stop()
				return
			}
		}
		if e := s.add(typ, text, p.Update); e != nil {
			s.Status = "error"
			s.Error = "Conversation history limit reached"
			r.stop()
			return
		}
		if m.save(s) != nil {
			s.Status = "error"
			s.Error = "Conversation history could not be saved"
			r.stop()
		}
		return
	}
	if len(w.ID) == 0 {
		return
	}
	if w.Method != "session/request_permission" {
		_ = r.write(wire{JSONRPC: "2.0", ID: w.ID, Error: &rpcError{Code: -32601, Message: "Client capability unavailable"}})
		return
	}
	var p struct {
		SessionID string             `json:"sessionId"`
		ToolCall  json.RawMessage    `json:"toolCall"`
		Options   []PermissionOption `json:"options"`
	}
	if json.Unmarshal(w.Params, &p) != nil || p.SessionID != s.AgentID || s.Status != "running" || len(p.Options) == 0 || len(p.Options) > 16 || len(s.permissions) >= 8 {
		_ = r.reply(w.ID, map[string]any{"outcome": map[string]string{"outcome": "cancelled"}})
		return
	}
	seen := map[string]bool{}
	for _, o := range p.Options {
		if !validKey(o.OptionID) || seen[o.OptionID] {
			_ = r.reply(w.ID, map[string]any{"outcome": map[string]string{"outcome": "cancelled"}})
			return
		}
		seen[o.OptionID] = true
	}
	id := randomID()
	s.permissions[id] = pendingPermission{Permission: Permission{ID: id, ToolCall: p.ToolCall, Options: p.Options}, wireID: w.ID}
	if m.save(s) != nil {
		delete(s.permissions, id)
		r.stop()
	}
}
func (m *Manager) Permission(id, permissionID, optionID string) error {
	s, e := m.get(id)
	if e != nil {
		return e
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if old, ok := s.decisions[permissionID]; ok {
		if old == optionID {
			return nil
		}
		return ErrConflict
	}
	p, ok := s.permissions[permissionID]
	if !ok {
		return ErrNotFound
	}
	valid := false
	for _, o := range p.Options {
		if o.OptionID == optionID {
			valid = true
		}
	}
	if !valid {
		return ErrInvalid
	}
	if s.process == nil {
		return ErrBusy
	}
	if e = s.add("status", "Permission decision recorded", nil); e != nil {
		return e
	}
	if e = m.save(s); e != nil {
		return e
	}
	s.decisions[permissionID] = optionID
	delete(s.permissions, permissionID)
	return s.process.reply(p.wireID, map[string]any{"outcome": map[string]string{"outcome": "selected", "optionId": optionID}})
}
func (m *Manager) cancelPermissions(s *session) {
	for _, p := range s.permissions {
		if s.process != nil {
			_ = s.process.reply(p.wireID, map[string]any{"outcome": map[string]string{"outcome": "cancelled"}})
		}
	}
	s.permissions = map[string]pendingPermission{}
}
func (m *Manager) Cancel(id string) error {
	s, e := m.get(id)
	if e != nil {
		return e
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.Status != "running" && s.Status != "cancelling" {
		return nil
	}
	r := s.process
	if r == nil {
		return nil
	}
	s.Status = "cancelling"
	m.cancelPermissions(s)
	if e = m.save(s); e != nil {
		r.stop()
		return e
	}
	e = r.notify("session/cancel", map[string]string{"sessionId": s.AgentID})
	turn := s.turn
	go func() {
		time.Sleep(m.c.CancelTimeout)
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.process == r && s.turn == turn && s.Status == "cancelling" {
			r.stop()
		}
	}()
	return e
}
func (m *Manager) CloseSession(id string) error {
	s, e := m.get(id)
	if e != nil {
		return e
	}
	return m.closeSession(s)
}
func (m *Manager) closeSession(s *session) error {
	s.mu.Lock()
	s.Status = "closed"
	s.turn++
	r := s.process
	// Termination also cancels outstanding provider permission requests.
	s.permissions = map[string]pendingPermission{}
	if r != nil {
		r.stop()
	}
	err := m.save(s)
	s.mu.Unlock()
	if r != nil {
		select {
		case <-r.waited:
		case <-time.After(5 * time.Second):
			return errors.Join(err, errors.New("agent shutdown timed out"))
		}
	}
	return err
}
func (m *Manager) Close() error {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil
	}
	m.closed = true
	all := []*session{}
	for _, s := range m.sessions {
		all = append(all, s)
	}
	m.mu.Unlock()
	var errs []error
	for _, s := range all {
		if e := m.closeSession(s); e != nil {
			errs = append(errs, e)
		}
	}
	return errors.Join(errs...)
}
