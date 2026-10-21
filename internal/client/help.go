package client

import (
	"fmt"
	"strings"
)

// helpEntry is the text of `help COMMAND` and `COMMAND --help`.
type helpEntry struct{ usage, text, example string }

// commandHelp has one entry for every command in the dispatch table of run
// and for the commands handled before it (help, version, newid).
var commandHelp = map[string]helpEntry{
	"help": {"help [COMMAND]",
		"Print the command overview, or the usage, description and an example of one command. `COMMAND --help` does the same.",
		"pocketcontext help batch"},
	"version": {"version", "Print the version and commit of this binary.", "pocketcontext version"},
	"newid": {"newid",
		"Print a new random 15-character record ID. Use it to choose IDs before a `batch`, so later entries can refer to earlier ones.",
		"pocketcontext newid"},

	"init": {"init --email EMAIL [--name NAME] [--port N] [--password-stdin]",
		"Create the project (database, storage/ and pocketcontext.json) and the local account, then start the server. An existing account keeps its password unless --password-stdin is given.",
		"printf '%s\\n' \"$PASSWORD\" | pocketcontext init --email you@example.localhost --password-stdin"},
	"ensure-running": {"ensure-running [--take-over]",
		"Start the server in the background unless it already runs for this database (alias: start). --take-over ignores a lease from another computer; use it only when that computer is off.",
		"pocketcontext ensure-running"},
	"start": {"start [--take-over]", "Alias of ensure-running.", "pocketcontext start"},
	"serve": {"serve [--take-over]", "Run the server in the foreground until interrupted.", "pocketcontext serve"},
	"stop":  {"stop", "Write the database back to the synced folder and stop the server. Run it before switching computers.", "pocketcontext stop"},
	"status": {"status",
		"Show paths, port, lease, write-back conflicts and whether the server runs. With --url: whether the server answers and who is signed in.",
		"pocketcontext status"},
	"open": {"open [--email EMAIL] [--no-browser]",
		"Open the reader signed in through a single-use link valid for 2 minutes. --email signs in as that account, e.g. to open the printed link on a computer that uses --url.",
		"pocketcontext open --email user@example.localhost --no-browser"},
	"flush": {"flush", "Write the database back to the synced folder now.", "pocketcontext flush"},
	"recover": {"recover --keep local|synced",
		"Resolve unsaved local changes when the synced database also changed elsewhere: keep this computer's copy or the synced one. The other copy is kept beside it.",
		"pocketcontext recover --keep synced"},
	"password": {"password [--password-stdin]", "Change the reader password of the local account.", "pocketcontext password"},
	"account": {"account --email EMAIL [--name NAME] [--password-stdin]",
		"Create another account on this server, e.g. for a person using it with --url. Without --password-stdin it never prompts: a new account gets a random password nobody knows and an existing one keeps its password.",
		"pocketcontext account --email user@example.localhost --name User"},
	"login-code": {"login-code --email EMAIL [--ttl SECONDS]",
		"Print a one-time sign-in code for that account (single use, kept in server memory only, default 600 seconds, 30-600) for `login --url URL --code-stdin`.",
		"pocketcontext login-code --email user@example.localhost"},
	"skill": {"skill [--agent claude-code|codex|antigravity|all] [--dir DIR]",
		"Install the agent skill with this computer's binary path and database (or, with --url, the remote server). Agents whose configuration folder is missing are skipped.",
		"pocketcontext skill --agent claude-code"},
	"login": {"login --url URL (--code-stdin | --email EMAIL [--password-stdin])",
		"Sign in to a forwarded server, with a one-time code from `login-code` read from standard input, or with a password. Only a token is stored, in the private cache.",
		"printf '%s\\n' \"$CODE\" | pocketcontext login --url http://127.0.0.1:8096 --code-stdin"},
	"logout": {"logout --url URL", "Forget the stored session for that server.", "pocketcontext logout --url http://127.0.0.1:8096"},

	"whoami":                {"whoami", "Show the signed-in account, the server URL and the selected space.", "pocketcontext whoami"},
	"spaces":                {"spaces", "List the spaces you belong to, your role in each and which one is selected (--space ID selects another).", "pocketcontext spaces"},
	"create-personal-space": {"create-personal-space", "Create your private personal space, or return it if it exists.", "pocketcontext create-personal-space"},
	"check":                 {"check", "Compare the live schema with the reference schema shipped in this binary; exit 3 on differences.", "pocketcontext check"},
	"schema":                {"schema", "Print the live SQL-readable schema: tables, columns and types.", "pocketcontext schema"},
	"query": {"query SQL|-",
		"Run one read-only SELECT (alias: sql). Results are bounded: when `truncated` is true, select fewer columns or page with ORDER BY and LIMIT/OFFSET. `-` reads the query from standard input.",
		"pocketcontext query \"SELECT id, slug FROM pages ORDER BY id LIMIT 20\""},
	"sql": {"sql SQL|-", "Alias of query.", "pocketcontext sql \"SELECT count(*) FROM passages\""},
	"get": {"get COLLECTION ID", "Read one record of an SQL-readable table by ID.", "pocketcontext get ingestion_runs RUN_ID_________"},
	"create": {"create COLLECTION JSON|-",
		"Create one record through the records API. sources, ingestion_runs and pages default to the selected space. `-` reads the JSON body from standard input.",
		"pocketcontext create pages '{\"slug\":\"example-concept\",\"kind\":\"concept\"}'"},
	"update": {"update COLLECTION ID JSON|-",
		"Change fields of one record. The body must carry expected_revision from your last read; a stale revision fails with exit 4.",
		"pocketcontext update ingestion_runs RUN_ID_________ '{\"status\":\"cancelled\",\"expected_revision\":2}'"},
	"batch": {"batch JSON|-",
		"Send up to 20 writes in one transaction: all succeed or none. The input is a JSON array of requests\n\n" +
			"  [{\"method\": \"POST\" | \"PATCH\", \"url\": \"/api/collections/COLLECTION/records[/ID]\", \"body\": {...}}, ...]\n\n" +
			"COLLECTION is one of sources, renditions, passages, ingestion_runs, pages, page_revisions, " +
			"citations, page_links. POST creates a record (the URL has no ID; put a chosen ID from `newid` " +
			"in the body as \"id\" so later entries can refer to it). PATCH changes the record named in the " +
			"URL and needs expected_revision in the body. sources, ingestion_runs and pages default to the " +
			"selected space. `-` reads the array from standard input. The output lists one {\"status\", \"body\"} " +
			"response per request, in order.",
		"pocketcontext batch - <<'EOF'\n" +
			"  [{\"method\":\"POST\",\"url\":\"/api/collections/pages/records\",\"body\":{\"id\":\"pageid000000001\",\"slug\":\"plan-mode\",\"kind\":\"concept\"}},\n" +
			"   {\"method\":\"POST\",\"url\":\"/api/collections/page_revisions/records\",\"body\":{\"id\":\"revid0000000001\",\"run\":\"RUN_ID_________\",\"page\":\"pageid000000001\",\"base_revision\":\"\",\"title\":\"Plan mode\",\"summary\":\"...\",\"body\":\"Text.[^1]\"}},\n" +
			"   {\"method\":\"POST\",\"url\":\"/api/collections/citations/records\",\"body\":{\"page_revision\":\"revid0000000001\",\"passage\":\"PASSAGE_ID_____\",\"marker\":\"1\"}}]\n" +
			"  EOF"},
	"ingest": {"ingest PATH [--title T] [--date D] [--version V]",
		"Store a UTF-8 text note as an immutable original and extract passages; it does not synthesize or publish. Markdown front matter supplies the title (`title:`) and the source date (`published:`, else `date:`); --title and --date override it. Passages follow headings and paragraphs and are labelled with heading path and line range; a passage under 200 characters, such as a lone link after the front matter, joins the next passage of the same or a deeper heading (else the previous one), and its locator covers both. Repeating the command deduplicates by content and resumes an interrupted extraction; without --version an existing rendition is reused (v3, else v2, else the latest). Earlier extractions keep their renditions: v1 (fixed 24,000-character passages) and v2 (tiny passages kept apart); --version v3 adds a current one.",
		"pocketcontext ingest notes/episode.md --date 2026-06-15"},
	"passages": {"passages SOURCE_ID [--version V] [--out FILE]",
		"Print the passages of one source as plain text in ordinal order, each after a header line `=== ORDINAL · PASSAGE_ID · LOCATOR` (for example `=== 3 · PASSAGE_ID · # Episode > ## Transcript; lines 124-148`), with a blank line between passages and LF line endings. It reads the rendition ingest reuses (v3, else v2, else the newest) unless --version names one, through bounded SQL pages, so nothing is truncated. With --out FILE it writes the text there (UTF-8) and prints {\"source\", \"rendition\", \"version\", \"passages\", \"file\"} instead. Takes a source ID, not a title: `ingest` prints it as `source`, and `pocketcontext sql \"SELECT id, title FROM sources ORDER BY created DESC LIMIT 20\"` lists them.",
		"pocketcontext passages SOURCE_ID______ --out episode-passages.txt"},
	"search": {"search TERMS [--limit N] [--offset N --generation G --publication ID] [--sequence N]",
		"Rank published pages of the latest (or the given) publication by full-text match of title, summary and body. 1-16 terms. To page, pass the returned publication and generation with --offset; a generation conflict (exit 4) means restart at offset 0.",
		"pocketcontext search \"espresso descaling\" --limit 10"},
	"lint": {"lint",
		"Check the latest publication and print findings. Structure: broken-link, orphan (no incoming links), no-citations, needs-verification, missing-property-citation, invalid-property-target. Editorial hints: unlinked-mention (a page names another page's title, or its slug words, without linking it; whole words, case-insensitive, titles of two or more words or one word of 6+ characters, code ignored), missing-page (a term on 3+ pages with no page of that title or slug: **bold** text except field labels such as **Video:** opening a line or list item, Markdown link text, or a capitalized name in prose such as a run of title-case words or a single word not opening a sentence, product-like tokens such as OpenCode or GPT-5.5 included; names skip weekdays, months, pronouns and other common words, words written in lowercase elsewhere, and names that are whole words of a page title or slug with punctuation removed, so Anysphere is part of \"Cursor (Anysphere)\"; code, [[page]] links and headings ignored; reported with `term`, the most frequent spelling, and `pages`), stub (under 80 words of prose or exactly one citation; entity pages with a catalog_type excluded).",
		"pocketcontext lint"},
	"stage": {"stage SPEC|- [--dry-run]",
		"Stage page revisions for one ingestion run from a JSON spec: creates missing page identities, sets base_revision from the latest publication, creates citations and the page_links derived from [[slug]] links and relationship properties, and resumes a run with the same run_key (pages already staged are skipped). Everything is validated before the first write; writes go through the batch API. With --dry-run nothing is written (exit 0 when clean); when checks fail nothing is written and it exits 3 with every problem. Prints {\"run\", \"revision\", \"staged\", \"skipped\", \"problems\"}. Spec:\n\n" +
			"  {\"run_key\": \"stable-key\", \"description\": \"...\", \"sources\": [\"SOURCE_ID\"], \"home\": \"slug\",\n" +
			"   \"pages\": [{\"slug\": \"plan-mode\", \"kind\": \"concept\", \"title\": \"...\", \"summary\": \"...\",\n" +
			"              \"body\": \"... [^1] ... [[other-page]]\", \"citations\": {\"1\": \"PASSAGE_ID\"},\n" +
			"              \"properties\": {}, \"property_evidence\": {}, \"archived\": false},\n" +
			"             {\"slug\": \"existing-page\", \"edits\": [{\"old\": \"exact published text\", \"new\": \"replacement [^1]\"}],\n" +
			"              \"append\": \"text with local markers [^2]\", \"citations\": {\"1\": \"PASSAGE_ID\", \"2\": \"PASSAGE_ID\"}}]}\n\n" +
			"A page without `body` changes its published revision: `edits` are applied in order, each `old` matched against the published body as earlier edits left it and required to occur exactly once (\"new\": \"\" deletes it), then `append` adds text at the end. Markers in `new` and `append` are local and share one numbering: [^k] there means citations[k] and is renumbered after the highest existing marker (property_evidence uses the renumbered markers). Published markers outside `old` keep their numbers; a published marker that no longer appears in the body, and is not named by property_evidence, loses its citation. Fields not given are copied from the published revision. Relationship properties may only name pages that already exist; [[slug]] links may name pages staged in the same spec. Then run check-run and publish.",
		"pocketcontext stage batch-01.json --dry-run"},
	"check-run": {"check-run RUN_ID",
		"Report every problem that would stop the run from publishing, for all its pages at once: missing or unused citation markers, footnote definitions in a body, uncited text without [needs verification], [[slug]] links without page_links records, link targets not published in the resulting manifest, stale base revisions and property rules. Prints {\"run\", \"ok\", \"problems\": [{\"page\", \"kind\", \"detail\"}]}; exit 3 when not ok.",
		"pocketcontext check-run RUN_ID_________"},
	"page": {"page SLUG [--publication ID] [--sequence N]",
		"Print a published page (latest publication, or the given one) as one stage spec page object, with citations as marker to passage ID, ready to edit and pass to `stage`. For a targeted change, copy exact text from its body into `edits` of a spec page instead (see `stage --help`).",
		"pocketcontext page plan-mode > plan-mode.json"},
	"stage-home": {"stage-home RUN_ID --expected-revision N (--home SLUG | --clear-home) [--home-base ID]",
		"Record the reader home page choice on a staging run. The expected current home is captured from the latest publication unless --home-base gives it (use '' for none).",
		"pocketcontext stage-home RUN_ID_________ --home overview --expected-revision 1"},
	"publish": {"publish RUN_ID --expected-revision N [--home SLUG | --clear-home --home-base ID]",
		"Publish a staging run atomically after the server's integrity checks; the first problem refuses the publication (run check-run first to see all). A stale revision or a concurrent change fails with exit 4: re-read and reassess, never retry blindly.",
		"pocketcontext publish RUN_ID_________ --expected-revision 3"},
}

