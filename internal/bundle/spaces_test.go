package bundle

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/jsvm"
)

type testApp struct {
	app     core.App
	handler http.Handler
	token   string
	user    *core.Record
}

// newTestApp runs the real application migrations and hooks on an isolated
// database and creates the project's one account.
func newTestApp(t *testing.T) *testApp {
	t.Helper()
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	app := core.NewBaseApp(core.BaseAppConfig{DataDir: t.TempDir()})
	jsvm.MustRegister(app, hooksConfig(root, ""))
	if err := app.Bootstrap(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = app.ResetBootstrapState() })
	if err := app.RunAllMigrations(); err != nil {
		t.Fatal(err)
	}
	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	if err := app.OnServe().Trigger(&core.ServeEvent{App: app, Router: router}); err != nil {
		t.Fatal(err)
	}
	handler, err := router.BuildMux()
	if err != nil {
		t.Fatal(err)
	}
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatal(err)
	}
	u := core.NewRecord(users)
	u.SetEmail(LocalIdentity)
	u.SetPassword("synthetic-password")
	u.SetVerified(true)
	if err := app.Save(u); err != nil {
		t.Fatal(err)
	}
	token, err := u.NewAuthToken()
	if err != nil {
		t.Fatal(err)
	}
	return &testApp{app: app, handler: handler, token: token, user: u}
}

func (a *testApp) request(t *testing.T, method, path, token, body string, want int) map[string]any {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", token)
	}
	response := httptest.NewRecorder()
	a.handler.ServeHTTP(response, req)
	if response.Code != want {
		t.Fatalf("%s %s: %d %s; want %d", method, path, response.Code, response.Body, want)
	}
	var data map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &data); err != nil {
		var list []any
		if json.Unmarshal(response.Body.Bytes(), &list) != nil {
			t.Fatal(err)
		}
	}
	return data
}

