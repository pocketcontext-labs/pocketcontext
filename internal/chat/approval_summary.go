package chat

import (
	"encoding/json"
	"path/filepath"
	"regexp"
	"strings"
)

// Recognize only literal arguments in the documented single-file ingest form.
// Commands with shell expansions, operators or unfamiliar flags keep the raw view.
var literalArg = regexp.MustCompile(`^(?:"([a-zA-Z0-9_./ :+-]+)"|'([a-zA-Z0-9_./ :+-]+)'|([a-zA-Z0-9_./:+-]+))(?: +|$)`)

func (m *Manager) importFile(space string, tool json.RawMessage) string {
	var call struct {
		RawInput struct {
			Command string `json:"command"`
		} `json:"rawInput"`
	}
	if json.Unmarshal(tool, &call) != nil {
		return ""
	}
	line := strings.TrimSpace(call.RawInput.Command)
	args := []string{}
	for line != "" && len(args) < 10 {
		match := literalArg.FindStringSubmatch(line)
		if match == nil {
			return ""
		}
		args = append(args, match[1]+match[2]+match[3])
		line = line[len(match[0]):]
	}
	if line != "" || (len(args) != 7 && len(args) != 9) || args[0] != m.c.KnowledgeBinary || args[1] != "--db" || args[2] != m.c.KnowledgeDB || args[3] != "--space" || args[4] != space || args[5] != "ingest" || !(filepath.IsAbs(args[6]) || strings.HasPrefix(args[6], "/")) || (len(args) == 9 && args[7] != "--title") {
		return ""
	}
	return filepath.Base(args[6])
}
