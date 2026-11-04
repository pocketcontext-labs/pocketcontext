package chat

import (
	"encoding/json"
	"testing"
)

func TestImportApprovalRecognizesOnlyBoundLiteralCommand(t *testing.T) {
	m := &Manager{c: Config{KnowledgeBinary: "/host/pocketcontext", KnowledgeDB: "/host/data.db"}}
	base := `"/host/pocketcontext" --db "/host/data.db" --space space1 ingest "/tmp/my note.md"`
	for _, tc := range []struct{ cmd, want string }{
		{base, "my note.md"}, {base + ` --title "Manual: Chat"`, "my note.md"}, {base + "; touch /tmp/x", ""}, {base + ` --title "$(whoami)"`, ""}, {"/other/pocketcontext --db /host/data.db --space space1 ingest /tmp/a", ""}, {"/host/pocketcontext --db /host/data.db --space space2 ingest /tmp/a", ""},
	} {
		raw, _ := json.Marshal(map[string]any{"rawInput": map[string]string{"command": tc.cmd}})
		if got := m.importFile("space1", raw); got != tc.want {
			t.Errorf("%q: got %q, want %q", tc.cmd, got, tc.want)
		}
	}
}
