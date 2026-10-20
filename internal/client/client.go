// Package client is the PocketContext command-line client: SQL reads, records API
// writes, text ingestion, search and lint. It talks to the local server with a
// token obtained through the private local key, or, in remote mode (--url), to
// a forwarded server with a stored session token; never with a stored password.
package client

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/pocketcontext-labs/pocketcontext/internal/bundle"
)

// CompanySpace is the default space for knowledge and writes.
const CompanySpace = "companyspace001"

var idPattern = regexp.MustCompile(`^[a-z0-9]{15}$`)

// Fail is a command failure with the documented exit code:
// 1 HTTP or transport error, 2 usage or configuration, 3 check differences, 4 HTTP 409.
type Fail struct {
	Code    int
	Message string
}

func (f *Fail) Error() string { return f.Message }

func fail(code int, format string, args ...any) error {
	return &Fail{code, fmt.Sprintf(format, args...)}
}

// Client is one authenticated session against a PocketContext server.
type Client struct {
	Base        string // server URL without a trailing slash
	DB          string // local database; empty in remote mode
	Space       string
	token       string
	remote      bool
	spaceOK     bool
	http        *http.Client
	LongTimeout time.Duration
}

func newClient(base, space string) (*Client, error) {
	if space != "" && !idPattern.MatchString(space) {
		return nil, fail(2, "--space must be a 15-character space ID")
	}
	if space == "" {
		space = os.Getenv("POCKETCONTEXT_SPACE")
	}
	return &Client{Base: base, Space: space, http: &http.Client{
		Timeout: 30 * time.Second,
		// A followed redirect could send the token elsewhere.
		CheckRedirect: noRedirect,
	}}, nil
}

// New ensures the server is running and obtains a token for the local account.
func New(p *bundle.Project, space string) (*Client, error) {
	c, err := newClient(p.URL(), space)
	if err != nil {
		return nil, err
	}
	c.DB = p.DB
	if err := bundle.EnsureRunning(p, bundle.StartOptions{}); err != nil {
		return nil, fail(1, "%v", err)
	}
	key, err := bundle.ReadKey(p)
	if err != nil {
		return nil, fail(1, "%v", err)
	}
	status, data, err := c.send("POST", "/api/bundle/token", nil, map[string]string{"X-PocketContext-Local-Key": key}, "", nil)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fail(1, "local sign-in failed (HTTP %d): %s", status, message(data))
	}
	token, _ := data.(map[string]any)["token"].(string)
	if token == "" {
		return nil, fail(1, "local sign-in returned no token")
	}
	c.token = token
	return c, nil
}

func message(data any) string {
	if m, ok := data.(map[string]any); ok {
		if s, ok := m["message"].(string); ok {
			return s
		}
	}
	return ""
}

func (c *Client) send(method, path string, body any, headers map[string]string, contentType string, raw []byte) (int, any, error) {
	var reader io.Reader
	if raw != nil {
		reader = bytes.NewReader(raw)
	} else if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return 0, nil, err
		}
		reader = bytes.NewReader(encoded)
		contentType = "application/json"
	}
	req, err := http.NewRequest(method, c.Base+path, reader)
	if err != nil {
		return 0, nil, err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	req.Header.Set("User-Agent", "PocketContext/"+bundle.Version)
	if c.token != "" {
		req.Header.Set("Authorization", c.token)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	client := c.http
	if c.LongTimeout > 0 {
		copy := *c.http
		copy.Timeout = c.LongTimeout
		client = &copy
	}
	resp, err := client.Do(req)
	if err != nil {
		if c.remote {
			return 0, nil, fail(1, "the PocketContext server at %s is not reachable: %v; check the forward to the agent computer", c.Base, err)
		}
		return 0, nil, fail(1, "cannot reach the PocketContext server at %s: %v", c.Base, err)
	}
	defer resp.Body.Close()
	if c.remote && resp.StatusCode == http.StatusUnauthorized {
		return 0, nil, expired(c.Base)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 256<<20))
	if err != nil {
		return 0, nil, fail(1, "reading the response: %v", err)
	}
	var parsed any
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := decoder.Decode(&parsed); err != nil {
		parsed = string(data)
	}
	return resp.StatusCode, parsed, nil
}

// Must sends an authenticated JSON request and turns HTTP errors into failures.
func (c *Client) Must(method, path string, body any) (any, error) {
	status, data, err := c.send(method, path, body, nil, "", nil)
	if err != nil {
		return nil, err
	}
	safeRead := method == "GET" || path == "/api/context/query" || path == "/api/context/search"
	for attempt := 0; safeRead && (status == 429 || status == 503) && attempt < 3; attempt++ {
		time.Sleep(time.Duration(500*(attempt+1)) * time.Millisecond)
		if status, data, err = c.send(method, path, body, nil, "", nil); err != nil {
			return nil, err
		}
	}
	return checked(method, path, status, data)
}

