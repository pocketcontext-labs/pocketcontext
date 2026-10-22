package client

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestNavigationPropertySpec(t *testing.T) {
	tests := []struct {
		name, properties string
		valid            bool
	}{
		{"legacy metadata", `{"catalog_type":"resource","provider":"example"}`, true},
		{"memberships without definitions", `{"topics":["research","other"],"catalogs":["research-tools"]}`, true},
		{"ordinary group keys matching object names", `{"topics":["constructor","prototype"]}`, true},
		{"empty memberships", `{"topics":[],"catalogs":[]}`, true},
		{"topic definition", `{"navigation_kind":"topic","navigation_order":0}`, true},
		{"catalog definition", `{"navigation_kind":"catalog","navigation_order":9007199254740991,"catalog_columns":["title","summary","slug","kind","provider"],"catalog_sort":"-provider"}`, true},
		{"default sort", `{"navigation_kind":"catalog","catalog_sort":"-title"}`, true},
		{"empty columns", `{"navigation_kind":"catalog","catalog_columns":[]}`, true},
		{"decimal integer order", `{"navigation_kind":"topic","navigation_order":1.0}`, true},
		{"string membership", `{"topics":"research"}`, false},
		{"null membership", `{"topics":null}`, false},
		{"uppercase membership", `{"topics":["Research"]}`, false},
		{"padded membership", `{"catalogs":[" research"]}`, false},
		{"underscore membership", `{"topics":["research_tools"]}`, false},
		{"duplicate membership", `{"catalogs":["tools","tools"]}`, false},
		{"empty key", `{"topics":[""]}`, false},
		{"repeated hyphen", `{"topics":["research--tools"]}`, false},
		{"trailing hyphen", `{"topics":["research-"]}`, false},
		{"nonstring key", `{"topics":[42]}`, false},
		{"null kind", `{"navigation_kind":null}`, false},
		{"invalid kind", `{"navigation_kind":"group"}`, false},
		{"order without definition", `{"navigation_order":0}`, false},
		{"negative order", `{"navigation_kind":"topic","navigation_order":-1}`, false},
		{"fractional order", `{"navigation_kind":"topic","navigation_order":1.5}`, false},
		{"unsafe order", `{"navigation_kind":"topic","navigation_order":9007199254740992}`, false},
		{"string order", `{"navigation_kind":"topic","navigation_order":"1"}`, false},
		{"columns without catalog", `{"catalog_columns":["provider"]}`, false},
		{"topic columns", `{"navigation_kind":"topic","catalog_columns":["provider"]}`, false},
		{"duplicate column", `{"navigation_kind":"catalog","catalog_columns":["provider","provider"]}`, false},
		{"null columns", `{"navigation_kind":"catalog","catalog_columns":null}`, false},
		{"unsafe column", `{"navigation_kind":"catalog","catalog_columns":["provider.name"]}`, false},
		{"reserved column", `{"navigation_kind":"catalog","catalog_columns":["body"]}`, false},
		{"prototype column", `{"navigation_kind":"catalog","catalog_columns":["__proto__"]}`, false},
		{"constructor column", `{"navigation_kind":"catalog","catalog_columns":["constructor"]}`, false},
		{"prototype named column", `{"navigation_kind":"catalog","catalog_columns":["prototype"]}`, false},
		{"unlisted sort", `{"navigation_kind":"catalog","catalog_sort":"provider"}`, false},
		{"topic sort", `{"navigation_kind":"topic","catalog_sort":"title"}`, false},
		{"double descending", `{"navigation_kind":"catalog","catalog_sort":"--title"}`, false},
		{"null sort", `{"navigation_kind":"catalog","catalog_sort":null}`, false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			data := `{"run_key":"navigation","pages":[{"slug":"research-tools","properties":` + test.properties + `}]}`
			_, problems, err := parseSpec([]byte(data))
			if err != nil || (len(problems) == 0) != test.valid {
				t.Fatalf("valid=%v: %v %v", test.valid, err, problems)
			}
			for _, problem := range problems {
				if problem.Kind != "property" {
					t.Fatalf("unexpected problem: %+v", problem)
				}
			}
		})
	}
}

func TestNavigationBounds(t *testing.T) {
	keys := make([]string, 101)
	for i := range keys {
		keys[i] = fmt.Sprintf("group-%d", i)
	}
	for _, count := range []int{100, 101} {
		problems := navigationPropertyProblems("definition", map[string]any{"topics": keys[:count]})
		if (len(problems) == 0) != (count == 100) {
			t.Fatalf("membership count %d: %v", count, problems)
		}
	}
	for _, count := range []int{12, 13} {
		columns := make([]string, count)
		for i := range columns {
			columns[i] = fmt.Sprintf("property_%d", i)
		}
		problems := navigationPropertyProblems("definition", map[string]any{"navigation_kind": "catalog", "catalog_columns": columns})
		if (len(problems) == 0) != (count == 12) {
			t.Fatalf("column count %d: %v", count, problems)
		}
	}
	for _, length := range []int{64, 65} {
		key := strings.Repeat("a", length)
		for _, properties := range []map[string]any{{"topics": []string{key}}, {"navigation_kind": "topic", "navigation_order": json.Number("0")}} {
			if problems := navigationPropertyProblems(key, properties); (len(problems) == 0) != (length == 64) {
				t.Fatalf("key length %d: %v", length, problems)
			}
		}
	}
	if problems := navigationPropertyProblems(strings.Repeat("a", 150), nil); len(problems) != 0 {
		t.Fatalf("ordinary long page slugs stay valid: %v", problems)
	}
}
