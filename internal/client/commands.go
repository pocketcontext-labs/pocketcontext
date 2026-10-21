package client

import (
	"bufio"
	"crypto/rand"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"golang.org/x/term"

	"github.com/pocketcontext-labs/pocketcontext/internal/bundle"
)

//go:embed schema.json
var referenceSchema []byte

// args is a small argparse-like parser: flags may appear anywhere.
type args struct {
	pos   []string
	flags map[string]string
	bools map[string]bool
}

// parseArgs accepts the given value flags and boolean flags (without dashes).
func parseArgs(argv []string, values, booleans []string) (*args, error) {
	a := &args{flags: map[string]string{}, bools: map[string]bool{}}
	isValue, isBool := map[string]bool{}, map[string]bool{}
	for _, v := range append(values, "db", "space", "url") {
		isValue[v] = true
	}
	for _, b := range append(booleans, "pretty") {
		isBool[b] = true
	}
	for i := 0; i < len(argv); i++ {
		arg := argv[i]
		if arg == "--" {
			a.pos = append(a.pos, argv[i+1:]...)
			break
		}
		if !strings.HasPrefix(arg, "--") || arg == "-" {
			a.pos = append(a.pos, arg)
			continue
		}
		name, value, hasValue := strings.Cut(arg[2:], "=")
		switch {
		case isBool[name] && !hasValue:
			a.bools[name] = true
		case isValue[name]:
			if !hasValue {
				if i+1 >= len(argv) {
					return nil, fail(2, "--%s needs a value", name)
				}
				i++
				value = argv[i]
			}
			a.flags[name] = value
		default:
			return nil, fail(2, "unknown option --%s", name)
		}
	}
	return a, nil
}

func (a *args) has(name string) bool { _, ok := a.flags[name]; return ok }

func (a *args) need(n int, usage string) error {
	if len(a.pos) != n {
		return fail(2, "usage: pocketcontext %s", usage)
	}
	return nil
}

func (a *args) intFlag(name string, fallback int) (int, error) {
	v, ok := a.flags[name]
	if !ok {
		return fallback, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, fail(2, "--%s must be a whole number", name)
	}
	return n, nil
}

func readArg(text, what string) ([]byte, error) {
	if text == "-" {
		data, err := io.ReadAll(os.Stdin)
		return data, err
	}
	if text == "" {
		return nil, fail(2, "%s is empty", what)
	}
	return []byte(text), nil
}

func readJSON(text, what string) (any, error) {
	data, err := readArg(text, what)
	if err != nil {
		return nil, err
	}
	var v any
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.UseNumber()
	if err := decoder.Decode(&v); err != nil {
		return nil, fail(2, "%s is not valid JSON: %v", what, err)
	}
	return v, nil
}

func requireRevision(body map[string]any) error {
	if n, ok := asInt(body["expected_revision"]); !ok || n < 1 {
		return fail(2, "updates require expected_revision from your last read; read the record before changing it")
	}
	return nil
}

func recordBody(text string) (map[string]any, error) {
	v, err := readJSON(text, "the record body")
	if err != nil {
		return nil, err
	}
	body, ok := v.(map[string]any)
	if !ok {
		return nil, fail(2, "the record body must be a JSON object")
	}
	for _, stamp := range []string{"created_by", "updated_by"} {
		if _, ok := body[stamp]; ok {
			delete(body, stamp)
			fmt.Fprintf(os.Stderr, "note: removed %s from the body; the server sets it from your login\n", stamp)
		}
	}
	if len(body) == 0 {
		return nil, fail(2, "the record body has no fields to send")
	}
	return body, nil
}

var batchURL = regexp.MustCompile(`^/api/collections/(sources|renditions|passages|ingestion_runs|pages|page_revisions|citations|page_links)/records(?:/[a-z0-9]{15})?$`)

var roots = map[string]bool{"sources": true, "ingestion_runs": true, "pages": true}

const idAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789"

