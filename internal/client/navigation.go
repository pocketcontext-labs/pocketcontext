package client

import (
	"encoding/json"
	"math"
	"regexp"
	"strings"
)

var navigationColumnPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)

// Navigation is revision metadata. These checks let stage/dry-run reject bad
// navigation before writing a run; properties.js remains the REST authority.
func navigationPropertyProblems(slug string, properties map[string]any) []string {
	var problems []string
	for _, key := range []string{"topics", "catalogs"} {
		if value, exists := properties[key]; exists {
			values, ok := navigationStrings(value, 100)
			for _, value := range values {
				ok = ok && len(value) <= 64 && slugPattern.MatchString(value)
			}
			if !ok {
				problems = append(problems, key+" must contain up to 100 unique lowercase hyphenated slugs of at most 64 characters")
			}
		}
	}
	kind, definition := properties["navigation_kind"]
	if definition {
		if kind != "topic" && kind != "catalog" {
			problems = append(problems, "navigation_kind must be topic or catalog")
		}
		if len(slug) > 64 {
			problems = append(problems, "Navigation definition page slug must be at most 64 characters")
		}
	}
	if value, exists := properties["navigation_order"]; exists && (!definition || !navigationOrder(value)) {
		problems = append(problems, "navigation_order requires a definition and a nonnegative safe integer")
	}
	for _, key := range []string{"catalog_columns", "catalog_sort"} {
		if _, exists := properties[key]; exists && kind != "catalog" {
			problems = append(problems, key+" requires navigation_kind catalog")
		}
	}
	columns, validColumns := navigationStrings(properties["catalog_columns"], 12)
	if _, exists := properties["catalog_columns"]; exists {
		for _, key := range columns {
			validColumns = validColumns && navigationColumn(key)
		}
		if !validColumns {
			problems = append(problems, "catalog_columns requires up to 12 unique safe property or display field names")
		}
	}
	if value, exists := properties["catalog_sort"]; exists {
		sort, ok := value.(string)
		key := strings.TrimPrefix(sort, "-")
		listed := key == "title"
		for _, column := range columns {
			listed = listed || key == column
		}
		if !ok || key == "" || !listed {
			problems = append(problems, "catalog_sort must be title or a listed column, optionally prefixed with -")
		}
	}
	return problems
}

func navigationStrings(value any, max int) ([]string, bool) {
	var values []string
	switch list := value.(type) {
	case []any:
		for _, item := range list {
			text, ok := item.(string)
			if !ok {
				return nil, false
			}
			values = append(values, text)
		}
	case []string:
		values = list
	default:
		return nil, false
	}
	seen := map[string]bool{}
	for _, text := range values {
		if seen[text] {
			return values, false
		}
		seen[text] = true
	}
	return values, len(values) <= max
}

func navigationOrder(value any) bool {
	var number float64
	switch value := value.(type) {
	case json.Number:
		var err error
		number, err = value.Float64()
		if err != nil {
			return false
		}
	case float64:
		number = value
	default:
		return false
	}
	return !math.IsNaN(number) && number >= 0 && number <= 9007199254740991 && number == math.Trunc(number)
}

func navigationColumn(key string) bool {
	if !navigationColumnPattern.MatchString(key) {
		return false
	}
	switch key {
	case "pocketcontext_page", "pocketcontext_revision", "id", "page", "page_id", "revision", "revision_id", "publication", "publication_id", "body", "archived", "run", "base_revision", "created", "updated", "created_by", "updated_by", "properties", "property_evidence", "constructor", "prototype", "__proto__":
		return false
	}
	return true
}
