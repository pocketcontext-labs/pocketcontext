package client

import (
	"reflect"
	"testing"
)

func TestLiteralMarkdownReferences(t *testing.T) {
	body := "[[real]] [^1] `[[inline]] [^2]`\n```md\n[[fenced]] [^3]\n```\n~~~\n[[tilde]]\n~~~\n\\[[escaped]]\n"
	if got := bodyLinks(body); !reflect.DeepEqual(got, []string{"real"}) {
		t.Fatal(got)
	}
	if got := bodyMarkers(body); !reflect.DeepEqual(got, []string{"1"}) {
		t.Fatal(got)
	}
	if got := renumber("`[^1]` [^1]", 2); got != "`[^1]` [^3]" {
		t.Fatal(got)
	}
	if got := bodyMarkers("Ordinary.[^import-1]\n[^import-1]: Source"); len(got) != 0 {
		t.Fatal(got)
	}
}

func TestNavigationReferences(t *testing.T) {
	body := "![Diagram](source:aaaaaaaaaaaaaaa \"600\") [Other](space:bbbbbbbbbbbbbbb/overview#A%20heading)\n[^import-1]: [Document](source:ccccccccccccccc)\n`[literal](source:bad)`\n[bad](source:bad) [bad](space:bad/overview)"
	refs := bodyReferences(body)
	if len(refs) != 5 {
		t.Fatalf("%+v", refs)
	}
	for i := 0; i < 3; i++ {
		if !refs[i].valid {
			t.Fatalf("%+v", refs[i])
		}
	}
	for i := 3; i < 5; i++ {
		if refs[i].valid {
			t.Fatalf("%+v", refs[i])
		}
	}
}

func TestFormattedPageReferences(t *testing.T) {
	body := "[BERT's `[CLS]`/`[SEP]` (token) scheme](page:bert-input#Token%20scheme)\n[Multiline\nlabel](page:other) [[other|Again]] `[literal](page:missing)`"
	if got := bodyLinks(body); !reflect.DeepEqual(got, []string{"other", "bert-input"}) {
		t.Fatal(got)
	}
	refs := bodyReferences("[bad](page:../outside) [bad](page:Bad) [good](page:valid)")
	if len(refs) != 3 || refs[0].valid || refs[1].valid || !refs[2].valid {
		t.Fatal(refs)
	}
}