// NewID returns a random 15-character record ID.
func NewID() string {
	b := make([]byte, 15)
	out := make([]byte, 15)
	for i := 0; i < 15; {
		if _, err := rand.Read(b); err != nil {
			panic(err)
		}
		for _, x := range b {
			if i < 15 && x < 252 { // 252 = 7*36: unbiased
				out[i] = idAlphabet[int(x)%36]
				i++
			}
		}
	}
	return string(out)
}

func readPassword(fromStdin bool, confirm bool) (string, error) {
	if fromStdin {
		line, err := bufio.NewReader(os.Stdin).ReadString('\n')
		if err != nil && !errors.Is(err, io.EOF) {
			return "", err
		}
		return strings.TrimRight(line, "\r\n"), nil
	}
	fd := int(os.Stdin.Fd())
	if !term.IsTerminal(fd) {
		return "", fail(2, "no terminal to ask for a password; pass --password-stdin and write the password to standard input")
	}
	fmt.Fprint(os.Stderr, "Password (at least 8 characters): ")
	first, err := term.ReadPassword(fd)
	fmt.Fprintln(os.Stderr)
	if err != nil {
		return "", err
	}
	if confirm {
		fmt.Fprint(os.Stderr, "Repeat the password: ")
		second, err := term.ReadPassword(fd)
		fmt.Fprintln(os.Stderr)
		if err != nil {
			return "", err
		}
		if string(first) != string(second) {
			return "", fail(2, "the passwords differ")
		}
	}
	return string(first), nil
}

var emailPattern = regexp.MustCompile(`^[^@\s]+@[^@\s]+$`)

// Run executes one command and returns the process exit code.
func Run(argv []string) int {
	if err := run(argv); err != nil {
		var f *Fail
		if errors.As(err, &f) {
			fmt.Fprintln(os.Stderr, "pocketcontext: "+f.Message)
			return f.Code
		}
		fmt.Fprintln(os.Stderr, "pocketcontext: "+err.Error())
		return 1
	}
	return 0
}