func checked(method, path string, status int, data any) (any, error) {
	if status < 400 {
		return data, nil
	}
	pretty, _ := json.MarshalIndent(data, "", "  ")
	lines := []string{fmt.Sprintf("HTTP %d from %s %s", status, method, path), string(pretty)}
	conflict := status == 409
	if path == "/api/batch" {
		lines = append(lines, "Nothing in this batch was saved.")
		if requests, ok := dig(data, "data", "requests").(map[string]any); ok {
			for index, entry := range requests {
				response, _ := dig(entry, "response").(map[string]any)
				inner, _ := response["status"].(json.Number)
				lines = append(lines, fmt.Sprintf("Failed request index %s: HTTP %s: %s", index, inner, message(response)))
				if inner.String() == "409" {
					conflict = true
				}
			}
		}
	}
	if conflict {
		lines = append(lines, "HTTP 409: another request changed the record first. Read it again, confirm the change still applies, then retry.")
		return nil, &Fail{4, strings.Join(lines, "\n")}
	}
	return nil, &Fail{1, strings.Join(lines, "\n")}
}

func dig(value any, keys ...string) any {
	for _, k := range keys {
		m, ok := value.(map[string]any)
		if !ok {
			return nil
		}
		value = m[k]
	}
	return value
}

// Query runs one SQL SELECT and returns the raw result.
func (c *Client) Query(sql string) (map[string]any, error) {
	data, err := c.Must("POST", "/api/context/query", map[string]string{"sql": sql})
	if err != nil {
		return nil, err
	}
	result, ok := data.(map[string]any)
	if !ok {
		return nil, fail(1, "unexpected SQL response")
	}
	return result, nil
}

// Rows runs SQL and returns row objects; truncated results are an error.
func (c *Client) Rows(sql string) ([]map[string]any, error) {
	result, err := c.Query(sql)
	if err != nil {
		return nil, err
	}
	if t, _ := result["truncated"].(bool); t {
		return nil, fail(1, "query was truncated; narrow the selection before continuing")
	}
	columns, _ := result["columns"].([]any)
	raw, _ := result["rows"].([]any)
	rows := make([]map[string]any, 0, len(raw))
	for _, r := range raw {
		values, _ := r.([]any)
		row := map[string]any{}
		for i, col := range columns {
			if name, ok := col.(string); ok && i < len(values) {
				row[name] = values[i]
			}
		}
		rows = append(rows, row)
	}
	return rows, nil
}

// SpaceID returns the selected space, verified through SQL membership.
func (c *Client) SpaceID() (string, error) {
	if c.spaceOK {
		return c.Space, nil
	}
	var sql string
	if c.Space != "" {
		sql = fmt.Sprintf("SELECT id FROM spaces WHERE id = %s LIMIT 1", literal(c.Space))
	} else {
		sql = fmt.Sprintf("SELECT id FROM spaces WHERE id = '%s' AND kind = 'group' LIMIT 1", CompanySpace)
	}
	rows, err := c.Rows(sql)
	if err != nil {
		return "", err
	}
	if len(rows) != 1 {
		if c.Space != "" {
			return "", fail(2, "space not found or not accessible to this account; run `pocketcontext spaces`")
		}
		return "", fail(1, "company space not accessible to this account; select --space or run `pocketcontext spaces`")
	}
	c.Space, c.spaceOK = rows[0]["id"].(string), true
	return c.Space, nil
}

func literal(value any) string {
	return "'" + strings.ReplaceAll(fmt.Sprint(value), "'", "''") + "'"
}

func records(collection string, id ...string) string {
	path := "/api/collections/" + url.PathEscape(collection) + "/records"
	if len(id) > 0 {
		path += "/" + url.PathEscape(id[0])
	}
	return path
}

// Print writes JSON to stdout, compact or indented.
func Print(data any, pretty bool) {
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	if pretty {
		encoder.SetIndent("", "  ")
	}
	_ = encoder.Encode(data)
	os.Stdout.Write(buf.Bytes())
}

func asInt(v any) (int64, bool) {
	switch n := v.(type) {
	case json.Number:
		i, err := n.Int64()
		return i, err == nil
	case float64:
		return int64(n), n == float64(int64(n))
	}
	return 0, false
}

var errUsage = errors.New("usage")
