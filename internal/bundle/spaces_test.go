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
			if fresh {
				spaces, err := app.FindAllRecords("spaces")
				if err != nil || len(spaces) != 1 || spaces[0].GetString("kind") != "personal" || spaces[0].GetString("created_by") != alice.Id {
					t.Fatalf("fresh project must contain only Alice's Personal space: %v, %v", spaces, err)
				}
				members, err := app.FindAllRecords("space_members")
				if err != nil || len(members) != 1 || members[0].GetString("space") != spaces[0].Id || members[0].GetString("account") != alice.Id || members[0].GetString("role") != "owner" || !members[0].GetBool("active") {
					t.Fatalf("fresh Personal space must have one active owner: %v, %v", members, err)
				}
			}
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
			explicit := request(http.MethodPost, "/api/collections/pages/records", token, `{"slug":"explicit","kind":"concept","space":"`+own+`"}`, 200)
			if omitted["space"] != own || explicit["space"] != own {
				t.Fatalf("root defaults: %v / %v", omitted, explicit)
			}
			if fresh {
				request(http.MethodGet, "/api/collections/spaces/records/companyspace001", token, "", 404)
				request(http.MethodPost, "/api/collections/pages/records", token, `{"slug":"company","kind":"concept","space":"companyspace001"}`, 404)
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
			if fresh {
				spaces, err := app.FindAllRecords("spaces")
				if err != nil || len(spaces) != 2 {
					t.Fatalf("migration replay must retain only the two Personal spaces: %v, %v", spaces, err)
				}
			}
			personal := request(http.MethodPost, "/api/spaces/personal", token, `{}`, 200)["id"]
			if got := request(http.MethodGet, "/api/spaces/default", token, "", 200); got["id"] != own {
				t.Fatalf("explicit personal creation changed policy: %v", got)
			}
			if fresh && personal != own {
				t.Fatal("personal creation is not idempotent")
			}
			// Ordinary owner management never grants access to other accounts.
			request(http.MethodPost, "/api/collections/spaces/records", "", `{"kind":"group","name":"Private project"}`, 400)
			created := request(http.MethodPost, "/api/collections/spaces/records", token, `{"kind":"group","name":"Private project"}`, 200)
			managed := created["id"].(string)
			endpoint := "/api/collections/spaces/records/" + managed
			request(http.MethodGet, endpoint, bobToken, "", 404)
			request(http.MethodPatch, endpoint, bobToken, `{"name":"Intrusion","expected_revision":1}`, 404)
			renamed := request(http.MethodPatch, endpoint, token, `{"name":"Renamed project","expected_revision":1}`, 200)
			if renamed["name"] != "Renamed project" || renamed["revision"] != float64(2) {
				t.Fatal(renamed)
			}
			request(http.MethodPatch, endpoint, token, `{"name":"Stale","expected_revision":1}`, 409)
			request(http.MethodPatch, endpoint, token, `{"created_by":"other","expected_revision":2}`, 400)
			request(http.MethodPatch, endpoint, token, `{"name":"  ","expected_revision":2}`, 400)
			retained := request(http.MethodPost, "/api/collections/pages/records", token, `{"slug":"retained","kind":"concept","space":"`+managed+`"}`, 200)
			request(http.MethodPatch, endpoint, token, `{"archived":true,"expected_revision":2}`, 200)
			request(http.MethodGet, endpoint, token, "", 200)
			request(http.MethodGet, "/api/collections/pages/records/"+retained["id"].(string), token, "", 200)
			request(http.MethodPost, "/api/collections/pages/records", token, `{"slug":"archived-write","kind":"concept","space":"`+managed+`"}`, 403)
			request(http.MethodPatch, endpoint, token, `{"archived":false,"expected_revision":3}`, 200)
			request(http.MethodPost, "/api/collections/pages/records", token, `{"slug":"restored-write","kind":"concept","space":"`+managed+`"}`, 200)
			request(http.MethodDelete, endpoint, token, "", 403)
			companyStatus := 403
			if fresh {
				companyStatus = 404
			}
			request(http.MethodPatch, "/api/collections/spaces/records/companyspace001", token, `{"name":"Forbidden","expected_revision":1}`, companyStatus)
			personalID := personal.(string)
			request(http.MethodPatch, "/api/collections/spaces/records/"+personalID, token, `{"archived":true,"expected_revision":1}`, 400)
			request(http.MethodPatch, "/api/collections/spaces/records/"+personalID, token, `{"name":"My notes","expected_revision":1}`, 200)
			request(http.MethodPost, "/api/collections/spaces/records", token, `{"kind":"group","name":"Bad","created_by":"other"}`, 400)
			// Even a co-member with write access cannot manage the space itself.
			memberCollection, _ := app.FindCollectionByNameOrId("space_members")
			bob, _ := app.FindFirstRecordByFilter("users", "email='bob@example.localhost'")
			editor := core.NewRecord(memberCollection)
			editor.Set("space", managed)
			editor.Set("account", bob.Id)
			editor.Set("role", "editor")
			editor.Set("active", true)
			editor.Set("revision", 1)
			if err := app.Save(editor); err != nil {
				t.Fatal(err)
			}
			request(http.MethodPatch, endpoint, bobToken, `{"archived":true,"expected_revision":4}`, 403)
			// Revoked owners cannot rename, restore, or obtain fresh access.
			managedMembers, _ := app.FindRecordsByFilter("space_members", "space={:space} && account={:account}", "", 1, 0, map[string]any{"space": managed, "account": alice.Id})
			managedMembers[0].Set("active", false)
			if err := app.Save(managedMembers[0]); err != nil {
				t.Fatal(err)
			}
			request(http.MethodPatch, endpoint, token, `{"name":"Revoked","expected_revision":4}`, 404)
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
			request(http.MethodPost, "/api/collections/spaces/records", token, `{"kind":"group","name":"Disabled"}`, 401)
		})
	}
}