func run(argv []string) error {
	// Global options may precede the command: pocketcontext --db PATH COMMAND ...
	var global []string
	for len(argv) > 0 && strings.HasPrefix(argv[0], "--") {
		name, _, hasValue := strings.Cut(argv[0][2:], "=")
		switch {
		case name == "pretty":
			global, argv = append(global, argv[0]), argv[1:]
		case (name == "db" || name == "space" || name == "url") && hasValue:
			global, argv = append(global, argv[0]), argv[1:]
		case (name == "db" || name == "space" || name == "url") && len(argv) > 1:
			global, argv = append(global, argv[0], argv[1]), argv[2:]
		default:
			goto parsed
		}
	}
parsed:
	if len(argv) > 0 {
		argv = append([]string{argv[0]}, append(global, argv[1:]...)...)
	}
	if len(argv) == 0 || argv[0] == "help" || argv[0] == "--help" || argv[0] == "-h" {
		fmt.Print(Usage)
		return nil
	}
	command, rest := argv[0], argv[1:]
	if command == "version" || command == "--version" {
		line := "pocketcontext " + bundle.Version
		if bundle.Commit != "" {
			line += " (" + bundle.Commit + ")"
		}
		fmt.Println(line)
		return nil
	}
	if command == "newid" {
		fmt.Println(NewID())
		return nil
	}
	spec := map[string][2][]string{
		"serve":                 {nil, {"take-over"}},
		"start":                 {nil, {"take-over"}},
		"ensure-running":        {nil, {"take-over"}},
		"stop":                  {nil, nil},
		"status":                {nil, nil},
		"open":                  {{"email"}, {"no-browser"}},
		"flush":                 {nil, nil},
		"recover":               {{"keep"}, nil},
		"init":                  {{"email", "name", "port"}, {"password-stdin"}},
		"password":              {nil, {"password-stdin"}},
		"skill":                 {{"agent", "dir"}, nil},
		"whoami":                {nil, nil},
		"spaces":                {nil, nil},
		"create-personal-space": {nil, nil},
		"check":                 {nil, nil},
		"schema":                {nil, nil},
		"query":                 {nil, nil},
		"sql":                   {nil, nil},
		"get":                   {nil, nil},
		"create":                {nil, nil},
		"update":                {nil, nil},
		"batch":                 {nil, nil},
		"ingest":                {{"title", "version"}, nil},
		"search":                {{"publication", "sequence", "limit", "offset", "generation"}, nil},
		"lint":                  {nil, nil},
		"stage":                 {nil, {"dry-run"}},
		"check-run":             {nil, nil},
		"page":                  {{"publication", "sequence"}, nil},
		"publish":               {{"expected-revision", "home", "home-base"}, {"clear-home"}},
		"stage-home":            {{"expected-revision", "home", "home-base"}, {"clear-home"}},
		"account":               {{"email", "name"}, {"password-stdin"}},
		"login-code":            {{"email", "ttl"}, nil},
		"login":                 {{"email"}, {"password-stdin", "code-stdin"}},
		"logout":                {nil, nil},
	}
	s, known := spec[command]
	if !known {
		return fail(2, "unknown command %q; run `pocketcontext help`", command)
	}
	a, err := parseArgs(rest, s[0], s[1])
	if err != nil {
		return err
	}
	pretty := a.bools["pretty"]
	// --url, or POCKETCONTEXT_URL without an explicit --db, selects remote mode.
	remote, fromFlag := a.flags["url"], a.has("url")
	if fromFlag && a.has("db") {
		return fail(2, "choose --url or --db, not both")
	}
	if !fromFlag && !a.has("db") {
		remote = os.Getenv("POCKETCONTEXT_URL")
	}
	if fromFlag || remote != "" {
		base, err := normalizeURL(remote)
		if err != nil {
			return err
		}
		return runRemote(base, command, a, pretty)
	}
	if command == "login" || command == "logout" {
		return fail(2, "usage: pocketcontext %s --url http://127.0.0.1:PORT", command)
	}
	p, err := bundle.Resolve(a.flags["db"])
	if err != nil {
		return fail(2, "%v", err)
	}
	switch command {
	case "serve":
		return bundle.Serve(p, bundle.ServeOptions{TakeOver: a.bools["take-over"]})
	case "start", "ensure-running":
		if err := bundle.EnsureRunning(p, bundle.StartOptions{TakeOver: a.bools["take-over"]}); err != nil {
			return fail(1, "%v", err)
		}
		Print(map[string]any{"status": "running", "url": p.URL(), "db": p.DB, "instance": p.Config.Instance}, pretty)
		return nil
	case "stop":
		if err := bundle.Stop(p); err != nil {
			return fail(1, "%v", err)
		}
		Print(map[string]any{"status": "stopped", "db": p.DB}, pretty)
		return nil
	case "status":
		running, err := bundle.Running(p)
		lease, _ := bundle.ReadLease(p)
		out := map[string]any{"db": p.DB, "url": p.URL(), "running": running, "config": p.ConfigPath, "storage": p.StorageDir(),
			"cache": p.Cache, "log": p.LogFile(), "lease": lease, "conflicts": bundle.Conflicts(p), "version": bundle.Version}
		if err != nil {
			out["error"] = err.Error()
		}
		Print(out, pretty)
		return nil
	case "flush":
		if err := bundle.EnsureRunning(p, bundle.StartOptions{}); err != nil {
			return fail(1, "%v", err)
		}
		data, err := bundle.LocalCall(p, "/api/bundle/flush", map[string]any{})
		if err != nil {
			return fail(1, "%v", err)
		}
		Print(data, pretty)
		return nil
	case "recover":
		keep := a.flags["keep"]
		if keep != "local" && keep != "synced" {
			return fail(2, "usage: pocketcontext recover --keep local|synced")
		}
		if err := bundle.Recover(p, keep == "local"); err != nil {
			return fail(1, "%v", err)
		}
		Print(map[string]any{"recovered": keep, "db": p.DB}, pretty)
		return nil
	case "init":
		return initProject(p, a, pretty)
	case "password":
		password, err := readPassword(a.bools["password-stdin"], true)
		if err != nil {
			return err
		}
		c, err := New(p, "")
		if err != nil {
			return err
		}
		me, err := c.Must("POST", "/api/collections/users/auth-refresh", nil)
		if err != nil {
			return err
		}
		email, _ := dig(me, "record", "email").(string)
		if _, err := bundle.LocalCall(p, "/api/bundle/account", map[string]string{"email": email, "password": password}); err != nil {
			return fail(1, "%v", err)
		}
		Print(map[string]any{"email": email, "password": "changed"}, pretty)
		return nil
	case "open":
		if err := bundle.EnsureRunning(p, bundle.StartOptions{}); err != nil {
			return fail(1, "%v", err)
		}
		body := map[string]any{}
		if a.has("email") {
			email := strings.ToLower(a.flags["email"])
			if !emailPattern.MatchString(email) {
				return fail(2, "usage: pocketcontext open [--email EMAIL] [--no-browser]")
			}
			body["email"] = email
		}
		data, err := bundle.LocalCall(p, "/api/bundle/login-code", body)
		if err != nil {
			return fail(1, "%v", err)
		}
		link, _ := data["url"].(string)
		if !a.bools["no-browser"] {
			if err := bundle.OpenBrowser(link); err != nil {
				fmt.Fprintln(os.Stderr, "could not open a browser:", err)
			}
		}
		Print(map[string]any{"url": p.URL(), "signInLink": link, "note": "single-use link, valid for 2 minutes"}, pretty)
		return nil
	case "account":
		return createAccount(p, a, pretty)
	case "login-code":
		return loginCode(p, a, pretty)
	case "skill":
		return installSkills(p.DB, p.URL(), a.flags["agent"], a.flags["dir"], pretty)
	}
	c, err := New(p, a.flags["space"])
	if err != nil {
		return err
	}
	return runData(c, command, a, pretty)
}

