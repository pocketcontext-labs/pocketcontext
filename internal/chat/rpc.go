package chat

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"time"
)

type wire struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}
type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}
type rpc struct {
	mu      sync.Mutex
	writeMu sync.Mutex
	stdin   io.WriteCloser
	pending map[string]chan wire
	next    uint64
	done    chan struct{}
	waited  chan struct{}
	kill    func()
	once    sync.Once
	handler func(wire)
	exited  func()
}

func launch(c Config, dir string, handler func(wire), exited func()) (*rpc, error) {
	cmd := exec.Command(c.Command, c.Args...)
	cmd.Dir = dir
	cmd.Env = c.Env
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, childOut, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	defer childOut.Close()
	cmd.Stdout = childOut
	cmd.Stderr = io.Discard
	kill, err := startProcess(cmd)
	if err != nil {
		out.Close()
		in.Close()
		return nil, err
	}
	readerDone := make(chan struct{})
	r := &rpc{stdin: in, pending: map[string]chan wire{}, done: make(chan struct{}), waited: make(chan struct{}), kill: kill, handler: handler, exited: exited}
	go func() {
		defer close(readerDone)
		defer out.Close()
		s := bufio.NewScanner(out)
		s.Buffer(make([]byte, 4096), 1<<20)
		for s.Scan() {
			var m wire
			if json.Unmarshal(s.Bytes(), &m) != nil || m.JSONRPC != "2.0" {
				break
			}
			if m.Method != "" {
				r.handler(m)
			} else {
				r.mu.Lock()
				ch := r.pending[string(m.ID)]
				r.mu.Unlock()
				if ch != nil {
					select {
					case ch <- m:
					default:
					}
				}
			}
		}
		r.stop()
	}()
	go func() { _ = cmd.Wait(); r.stop(); <-readerDone; r.exited(); close(r.waited) }()
	return r, nil
}
func (r *rpc) stop() { r.once.Do(func() { close(r.done); r.kill(); r.stdin.Close() }) }
func (r *rpc) write(m wire) error {
	r.writeMu.Lock()
	defer r.writeMu.Unlock()
	select {
	case <-r.done:
		return errors.New("agent exited")
	default:
	}
	timer := time.AfterFunc(2*time.Second, r.stop)
	defer timer.Stop()
	return json.NewEncoder(r.stdin).Encode(m)
}
func (r *rpc) call(ctx context.Context, method string, p any, result any) error {
	stop := context.AfterFunc(ctx, r.stop)
	defer stop()
	b, _ := json.Marshal(p)
	r.mu.Lock()
	r.next++
	id := strconv.FormatUint(r.next, 10)
	ch := make(chan wire, 1)
	r.pending[id] = ch
	r.mu.Unlock()
	defer func() { r.mu.Lock(); delete(r.pending, id); r.mu.Unlock() }()
	if err := r.write(wire{JSONRPC: "2.0", ID: json.RawMessage(id), Method: method, Params: b}); err != nil {
		return err
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-r.done:
		return errors.New("agent exited")
	case m := <-ch:
		if m.Error != nil {
			return errors.New("agent rejected " + method)
		}
		if result != nil {
			return json.Unmarshal(m.Result, result)
		}
		return nil
	}
}
func (r *rpc) notify(method string, p any) error {
	b, _ := json.Marshal(p)
	return r.write(wire{JSONRPC: "2.0", Method: method, Params: b})
}
func (r *rpc) reply(id json.RawMessage, result any) error {
	b, _ := json.Marshal(result)
	return r.write(wire{JSONRPC: "2.0", ID: id, Result: b})
}