func TestSingleUserSpaces(t *testing.T) {
	a := newTestApp(t)
	token := a.token
	req := func(method, path, body string, want int) map[string]any {
		t.Helper()
		return a.request(t, method, path, token, body, want)
	}

	// A new database has one space, "Default", named by the settings row.
	spaces, err := a.app.FindAllRecords("spaces")
	if err != nil || len(spaces) != 1 || spaces[0].GetString("name") != "Default" || spaces[0].GetBool("archived") {
		t.Fatalf("new database spaces: %v, %v", spaces, err)
	}
	def := req(http.MethodGet, "/api/spaces/default", "", 200)
	first := def["id"].(string)
	if first != spaces[0].Id || def["name"] != "Default" || def["archived"] != false {
		t.Fatalf("default: %v", def)
	}
	settings := req(http.MethodGet, "/api/collections/settings/records/projectsettings", "", 200)
	if settings["default_space"] != first {
		t.Fatalf("settings: %v", settings)
	}

	// Authentication stays required everywhere.
	for _, path := range []string{"/api/spaces/default", "/api/collections/spaces/records", "/api/collections/pages/records",
		"/api/collections/settings/records", "/api/pocketcontext/runs/aaaaaaaaaaaaaaa/check"} {
		status := 401
		if strings.HasPrefix(path, "/api/collections/") {
			status = 200 // list rules filter anonymous requests to nothing
		}
		data := a.request(t, http.MethodGet, path, "", "", status)
		if status == 200 && len(data["items"].([]any)) != 0 {
			t.Fatalf("%s leaked records anonymously: %v", path, data)
		}
	}
	a.request(t, http.MethodGet, "/api/spaces/default", "bad-token", "", 401)
	a.request(t, http.MethodPost, "/api/collections/spaces/records", "", `{"name":"Anonymous"}`, 400)
	a.request(t, http.MethodPost, "/api/collections/pages/records", "", `{"slug":"anon","kind":"concept"}`, 400)

	// The account is hidden and unique.
	req(http.MethodGet, "/api/collections/users/records", "", 403)
	req(http.MethodGet, "/api/collections/users/records/"+a.user.Id, "", 200)
	req(http.MethodPost, "/api/collections/users/records", `{"email":"second@example.localhost","password":"synthetic-password","passwordConfirm":"synthetic-password"}`, 403)
	users, _ := a.app.FindCollectionByNameOrId("users")
	second := core.NewRecord(users)
	second.SetEmail("second@example.localhost")
	second.SetPassword("synthetic-password")
	if err := a.app.Save(second); err == nil || !strings.Contains(err.Error(), "exactly one") {
		t.Fatalf("second account: %v", err)
	}
	if err := a.app.Delete(a.user); err == nil {
		t.Fatal("the account was deleted")
	}

	// Creation validates names; creation fields are server managed.
	created := req(http.MethodPost, "/api/collections/spaces/records", `{"name":"  Research  "}`, 200)
	research := created["id"].(string)
	if created["name"] != "Research" || created["revision"] != float64(1) || created["archived"] != false {
		t.Fatalf("created: %v", created)
	}
	req(http.MethodPost, "/api/collections/spaces/records", `{"name":"   "}`, 400)
	req(http.MethodPost, "/api/collections/spaces/records", `{"name":"`+strings.Repeat("x", 201)+`"}`, 400)
	req(http.MethodPost, "/api/collections/spaces/records", `{"name":`+`"`+strings.Repeat("x", 200)+`"}`, 200)
	req(http.MethodPost, "/api/collections/spaces/records", `{"name":"Bad","archived":true}`, 400)
	req(http.MethodPost, "/api/collections/spaces/records", `{"name":"Bad","kind":"group"}`, 400)

	// Rename and archive need the current revision.
	endpoint := "/api/collections/spaces/records/" + research
	renamed := req(http.MethodPatch, endpoint, `{"name":"Reading","expected_revision":1}`, 200)
	if renamed["name"] != "Reading" || renamed["revision"] != float64(2) {
		t.Fatal(renamed)
	}
	req(http.MethodPatch, endpoint, `{"name":"Stale","expected_revision":1}`, 409)
	req(http.MethodPatch, endpoint, `{"name":"Missing revision"}`, 400)
	req(http.MethodPatch, endpoint, `{"revision":9,"expected_revision":2}`, 400)
	req(http.MethodPatch, endpoint, `{"name":"","expected_revision":2}`, 400)

	// Root records default to the default space; children inherit their parent's.
	implicit := req(http.MethodPost, "/api/collections/pages/records", `{"slug":"implicit","kind":"concept"}`, 200)
	explicit := req(http.MethodPost, "/api/collections/pages/records", `{"slug":"implicit","kind":"concept","space":"`+research+`"}`, 200)
	if implicit["space"] != first || explicit["space"] != research {
		t.Fatalf("root spaces: %v / %v", implicit, explicit)
	}
	req(http.MethodPost, "/api/collections/pages/records", `{"slug":"implicit","kind":"concept"}`, 400) // per-space unique slug
	req(http.MethodPost, "/api/collections/pages/records", `{"slug":"nowhere","kind":"concept","space":"aaaaaaaaaaaaaaa"}`, 404)
	req(http.MethodPost, "/api/collections/pages/records", `{"slug":"x","kind":"concept","created_by":"someone"}`, 200)

	// References never cross spaces.
	run := req(http.MethodPost, "/api/collections/ingestion_runs/records", `{"key":"run-1","status":"staging","description":"Synthetic"}`, 200)
	foreign := req(http.MethodPost, "/api/collections/page_revisions/records",
		`{"run":"`+run["id"].(string)+`","page":"`+explicit["id"].(string)+`","title":"T","summary":"S","body":"[needs verification]"}`, 404)
	_ = foreign
	req(http.MethodPost, "/api/collections/ingestion_runs/records", `{"key":"run-2","status":"staging","description":"Synthetic","home":"`+explicit["id"].(string)+`"}`, 404)
	req(http.MethodPost, "/api/collections/page_revisions/records",
		`{"run":"`+run["id"].(string)+`","page":"`+implicit["id"].(string)+`","space":"`+research+`","title":"T","summary":"S","body":"[needs verification]"}`, 404)
	revision := req(http.MethodPost, "/api/collections/page_revisions/records",
		`{"run":"`+run["id"].(string)+`","page":"`+implicit["id"].(string)+`","title":"T","summary":"S","body":"[needs verification]"}`, 200)
	if revision["space"] != first {
		t.Fatalf("child space: %v", revision)
	}
	req(http.MethodPost, "/api/collections/page_links/records", `{"page_revision":"`+revision["id"].(string)+`","target":"`+explicit["id"].(string)+`"}`, 404)

	// Records are immutable and history is retained.
	req(http.MethodPatch, "/api/collections/pages/records/"+implicit["id"].(string), `{"slug":"renamed","expected_revision":1}`, 400)
	req(http.MethodDelete, "/api/collections/pages/records/"+implicit["id"].(string), "", 403)
	req(http.MethodPost, "/api/collections/publications/records", `{"run":"`+run["id"].(string)+`","sequence":1,"manifest":{}}`, 403)
	req(http.MethodPost, "/api/collections/audit_log/records", `{"action":"create","collection":"pages","record":"x"}`, 403)

	// Publishing works and the audit has no actor.
	published := req(http.MethodPatch, "/api/collections/ingestion_runs/records/"+run["id"].(string), `{"status":"published","expected_revision":1}`, 200)
	if published["status"] != "published" {
		t.Fatal(published)
	}
	audit, err := a.app.FindRecordsByFilter("audit_log", "record = {:id}", "created", 0, 0, map[string]any{"id": run["id"]})
	if err != nil || len(audit) != 2 || audit[0].Collection().Fields.GetByName("actor") != nil {
		t.Fatalf("audit: %v %v", audit, err)
	}

	// The default space cannot be archived; archiving another one blocks writes.
	req(http.MethodPatch, "/api/collections/spaces/records/"+first, `{"archived":true,"expected_revision":1}`, 400)
	archived := req(http.MethodPatch, endpoint, `{"archived":true,"expected_revision":2}`, 200)
	if archived["archived"] != true || archived["revision"] != float64(3) {
		t.Fatal(archived)
	}
	req(http.MethodGet, endpoint, "", 200)
	req(http.MethodGet, "/api/collections/pages/records/"+explicit["id"].(string), "", 200)
	req(http.MethodPost, "/api/collections/pages/records", `{"slug":"archived-write","kind":"concept","space":"`+research+`"}`, 403)
	// An archived space cannot become the default.
	settingsPath := "/api/collections/settings/records/projectsettings"
	req(http.MethodPatch, settingsPath, `{"default_space":"`+research+`","expected_revision":1}`, 400)
	req(http.MethodPatch, endpoint, `{"archived":false,"expected_revision":3}`, 200)
	req(http.MethodPost, "/api/collections/pages/records", `{"slug":"restored-write","kind":"concept","space":"`+research+`"}`, 200)

	// Changing the default moves implicit root records and frees the old default.
	req(http.MethodPatch, settingsPath, `{"default_space":"`+research+`"}`, 400)
	req(http.MethodPatch, settingsPath, `{"default_space":"aaaaaaaaaaaaaaa","expected_revision":1}`, 404)
	req(http.MethodPatch, settingsPath, `{"default_space":"`+research+`","expected_revision":1}`, 200)
	req(http.MethodPatch, settingsPath, `{"default_space":"`+first+`","expected_revision":1}`, 409)
	if got := req(http.MethodGet, "/api/spaces/default", "", 200); got["id"] != research || got["name"] != "Reading" {
		t.Fatalf("new default: %v", got)
	}
	moved := req(http.MethodPost, "/api/collections/pages/records", `{"slug":"after-default","kind":"concept"}`, 200)
	if moved["space"] != research {
		t.Fatalf("root default after change: %v", moved)
	}
	req(http.MethodPatch, endpoint, `{"archived":true,"expected_revision":4}`, 400)
	req(http.MethodPatch, "/api/collections/spaces/records/"+first, `{"archived":true,"expected_revision":1}`, 200)

	// Spaces and settings are retained.
	req(http.MethodDelete, endpoint, "", 403)
	req(http.MethodDelete, settingsPath, "", 403)
	req(http.MethodPost, "/api/collections/settings/records", `{"default_space":"`+first+`"}`, 403)
	for _, name := range []string{"space_members", "user_directory", "project_policy"} {
		if _, err := a.app.FindCollectionByNameOrId(name); err == nil {
			t.Fatalf("collection %s exists", name)
		}
	}
	if spaces, _ := a.app.FindCollectionByNameOrId("spaces"); spaces.Fields.GetByName("kind") != nil || spaces.Fields.GetByName("created_by") != nil {
		t.Fatal("spaces keeps removed fields")
	}
}