// localOnly are the server and project commands that need the local database.
var localOnly = map[string]bool{"serve": true, "start": true, "ensure-running": true, "stop": true, "flush": true,
	"recover": true, "init": true, "password": true, "account": true, "login-code": true}

// runRemote runs a command against a forwarded server. It never resolves a
// database or starts a server.
func runRemote(base, command string, a *args, pretty bool) error {
	if localOnly[command] {
		return fail(2, "%s is not available with --url: the server and its database live on the agent computer; run it there", command)
	}
	switch command {
	case "logout":
		if err := deleteSession(base); err != nil {
			return err
		}
		Print(map[string]any{"url": base, "loggedOut": true}, pretty)
		return nil
	case "status":
		out, err := remoteStatus(base)
		if err != nil {
			return err
		}
		Print(out, pretty)
		return nil
	case "login":
		var out map[string]any
		var err error
		if a.bools["code-stdin"] {
			if a.has("email") || a.bools["password-stdin"] {
				return fail(2, "usage: pocketcontext login --url URL --code-stdin (the code names the account; no --email or --password-stdin)")
			}
			out, err = loginWithCode(base)
		} else {
			out, err = login(base, a.flags["email"], a.bools["password-stdin"])
		}
		if err != nil {
			return err
		}
		Print(out, pretty)
		return nil
	}
	if command == "open" && a.has("email") {
		return fail(2, "open --email is not available with --url: run `pocketcontext open --email EMAIL --no-browser` on the agent computer and open the printed link here")
	}
	s, err := loadSession(base)
	if err != nil {
		return err
	}
	if _, err := checkRemote(base, s); err != nil {
		return err
	}
	switch command {
	case "open":
		if !a.bools["no-browser"] {
			if err := bundle.OpenBrowser(base); err != nil {
				fmt.Fprintln(os.Stderr, "could not open a browser:", err)
			}
		}
		Print(map[string]any{"url": base, "note": "sign in with your email and password, or open a sign-in link from `pocketcontext open --email EMAIL --no-browser` on the agent computer"}, pretty)
		return nil
	case "skill":
		return installSkills("", base, a.flags["agent"], a.flags["dir"], pretty)
	}
	c, err := NewRemote(base, a.flags["space"])
	if err != nil {
		return err
	}
	return runData(c, command, a, pretty)
}

