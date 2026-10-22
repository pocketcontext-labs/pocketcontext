package client

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSpaceSelection(t *testing.T) {
	for _, tc := range []struct {
		name, explicit, body, want string
		status                     int
	}{
		{"personal default", "", `{"id":"personalspace01","policy":"personal"}`, "personalspace01", 200},
		{"legacy default", "", `{"id":"companyspace001","policy":"company"}`, "companyspace001", 200},
		{"inaccessible default", "", `{"message":"Not found"}`, "", 404},
		{"malformed default", "", `{"id":"bad"}`, "", 200},
		{"explicit company", "companyspace001", `{"columns":["id"],"rows":[["companyspace001"]]}`, "companyspace001", 200},
		{"explicit inaccessible", "foreignspace001", `{"columns":["id"],"rows":[]}`, "", 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				path, method := "/api/spaces/default", "GET"
				if tc.explicit != "" {
					path, method = "/api/context/query", "POST"
				}
				if r.URL.Path != path || r.Method != method {
					t.Errorf("unexpected fallback: %s %s", r.Method, r.URL.Path)
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tc.status)
				fmt.Fprint(w, tc.body)
			}))
			defer server.Close()
			client := &Client{Base: server.URL, Space: tc.explicit, http: server.Client()}
			got, err := client.SpaceID()
			if got != tc.want || (err != nil) != (tc.want == "") {
				t.Fatalf("SpaceID() = %q, %v; want %q", got, err, tc.want)
			}
			if tc.want != "" {
				if again, err := client.SpaceID(); err != nil || again != got {
					t.Fatalf("cached selection: %q %v", again, err)
				}
			}
			if calls != 1 {
				t.Fatalf("requests = %d; expected one authorized resolution", calls)
			}
		})
	}
}