// A database from an earlier release is refused before PocketBase opens it,
// and neither the synced file nor the working copy changes.
func TestEarlierReleaseRefused(t *testing.T) {
	dir := t.TempDir()
	for _, tc := range []struct {
		name, schema string
		refused      bool
	}{
		{"old migrations", "CREATE TABLE _migrations (file TEXT PRIMARY KEY, applied INTEGER); INSERT INTO _migrations VALUES ('1640988000_init.go', 1), ('1791500000_spaces.js', 2);", true},
		{"membership table", "CREATE TABLE space_members (id TEXT PRIMARY KEY);", true},
		{"unknown migration", "CREATE TABLE _migrations (file TEXT PRIMARY KEY, applied INTEGER); INSERT INTO _migrations VALUES ('1999999999_future.js', 1);", true},
		{"current", "CREATE TABLE _migrations (file TEXT PRIMARY KEY, applied INTEGER); INSERT INTO _migrations VALUES ('1640988000_init.go', 1), ('1800000000_initial.js', 2);", false},
		{"empty", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(dir, strings.ReplaceAll(tc.name, " ", "-")+".db")
			db, err := sql.Open("sqlite3", path)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := db.Exec("CREATE TABLE notes (id TEXT); " + tc.schema); err != nil {
				t.Fatal(err)
			}
			db.Close()
			before, err := fileSHA256(path)
			if err != nil {
				t.Fatal(err)
			}
			err = checkDatabase(path, "/synced/pocketcontext.db")
			if got := errors.Is(err, ErrEarlierRelease); got != tc.refused {
				t.Fatalf("refused = %v (%v); want %v", got, err, tc.refused)
			}
			if tc.refused && !strings.Contains(err.Error(), "/synced/pocketcontext.db") {
				t.Fatalf("message does not name the database: %v", err)
			}
			if tc.name == "old migrations" && !strings.Contains(err.Error(), "earlier PocketContext release") {
				t.Fatalf("message: %v", err)
			}
			after, err := fileSHA256(path)
			if err != nil || after != before {
				t.Fatalf("the database changed: %v", err)
			}
		})
	}
}