// runData runs the knowledge commands, which work locally and remotely.
func runData(c *Client, command string, a *args, pretty bool) error {
	var data any
	var err error
	switch command {
	case "whoami":
		me, err := c.Must("POST", "/api/collections/users/auth-refresh", nil)
		if err != nil {
			return err
		}
		space, err := c.SpaceID()
		if err != nil {
			return err
		}
		out := map[string]any{"id": dig(me, "record", "id"), "name": dig(me, "record", "name"), "email": dig(me, "record", "email"), "url": c.Base, "space": space}
		if c.DB != "" {
			out["db"] = c.DB
		}
		data = out
	case "spaces":
		me, err := c.Must("POST", "/api/collections/users/auth-refresh", nil)
		if err != nil {
			return err
		}
		account, _ := dig(me, "record", "id").(string)
		if !idPattern.MatchString(account) {
			return fail(1, "unexpected account ID")
		}
		rows, err := c.Rows("SELECT s.id, s.kind, s.name, m.role FROM spaces s JOIN space_members m ON m.space = s.id " +
			"WHERE m.account = " + literal(account) + " AND m.active = 1 ORDER BY s.kind = 'group', s.name, s.id")
		if err != nil {
			return err
		}
		selected := c.Space
		if selected == "" {
			selected = CompanySpace
		}
		for _, row := range rows {
			row["selected"] = row["id"] == selected
		}
		data = rows
	case "create-personal-space":
		data, err = c.Must("POST", "/api/spaces/personal", map[string]any{})
	case "check":
		return c.check()
	case "schema":
		data, err = c.Must("GET", "/api/context/schema", nil)
	case "query", "sql":
		if err := a.need(1, command+" SQL|-"); err != nil {
			return err
		}
		sql, err := readArg(a.pos[0], "the query")
		if err != nil {
			return err
		}
		result, err := c.Query(string(sql))
		if err != nil {
			return err
		}
		if t, _ := result["truncated"].(bool); t {
			rows, _ := result["rows"].([]any)
			fmt.Fprintf(os.Stderr, "WARNING: result truncated to %d rows by the server's row or byte limit. Select fewer columns, narrow the query, or page with ORDER BY and LIMIT/OFFSET.\n", len(rows))
		}
		data = result
	case "get":
		if err := a.need(2, "get COLLECTION ID"); err != nil {
			return err
		}
		collection, id := a.pos[0], a.pos[1]
		if !idPattern.MatchString(id) {
			return fail(2, "record id must be 15 lowercase letters or digits")
		}
		schema, err := c.Must("GET", "/api/context/schema", nil)
		if err != nil {
			return err
		}
		found := false
		tables, _ := dig(schema, "tables").([]any)
		for _, t := range tables {
			if dig(t, "name") == collection {
				found = true
			}
		}
		if !found {
			return fail(2, "collection is not an SQL-readable table with an id column")
		}
		rows, err := c.Rows(`SELECT * FROM "` + strings.ReplaceAll(collection, `"`, `""`) + `" WHERE id = ` + literal(id) + " LIMIT 1")
		if err != nil {
			return err
		}
		if len(rows) == 0 {
			return fail(1, "HTTP 404: record not found in %s", collection)
		}
		data = rows[0]
	case "create", "update":
		usage := "create COLLECTION JSON|-"
		n := 2
		if command == "update" {
			usage, n = "update COLLECTION ID JSON|-", 3
		}
		if err := a.need(n, usage); err != nil {
			return err
		}
		body, err := recordBody(a.pos[n-1])
		if err != nil {
			return err
		}
		if command == "update" {
			if err := requireRevision(body); err != nil {
				return err
			}
			if data, err = c.Must("PATCH", records(a.pos[0], a.pos[1]), body); err != nil {
				return err
			}
			break
		}
		if roots[a.pos[0]] && body["space"] == nil {
			if body["space"], err = c.SpaceID(); err != nil {
				return err
			}
		}
		if data, err = c.Must("POST", records(a.pos[0]), body); err != nil {
			return err
		}
	case "batch":
		if err := a.need(1, "batch JSON|-"); err != nil {
			return err
		}
		v, err := readJSON(a.pos[0], "the batch")
		if err != nil {
			return err
		}
		requests, ok := v.([]any)
		if !ok {
			return fail(2, "the batch must be a JSON array")
		}
		for _, r := range requests {
			entry, ok := r.(map[string]any)
			if !ok {
				return fail(2, "each batch entry must be an object with method, url, and body")
			}
			method, _ := entry["method"].(string)
			target, _ := entry["url"].(string)
			body, ok := entry["body"].(map[string]any)
			if (method != "POST" && method != "PATCH") || !batchURL.MatchString(target) {
				return fail(2, "batch accepts only POST/PATCH business record URLs")
			}
			if !ok {
				return fail(2, "each batch body must be an object")
			}
			if method == "PATCH" {
				if err := requireRevision(body); err != nil {
					return err
				}
			} else if roots[strings.Split(target, "/")[3]] && body["space"] == nil {
				if body["space"], err = c.SpaceID(); err != nil {
					return err
				}
			}
		}
		if data, err = c.Must("POST", "/api/batch", map[string]any{"requests": requests}); err != nil {
			return err
		}
	case "ingest":
		if err := a.need(1, "ingest PATH [--title T] [--version V]"); err != nil {
			return err
		}
		version := a.flags["version"]
		if !a.has("version") {
			version = "v1"
		}
		data, err = c.Ingest(a.pos[0], a.flags["title"], version)
	case "search":
		if err := a.need(1, "search TERMS [--limit N] [--offset N --generation G --publication ID]"); err != nil {
			return err
		}
		o := SearchOptions{Publication: a.flags["publication"], Generation: a.flags["generation"]}
		if o.Sequence, err = a.intFlag("sequence", 0); err != nil {
			return err
		}
		if o.Limit, err = a.intFlag("limit", 20); err != nil {
			return err
		}
		if o.Offset, err = a.intFlag("offset", 0); err != nil {
			return err
		}
		data, err = c.Search(a.pos[0], o)
	case "lint":
		data, err = c.Lint()
	case "stage":
		if err := a.need(1, "stage SPEC|- [--dry-run]"); err != nil {
			return err
		}
		spec, err := readSpec(a.pos[0])
		if err != nil {
			return err
		}
		result, err := c.Stage(spec, a.bools["dry-run"])
		if err != nil {
			return err
		}
		Print(result, pretty)
		if n := problemCount(result["problems"]); n > 0 {
			return &Fail{3, fmt.Sprintf("%d problems; nothing was published", n)}
		}
		return nil
	case "check-run":
		if err := a.need(1, "check-run RUN_ID"); err != nil {
			return err
		}
		result, err := c.CheckRun(a.pos[0])
		if err != nil {
			return err
		}
		Print(result, pretty)
		if ok, _ := result["ok"].(bool); !ok {
			return &Fail{3, fmt.Sprintf("run %s has %d problems", a.pos[0], problemCount(result["problems"]))}
		}
		return nil
	case "page":
		if err := a.need(1, "page SLUG [--publication ID] [--sequence N]"); err != nil {
			return err
		}
		sequence, err := a.intFlag("sequence", 0)
		if err != nil {
			return err
		}
		if data, err = c.PageSpec(a.pos[0], a.flags["publication"], sequence); err != nil {
			return err
		}
	case "publish", "stage-home":
		if err := a.need(1, command+" RUN_ID --expected-revision N"); err != nil {
			return err
		}
		revision, err := a.intFlag("expected-revision", 0)
		if err != nil {
			return err
		}
		runID := a.pos[0]
		if !idPattern.MatchString(runID) || revision < 1 {
			return fail(2, "valid run ID and positive --expected-revision required")
		}
		home, clearHome := a.flags["home"], a.bools["clear-home"]
		if home != "" && clearHome {
			return fail(2, "choose --home or --clear-home, not both")
		}
		if command == "stage-home" && home == "" && !clearHome {
			return fail(2, "stage-home requires --home or --clear-home")
		}
		var homeBase *string
		if v, ok := a.flags["home-base"]; ok {
			homeBase = &v
		}
		fields, err := c.HomeFields(command, runID, home, clearHome, homeBase)
		if err != nil {
			return err
		}
		fields["expected_revision"] = revision
		if command == "publish" {
			fields["status"] = "published"
		}
		if data, err = c.Must("PATCH", records("ingestion_runs", runID), fields); err != nil {
			return err
		}
	}
	if err != nil {
		return err
	}
	Print(data, pretty)
	return nil
}

