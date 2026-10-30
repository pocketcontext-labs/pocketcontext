package client

import (
	"regexp"
	"strings"
)

// referenceText masks Markdown code and escapes, preserving byte offsets so
// references in examples never become publication dependencies.
func referenceText(body string) string {
	b := []byte(body)
	mask := func(start, end int) {
		for i := start; i < end; i++ {
			if b[i] != '\n' && b[i] != '\r' {
				b[i] = ' '
			}
		}
	}
	fence := byte(0)
	width := 0
	for start := 0; start < len(b); {
		end := strings.IndexByte(body[start:], '\n')
		if end < 0 {
			end = len(b)
		} else {
			end += start + 1
		}
		line := strings.TrimLeft(body[start:end], " ")
		indent := len(body[start:end]) - len(line)
		n := 0
		if len(line) > 0 && (line[0] == '`' || line[0] == '~') {
			for n < len(line) && line[n] == line[0] {
				n++
			}
		}
		if fence != 0 {
			mask(start, end)
			if indent <= 3 && n >= width && line[0] == fence && strings.TrimSpace(line[n:]) == "" {
				fence = 0
			}
		} else if indent <= 3 && n >= 3 {
			fence = line[0]
			width = n
			mask(start, end)
		}
		start = end
	}
	for i := 0; i < len(b); {
		if b[i] == '\\' && i+1 < len(b) {
			mask(i, i+2)
			i += 2
			continue
		}
		if b[i] != '`' {
			i++
			continue
		}
		n := 1
		for i+n < len(b) && b[i+n] == '`' {
			n++
		}
		end := -1
		for j := i + n; j < len(b); {
			if b[j] != '`' {
				j++
				continue
			}
			k := 1
			for j+k < len(b) && b[j+k] == '`' {
				k++
			}
			if k == n {
				end = j + k
				break
			}
			j += k
		}
		if end >= 0 {
			mask(i, end)
			i = end
		} else {
			i += n
		}
	}
	return string(b)
}

var referenceDestination = regexp.MustCompile(`(?m)(?:\]\(\s*<?|^ {0,3}\[[^\]\n]+\]:\s*<?)((?:source|space|page):[^\s<>)]*)`)
var sourceReference = regexp.MustCompile(`^source:([a-z0-9]{15})$`)
var spaceReference = regexp.MustCompile(`^space:([a-z0-9]{15})/([a-z0-9]+(?:-[a-z0-9]+)*)(?:#[^\s<>]*)?$`)

var pageReference = regexp.MustCompile(`^page:([a-z0-9]+(?:-[a-z0-9]+)*)(?:#[^\s<>]*)?$`)

type navigationReference struct {
	kind, id, destination string
	valid                 bool
}

func bodyReferences(body string) []navigationReference {
	var out []navigationReference
	for _, m := range referenceDestination.FindAllStringSubmatch(referenceText(body), -1) {
		ref := navigationReference{destination: m[1]}
		if strings.HasPrefix(m[1], "source:") {
			ref.kind = "source"
			if x := sourceReference.FindStringSubmatch(m[1]); x != nil {
				ref.id = x[1]
				ref.valid = true
			}
		} else if strings.HasPrefix(m[1], "page:") {
			ref.kind = "page"
			if x := pageReference.FindStringSubmatch(m[1]); x != nil && len(x[1]) <= 150 {
				ref.id = x[1]
				ref.valid = true
			}
		} else {
			ref.kind = "space"
			if x := spaceReference.FindStringSubmatch(m[1]); x != nil && len(x[2]) <= 150 {
				ref.id = x[1]
				ref.valid = true
			}
		}
		out = append(out, ref)
	}
	return out
}
