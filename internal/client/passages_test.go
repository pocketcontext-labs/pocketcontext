package client

import (
	"strings"
	"testing"
)

func TestSourcePassagesText(t *testing.T) {
	s := &SourcePassages{passages: []sourcePassage{
		{1, "aaaaaaaaaaaaaaa", "front matter; lines 1-3", "---\r\ntitle: T\r\n---"},
		{2, "bbbbbbbbbbbbbbb", "# T; lines 4-6", "# T\n\nText.\n"},
	}}
	want := "=== 1 · aaaaaaaaaaaaaaa · front matter; lines 1-3\n---\ntitle: T\n---\n\n=== 2 · bbbbbbbbbbbbbbb · # T; lines 4-6\n# T\n\nText.\n"
	if got := s.Text(); got != want {
		t.Fatalf("text %q", got)
	}
	if (&SourcePassages{}).Text() != "" {
		t.Fatal("no passages, no text")
	}
	rows := func(labels ...string) []map[string]any {
		out := []map[string]any{}
		for _, l := range labels {
			out = append(out, map[string]any{"version_label": l})
		}
		return out
	}
	for labels, want := range map[string]int{"": -1, "v1": 0, "v1 custom": 1, "v3 v2 custom": 0, "v1 v2 custom": 1, "v2 v3 v1": 1} {
		if got := preferredRendition(rows(strings.Fields(labels)...)); got != want {
			t.Errorf("preferredRendition(%s) = %d, want %d", labels, got, want)
		}
	}
}