// createAccount creates another account on this server, or resets its
// password, so that a person working remotely signs in as themselves.
func createAccount(p *bundle.Project, a *args, pretty bool) error {
	email := strings.ToLower(a.flags["email"])
	if !emailPattern.MatchString(email) {
		return fail(2, "usage: pocketcontext account --email EMAIL [--name NAME] [--password-stdin]")
	}
	// Without --password-stdin no password is sent: a new account gets a random
	// one nobody knows (sign in with `login-code`), an existing one keeps its own.
	password := ""
	if a.bools["password-stdin"] {
		var err error
		if password, err = readPassword(true, false); err != nil {
			return err
		}
		if password == "" {
			return fail(2, "no password on standard input")
		}
	}
	if err := bundle.EnsureRunning(p, bundle.StartOptions{}); err != nil {
		return fail(1, "%v", err)
	}
	result, err := bundle.LocalCall(p, "/api/bundle/account", map[string]string{"email": email, "name": a.flags["name"], "password": password})
	if err != nil {
		return fail(1, "%v", err)
	}
	Print(map[string]any{"id": result["id"], "email": result["email"], "created": result["created"]}, pretty)
	return nil
}

// loginCodeTTL is the default lifetime of a code from `login-code`, in seconds.
const loginCodeTTL = 600

