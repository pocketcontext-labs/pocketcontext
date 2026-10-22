package bundle

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/jsvm"
)

// Real application migrations/hooks on an isolated database. Trusted fixture
// changes use PocketBase's record API; requests use ordinary user tokens.
func TestProjectSpacePolicy(t *testing.T) {
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	for _, fresh := range []bool{false, true} {
		name := "legacy-company"
		if fresh {
			name = "new-personal"
		}
		t.Run(name, func(t *testing.T) {
			app := core.NewBaseApp(core.BaseAppConfig{DataDir: t.TempDir()})
			app.Store().Set("pocketcontextNewDatabase", fresh)
			jsvm.MustRegister(app, jsvm.Config{HooksDir: filepath.Join(root, "pb_hooks"), MigrationsDir: filepath.Join(root, "pb_migrations"), HooksWatch: false})
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
			request := func(method, path, token, body string, want int) map[string]any {
				t.Helper()
				req := httptest.NewRequest(method, path, strings.NewReader(body))
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("Authorization", token)
				response := httptest.NewRecorder()
				handler.ServeHTTP(response, req)
				if response.Code != want {
					t.Fatalf("%s %s: %d %s; want %d", method, path, response.Code, response.Body, want)
				}
				if strings.HasPrefix(path, "/api/spaces/default") && want == 200 && response.Header().Get("Cache-Control") != "no-store" {
					t.Fatal("account-specific default must not be cached")
				}
				var data map[string]any
				if err := json.Unmarshal(response.Body.Bytes(), &data); err != nil {
					t.Fatal(err)
				}
				return data
			}
			users, err := app.FindCollectionByNameOrId("users")
			if err != nil {
				t.Fatal(err)
			}
			createUser := func(email string) (*core.Record, string) {
				t.Helper()
				u := core.NewRecord(users)
				u.SetEmail(email)
				u.SetPassword("synthetic-password")
				u.Set("name", email)
				u.SetVerified(true)
				if err := app.Save(u); err != nil {
					t.Fatal(err)
				}
				token, err := u.NewAuthToken()
				if err != nil {
					t.Fatal(err)
				}
				return u, token
			}
			alice, token := createUser("alice@example.localhost")
			_, bobToken := createUser("bob@example.localhost")
			first := request(http.MethodGet, "/api/spaces/default", token, "", 200)
			second := request(http.MethodGet, "/api/spaces/default?account="+alice.Id, bobToken, "", 200)
			policy := "company"
			if fresh {
				policy = "personal"
			}
			if first["policy"] != policy {
				t.Fatalf("policy = %v", first)
			}
			own := first["id"].(string)
			if fresh {
				if own == second["id"] || own == "companyspace001" || first["name"] != "Personal" {
					t.Fatalf("personal identity: %v / %v", first, second)
				}
				request(http.MethodGet, "/api/collections/spaces/records/"+own, bobToken, "", 404)
			} else if own != "companyspace001" || second["id"] != own || first["name"] != "Company" {
				t.Fatalf("legacy identity: %v / %v", first, second)
			}
			request(http.MethodGet, "/api/spaces/default", "", "", 401)
			request(http.MethodGet, "/api/collections/project_policy/records", token, "", 403)
			omitted := request(http.MethodPost, "/api/collections/pages/records", token, `{"slug":"implicit","kind":"concept"}`, 200)
			explicit := request(http.MethodPost, "/api/collections/pages/records", token, `{"slug":"explicit","kind":"concept","space":"companyspace001"}`, 200)
			if omitted["space"] != own || explicit["space"] != "companyspace001" {
				t.Fatalf("root defaults: %v / %v", omitted, explicit)
			}
			if fresh {
				request(http.MethodPost, "/api/collections/pages/records", bobToken, `{"slug":"foreign","kind":"concept","space":"`+own+`"}`, 404)
			}
			// Changing startup evidence after migration does not change persisted policy.
			app.Store().Set("pocketcontextNewDatabase", !fresh)
			if err := app.RunAllMigrations(); err != nil {
				t.Fatal(err)
			}
			if got := request(http.MethodGet, "/api/spaces/default", token, "", 200); got["id"] != own {
				t.Fatalf("policy changed: %v", got)
			}
			personal := request(http.MethodPost, "/api/spaces/personal", token, `{}`, 200)["id"]
			if got := request(http.MethodGet, "/api/spaces/default", token, "", 200); got["id"] != own {
				t.Fatalf("explicit personal creation changed policy: %v", got)
			}
			if fresh && personal != own {
				t.Fatal("personal creation is not idempotent")
			}
			memberships, err := app.FindRecordsByFilter("space_members", "space={:space} && account={:account}", "", 1, 0, map[string]any{"space": own, "account": alice.Id})
			if err != nil || len(memberships) != 1 {
				t.Fatalf("membership: %v", err)
			}
			memberships[0].Set("active", false)
			if err := app.Save(memberships[0]); err != nil {
				t.Fatal(err)
			}
			request(http.MethodGet, "/api/spaces/default", token, "", 404)
			request(http.MethodPost, "/api/collections/pages/records", token, `{"slug":"revoked","kind":"concept"}`, 404)
			// Auth refresh and personal creation must not restore revoked access.
			request(http.MethodPost, "/api/collections/users/auth-refresh", token, `{}`, 200)
			request(http.MethodPost, "/api/spaces/personal", token, `{}`, 200)
			request(http.MethodGet, "/api/spaces/default", token, "", 404)
			alice.Set("disabled", true)
			if err := app.Save(alice); err != nil {
				t.Fatal(err)
			}
			request(http.MethodGet, "/api/spaces/default", token, "", 401)
		})
	}
}