// Store.Open copies an old synced database into the cache, and Serve refuses it
// there; unsaved changes of an earlier release are never written back.
func TestEarlierReleaseWorkingCopyUntouched(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("HOME", t.TempDir())
	project := filepath.Join(t.TempDir(), "pocketcontext.db")
	db, err := sql.Open("sqlite3", project)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("CREATE TABLE space_members (id TEXT PRIMARY KEY)"); err != nil {
		t.Fatal(err)
	}
	db.Close()
	before, _ := fileSHA256(project)
	p, err := Resolve(project)
	if err != nil {
		t.Fatal(err)
	}
	store := &Store{p: p}
	if err := store.Open(); err != nil {
		t.Fatal(err)
	}
	if err := checkDatabase(store.livePath(), p.DB); !errors.Is(err, ErrEarlierRelease) {
		t.Fatalf("working copy accepted: %v", err)
	}
	// An interrupted earlier-release run with unsaved changes.
	store.state.Dirty = true
	if err := store.saveState(); err != nil {
		t.Fatal(err)
	}
	if err := (&Store{p: p}).Open(); !errors.Is(err, ErrEarlierRelease) {
		t.Fatalf("dirty working copy: %v", err)
	}
	if after, _ := fileSHA256(project); after != before {
		t.Fatal("the synced database changed")
	}
	if _, err := os.Stat(store.livePath()); err != nil {
		t.Fatal("the working copy was removed")
	}
}