// loginCode issues a one-time sign-in code for `login --url URL --code-stdin`.
func loginCode(p *bundle.Project, a *args, pretty bool) error {
	email := strings.ToLower(a.flags["email"])
	if !emailPattern.MatchString(email) {
		return fail(2, "usage: pocketcontext login-code --email EMAIL [--ttl SECONDS]")
	}
	ttl, err := a.intFlag("ttl", loginCodeTTL)
	if err != nil {
		return err
	}
	if !bundle.ValidCodeTTL(ttl) {
		return fail(2, "--ttl must be %d-%d seconds", bundle.MinCodeTTL, bundle.MaxCodeTTL)
	}
	if err := bundle.EnsureRunning(p, bundle.StartOptions{}); err != nil {
		return fail(1, "%v", err)
	}
	result, err := bundle.LocalCall(p, "/api/bundle/login-code", map[string]any{"email": email, "ttl": ttl})
	if err != nil {
		return fail(1, "%v", err)
	}
	Print(map[string]any{"email": result["email"], "code": result["code"], "expires": result["expires"]}, pretty)
	return nil
}

func initProject(p *bundle.Project, a *args, pretty bool) error {
	_, statErr := os.Stat(p.ConfigPath)
	fresh := errors.Is(statErr, os.ErrNotExist)
	if email := a.flags["email"]; email != "" {
		if !emailPattern.MatchString(email) {
			return fail(2, "--email must look like name@example.com (any local address works, e.g. you@example.localhost)")
		}
		p.Config.Email = strings.ToLower(email)
	}
	if a.has("port") {
		port, err := a.intFlag("port", 0)
		if err != nil || port < 1024 || port > 65535 {
			return fail(2, "--port must be 1024-65535")
		}
		p.Config.Port = port
	}
	if p.Config.Email == "" {
		return fail(2, "init needs --email for the local account (any address, e.g. you@example.localhost)")
	}
	if err := os.MkdirAll(p.Dir, 0755); err != nil {
		return err
	}
	if err := p.EnsureInstance(); err != nil {
		return err
	}
	if err := p.SaveConfig(); err != nil {
		return err
	}
	if err := bundle.EnsureRunning(p, bundle.StartOptions{}); err != nil {
		return fail(1, "%v", err)
	}
	// An existing account (for example created on another computer) keeps its password.
	_, existsErr := bundle.LocalCall(p, "/api/bundle/token", map[string]any{})
	created := false
	if existsErr != nil || a.bools["password-stdin"] {
		password, err := readPassword(a.bools["password-stdin"], true)
		if err != nil {
			return err
		}
		result, err := bundle.LocalCall(p, "/api/bundle/account", map[string]string{"email": p.Config.Email, "name": a.flags["name"], "password": password})
		if err != nil {
			return fail(1, "%v", err)
		}
		created, _ = result["created"].(bool)
	}
	if _, err := bundle.LocalCall(p, "/api/bundle/flush", map[string]any{}); err != nil {
		return fail(1, "saving %s: %v", p.DB, err)
	}
	Print(map[string]any{"db": p.DB, "config": p.ConfigPath, "storage": p.StorageDir(), "url": p.URL(), "email": p.Config.Email,
		"accountCreated": created, "newProject": fresh, "next": "Run `pocketcontext open` to sign in to the reader, and `pocketcontext skill` to install the agent skills."}, pretty)
	return nil
}