// printHelp prints the help of one command, or the overview for "".
func printHelp(command string) error {
	if command == "" {
		fmt.Print(Usage)
		return nil
	}
	h, ok := commandHelp[command]
	if !ok {
		return fail(2, "unknown command %q; run `pocketcontext help`", command)
	}
	fmt.Printf("usage: pocketcontext %s\n\n%s\n\nExample:\n  %s\n", h.usage, wrap(h.text, 78), h.example)
	if command != "help" && command != "version" && command != "newid" {
		fmt.Println("\nOptions for every command: --db PATH or --url URL, --space ID, --pretty.")
	}
	return nil
}

// wrap folds each one-line paragraph at width; indented blocks stay as written.
func wrap(text string, width int) string {
	paragraphs := strings.Split(text, "\n\n")
	for i, p := range paragraphs {
		if strings.HasPrefix(p, " ") || strings.Contains(p, "\n") {
			continue
		}
		var lines []string
		line := ""
		for _, word := range strings.Fields(p) {
			if line != "" && len(line)+1+len(word) > width {
				lines, line = append(lines, line), ""
			}
			if line != "" {
				line += " "
			}
			line += word
		}
		paragraphs[i] = strings.Join(append(lines, line), "\n")
	}
	return strings.Join(paragraphs, "\n\n")
}

// wantsHelp reports whether the arguments ask for help (before any "--").
func wantsHelp(argv []string) bool {
	for _, arg := range argv {
		if arg == "--" {
			return false
		}
		if arg == "--help" || arg == "-h" {
			return true
		}
	}
	return false
}

// helpTopic returns the command named after `help`, skipping global options.
func helpTopic(rest []string) (string, error) {
	a, err := parseArgs(rest, nil, nil)
	if err != nil {
		return "", err
	}
	if len(a.pos) > 1 {
		return "", fail(2, "usage: pocketcontext help [COMMAND]")
	}
	if len(a.pos) == 0 {
		return "", nil
	}
	return strings.TrimSpace(a.pos[0]), nil
}
