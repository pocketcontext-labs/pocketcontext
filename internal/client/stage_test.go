package client

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestParseSpec(t *testing.T) {
	spec, problems, err := parseSpec([]byte(`{"run_key":"k","home":"a","pages":[
		{"slug":"a","kind":"concept","title":"A","summary":"S","body":"x[^1]","citations":{"1":"aaaaaaaaaaaaaaa"},"properties":{"n":3}},
		{"slug":"b","append":"more"}]}`))
	if err != nil || len(problems) != 0 {
		t.Fatalf("valid spec: %v %v", err, problems)
	}
	if spec.Pages[1].Append == nil || spec.Pages[1].Body != nil || spec.Pages[1].Title != nil {
		t.Fatalf("append page parsed as %+v", spec.Pages[1])
	}
	if n, _ := spec.Pages[0].Properties["n"].(json.Number); n.String() != "3" {
		t.Fatalf("numbers must survive unchanged: %#v", spec.Pages[0].Properties)
	}
	if _, _, err := parseSpec([]byte(`{"run_key":"k","pages":[{"slug":"a","bogus":1}]}`)); err == nil {
		t.Fatal("unknown field accepted")
	}
	_, problems, err = parseSpec([]byte(`{"pages":[
		{"slug":"Bad Slug","kind":"essay","body":"x","append":"y"},
		{"slug":"index"},{"slug":"c","citations":{"0":"short"}},{"slug":"c"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	kinds := map[string]int{}
	for _, p := range problems {
		kinds[p.Kind]++
	}
	want := map[string]int{"spec": 2, "slug": 2, "kind": 1, "citation": 2, "duplicate": 1}
	if !reflect.DeepEqual(kinds, want) {
		t.Fatalf("problem kinds %v, want %v (%v)", kinds, want, problems)
	}
}

func TestBodyLinksAndMarkers(t *testing.T) {
	body := "See [[plan-mode]], [[claude-code|Claude Code]] and [[plan-mode#usage]].[^2][^1] Again[^2] [[x#h|label]]"
	if got := bodyLinks(body); !reflect.DeepEqual(got, []string{"plan-mode", "claude-code", "x"}) {
		t.Fatalf("links %v", got)
	}
	if got := bodyMarkers(body); !reflect.DeepEqual(got, []string{"2", "1"}) {
		t.Fatalf("markers %v", got)
	}
	if !footnotePattern.MatchString("text\n[^1]: note") || footnotePattern.MatchString("text [^1]: inline") {
		t.Fatal("footnote definitions are lines starting with [^n]:")
	}
}

func TestAppendRenumbersMarkers(t *testing.T) {
	body := "Published.[^1] More.[^3]\n"
	citations := map[string]string{"1": "p1", "2": "p2", "3": "p3"} // 2 is used only by property evidence
	merged, all, problems := revisePage(body, citations, nil, "\n## New\n\nAdded.[^1] Also[^2].[^1]", map[string]string{"1": "q1", "2": "q2"}, nil)
	if problems != nil {
		t.Fatalf("problems %v", problems)
	}
	if merged != "Published.[^1] More.[^3]\n\n## New\n\nAdded.[^4] Also[^5].[^4]" {
		t.Fatalf("merged body %q", merged)
	}
	want := map[string]string{"1": "p1", "2": "p2", "3": "p3", "4": "q1", "5": "q2"}
	if !reflect.DeepEqual(all, want) {
		t.Fatalf("citations %v", all)
	}
	if same, kept, _ := revisePage(body, citations, nil, "", nil, nil); same != body || !reflect.DeepEqual(kept, citations) {
		t.Fatal("an empty append keeps the body")
	}
	if got := highestMarker("a[^12]", map[string]string{"3": "x"}); got != 12 {
		t.Fatalf("highest marker %d", got)
	}
	if got := renumber("[^1] [^10] [^x]", 9); got != "[^10] [^19] [^x]" {
		t.Fatalf("renumber %q", got)
	}
}

func strp(s string) *string { return &s }

func TestReviseEditsRenumberAndPrune(t *testing.T) {
	body := "Orbits take 97 minutes.[^1] Beacons answer in 4 seconds.[^2] Cadence is fixed.[^3]\n"
	citations := map[string]string{"1": "p1", "2": "p2", "3": "p3", "4": "p4"} // 4 is used only by property evidence
	edits := []specEdit{
		{Old: "Beacons answer in 4 seconds.[^2]", New: strp("Beacons answer in 3 seconds.[^1]")},
		{Old: "Cadence is fixed.", New: strp("Cadence is fixed.[^2] It drifts in winter.[^1]")},
	}
	merged, all, problems := revisePage(body, citations, edits, "Later.[^3]", map[string]string{"1": "q1", "2": "q2", "3": "q3"}, map[string]bool{"4": true})
	if problems != nil {
		t.Fatalf("problems %v", problems)
	}
	want := "Orbits take 97 minutes.[^1] Beacons answer in 3 seconds.[^5] Cadence is fixed.[^6] It drifts in winter.[^5][^3]\n\nLater.[^7]"
	if merged != want {
		t.Fatalf("body %q", merged)
	}
	// [^2] left the body and is dropped; [^3] stays after its sentence; [^4] is kept for property evidence.
	wantCitations := map[string]string{"1": "p1", "3": "p3", "4": "p4", "5": "q1", "6": "q2", "7": "q3"}
	if !reflect.DeepEqual(all, wantCitations) {
		t.Fatalf("citations %v", all)
	}
	// Without the evidence marker in keep, an unused published marker that was never in the body stays too.
	_, all, _ = revisePage(body, citations, edits[:1], "", map[string]string{"1": "q1"}, nil)
	if !reflect.DeepEqual(all, map[string]string{"1": "p1", "3": "p3", "4": "p4", "5": "q1"}) {
		t.Fatalf("citations without keep %v", all)
	}
	// Deleting text with new "" drops its marker.
	deleted, all, _ := revisePage(body, citations, []specEdit{{Old: " Cadence is fixed.[^3]", New: strp("")}}, "", nil, nil)
	if deleted != "Orbits take 97 minutes.[^1] Beacons answer in 4 seconds.[^2]\n" || all["3"] != "" {
		t.Fatalf("delete: %q %v", deleted, all)
	}
}

func TestReviseEditsMustMatchOnce(t *testing.T) {
	body := "A cat. A cat. A dog. aaa"
	edits := []specEdit{
		{Old: "A cat.", New: strp("x")},  // twice
		{Old: "A bird.", New: strp("x")}, // missing
		{Old: "A dog.", New: strp("A dog and a cat.")},
		{Old: "a cat.", New: strp("y")}, // created by the previous edit: case-sensitive and unique now
		{Old: "aa", New: strp("b")},     // overlapping occurrences count twice
	}
	merged, _, problems := revisePage(body, nil, edits, "", nil, nil)
	if merged != "A cat. A cat. A dog and y aaa" {
		t.Fatalf("body %q", merged)
	}
	if len(problems) != 3 || !strings.HasPrefix(problems[0], "edits[0]: old text occurs more than once") ||
		!strings.HasPrefix(problems[1], "edits[1]: old text not found") || !strings.HasPrefix(problems[2], "edits[4]: old text occurs more than once") {
		t.Fatalf("problems %q", problems)
	}
	_, specProblems, err := parseSpec([]byte(`{"run_key":"k","pages":[{"slug":"a","body":"x","edits":[{"old":"","new":"y"},{"old":"z"}]}]}`))
	if err != nil {
		t.Fatal(err)
	}
	var details []string
	for _, p := range specProblems {
		details = append(details, p.Kind+": "+p.Detail)
	}
	want := []string{"spec: give body or edits, not both; edits change the published body", "edit: edits[0]: old is empty",
		`edit: edits[1]: new is required ("" deletes the old text)`}
	if !reflect.DeepEqual(details, want) {
		t.Fatalf("spec problems %q", details)
	}
}

func TestPackBatches(t *testing.T) {
	group := func(n int, tag string) []any {
		out := make([]any, n)
		for i := range out {
			out[i] = tag
		}
		return out
	}
	sizes := func(batches [][]any) []int {
		out := []int{}
		for _, b := range batches {
			out = append(out, len(b))
		}
		return out
	}
	// Groups stay together when they fit; an oversized group spans batches in order.
	got := packBatches([][]any{group(1, "a"), group(1, "b"), group(12, "c"), group(8, "d"), group(45, "e"), group(3, "f")}, 20)
	if !reflect.DeepEqual(sizes(got), []int{14, 8, 20, 20, 8}) {
		t.Fatalf("batch sizes %v", sizes(got))
	}
	var flat []string
	for _, b := range got {
		for _, r := range b {
			flat = append(flat, r.(string))
		}
	}
	if strings.Join(flat, "") != "abcccccccccccc"+strings.Repeat("d", 8)+strings.Repeat("e", 45)+"fff" {
		t.Fatalf("order changed: %v", flat)
	}
	if len(packBatches(nil, 20)) != 0 {
		t.Fatal("no groups, no batches")
	}
}