func (c *Client) check() error {
	columns := func(raw any) map[string]map[string]any {
		out := map[string]map[string]any{}
		tables, _ := dig(raw, "tables").([]any)
		for _, t := range tables {
			name, _ := dig(t, "name").(string)
			out[name] = map[string]any{}
			cols, _ := dig(t, "columns").([]any)
			for _, col := range cols {
				n, _ := dig(col, "name").(string)
				out[name][n] = dig(col, "type")
			}
		}
		return out
	}
	var reference any
	if err := json.Unmarshal(referenceSchema, &reference); err != nil {
		return err
	}
	live, err := c.Must("GET", "/api/context/schema", nil)
	if err != nil {
		return err
	}
	ref, cur := columns(reference), columns(live)
	names := map[string]bool{}
	for n := range ref {
		names[n] = true
	}
	for n := range cur {
		names[n] = true
	}
	sorted := make([]string, 0, len(names))
	for n := range names {
		sorted = append(sorted, n)
	}
	sort.Strings(sorted)
	var differences []string
	for _, table := range sorted {
		r, inRef := ref[table]
		l, inLive := cur[table]
		switch {
		case !inRef:
			differences = append(differences, "table "+table+": on the server, not in the reference files")
		case !inLive:
			differences = append(differences, "table "+table+": in the reference files, not on the server")
		default:
			for col := range l {
				if _, ok := r[col]; !ok {
					differences = append(differences, fmt.Sprintf("column %s.%s: on the server, not in the reference files", table, col))
				} else if fmt.Sprint(r[col]) != fmt.Sprint(l[col]) {
					differences = append(differences, fmt.Sprintf("column %s.%s: type %v on the server, %v in the reference files", table, col, l[col], r[col]))
				}
			}
			for col := range r {
				if _, ok := l[col]; !ok {
					differences = append(differences, fmt.Sprintf("column %s.%s: in the reference files, not on the server", table, col))
				}
			}
		}
	}
	if len(differences) == 0 {
		fmt.Printf("OK: the live schema matches the reference schema (%d tables)\n", len(cur))
		return nil
	}
	sort.Strings(differences)
	fmt.Println(strings.Join(differences, "\n"))
	return &Fail{3, "the live schema differs from the reference schema"}
}
