package client

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakeSpaces answers SQL with rows from spaces and records PATCH/POST bodies.
type fakeSpaces struct {
	t        *testing.T
	spaces   [][]any // id, name, archived, revision
	calls    []string
	bodies   []map[string]any
	defaultS string
}

func (f *fakeSpaces) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.calls = append(f.calls, r.Method+" "+r.URL.Path)
	w.Header().Set("Content-Type", "application/json")
	var body map[string]any
	data, _ := io.ReadAll(r.Body)
	_ = json.Unmarshal(data, &body)
	switch {
	case r.URL.Path == "/api/spaces/default":
		fmt.Fprintf(w, `{"id":%q,"name":"Default","archived":false,"revision":1,"settings_revision":3}`, f.defaultS)
	case r.URL.Path == "/api/context/query":
		sql := body["sql"].(string)
		var rows [][]any
		for _, s := range f.spaces {
			if strings.Contains(sql, "'"+s[0].(string)+"'") || strings.Contains(sql, "'"+s[1].(string)+"'") {
				rows = append(rows, s)
			}
		}
		if rows == nil {
			rows = [][]any{}
		}
		out, _ := json.Marshal(map[string]any{"columns": []string{"id", "name", "archived", "revision"}, "rows": rows})
		w.Write(out)
	default:
		f.bodies = append(f.bodies, body)
		fmt.Fprint(w, `{"id":"newspace0000001","name":"Created","archived":false,"revision":1}`)
	}
}

func newFake(t *testing.T, explicit string, spaces ...[]any) (*Client, *fakeSpaces) {
	f := &fakeSpaces{t: t, spaces: spaces, defaultS: "defaultspace001"}
	server := httptest.NewServer(f)
	t.Cleanup(server.Close)
	return &Client{Base: server.URL, Space: explicit, http: server.Client()}, f
}

func TestSpaceSelection(t *testing.T) {
	spaces := [][]any{
		{"defaultspace001", "Default", 0, 1},
		{"researchspace01", "Research", 1, 2},
		{"twinspace000001", "Twin", 0, 1},
		{"twinspace000002", "Twin", 0, 1},
	}
	for _, tc := range []struct{ name, explicit, want, error string }{
		{"default", "", "defaultspace001", ""},
		{"by id", "researchspace01", "researchspace01", ""},
		{"by name", "Research", "researchspace01", ""},
		{"archived spaces are readable", " Research ", "researchspace01", ""},
		{"ambiguous name", "Twin", "", "twinspace000001, twinspace000002"},
		{"unknown", "Nowhere", "", "no space"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, f := newFake(t, strings.TrimSpace(tc.explicit), spaces...)
			got, err := c.SpaceID()
			if got != tc.want || (err != nil) != (tc.error != "") || err != nil && !strings.Contains(err.Error(), tc.error) {
				t.Fatalf("SpaceID() = %q, %v; want %q %q", got, err, tc.want, tc.error)
			}
			if err != nil && err.(*Fail).Code != 2 {
				t.Fatalf("exit code %d", err.(*Fail).Code)
			}
			if tc.want != "" {
				if again, err := c.SpaceID(); err != nil || again != got {
					t.Fatalf("cached selection: %q %v", again, err)
				}
			}
			if len(f.calls) != 1 {
				t.Fatalf("requests = %v; expected one resolution", f.calls)
			}
		})
	}
}

func TestCreateSpaceReusesOrRefuses(t *testing.T) {
	spaces := [][]any{{"researchspace01", "Research", 0, 2}, {"twinspace000001", "Twin", 0, 1}, {"twinspace000002", "Twin", 0, 1}}
	c, f := newFake(t, "", spaces...)
	got, err := c.CreateSpace("  Research ")
	if err != nil || got["id"] != "researchspace01" || got["created"] != false || len(f.bodies) != 0 {
		t.Fatalf("reuse: %v %v %v", got, err, f.bodies)
	}
	if _, err := c.CreateSpace("Twin"); err == nil || !strings.Contains(err.Error(), "twinspace000001, twinspace000002") {
		t.Fatalf("ambiguous: %v", err)
	}
	for _, bad := range []string{"", "   ", strings.Repeat("x", 201)} {
		if _, err := c.CreateSpace(bad); err == nil || err.(*Fail).Code != 2 {
			t.Fatalf("name %q: %v", bad, err)
		}
	}
	got, err = c.CreateSpace("Fresh")
	if err != nil || got["created"] != true || len(f.bodies) != 1 || f.bodies[0]["name"] != "Fresh" {
		t.Fatalf("create: %v %v %v", got, err, f.bodies)
	}
	if _, err := c.CreateSpace(strings.Repeat("é", 200)); err != nil {
		t.Fatalf("200 characters: %v", err)
	}
}

func TestSpaceUpdatesCarryRevisions(t *testing.T) {
	c, f := newFake(t, "", []any{"researchspace01", "Research", 0, 2})
	if _, err := c.UpdateSpace("Research", map[string]any{"name": " Reading "}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.UpdateSpace("researchspace01", map[string]any{"archived": true}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.SetDefaultSpace("Research"); err != nil {
		t.Fatal(err)
	}
	want := []string{
		`{"expected_revision":2,"name":"Reading"}`,
		`{"archived":true,"expected_revision":2}`,
		`{"default_space":"researchspace01","expected_revision":3}`,
	}
	for i, body := range f.bodies {
		got, _ := json.Marshal(body)
		if string(got) != want[i] {
			t.Errorf("body %d = %s; want %s", i, got, want[i])
		}
	}
	if !strings.Contains(strings.Join(f.calls, " "), "PATCH /api/collections/settings/records/projectsettings") {
		t.Fatalf("calls: %v", f.calls)
	}
}
