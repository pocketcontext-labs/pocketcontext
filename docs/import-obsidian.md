# Import an Obsidian vault

`scripts/import_obsidian.py` migrates a vault whose top-level collections each
have a `raw/` directory and an existing Markdown page directory. It is an
optional Python 3.10+ migration tool, not a runtime dependency of the binary.
The source vault stays unchanged. For agent decisions about mapping, omitted
authored directories, and unresolved targets, see the bundled
[migration skill reference](../skills/pocketcontext/references/obsidian-import.md).

Each collection becomes one space. `_master`, `_template`, hidden directories,
and operating instructions outside the content directories are excluded.
Original files in `raw/` become immutable sources; Markdown content becomes
`legacy` pages; other files beside the pages become sources. The root
`index.md` becomes the space's home and `log.md` becomes a historical operations
page. Stable slugs include nested paths and resolve collisions deterministically.

## Audit first

The default is an offline audit, with no server connection or domain writes:

```sh
python3 scripts/import_obsidian.py /absolute/path/to/vault \
  --report /absolute/path/to/work/audit.json
```

Use `--collection NAME` to select one collection; repeat it for several. The
report includes source/page counts, link counts, destination spaces, and every
unresolved or unsupported reference. Empty files are reported and skipped,
because the server refuses empty originals. Oversized files, Git LFS pointers,
and invalid UTF-8 text originals are also reported and skipped. Symlink files
are refused. Missing original files are never reconstructed from page prose.

Keep reports and import state outside both the vault and the code repository:
they contain private filenames and source identifiers. The importer refuses
paths inside those repositories.

## Apply to a development project

Build the current binary, initialize a separate project, and start the normal
development launcher as described in the README. Use the same explicit database
path for initialization, the launcher, and import. The importer uses only the
binary's authenticated CLI; it never opens the database or storage directory.

```sh
python3 scripts/import_obsidian.py /absolute/path/to/vault \
  --collection example \
  --apply \
  --binary /absolute/path/to/pocketcontext/bin/pocketcontext \
  --db /absolute/path/to/dev/pocketcontext.db \
  --state /absolute/path/to/work/import-state.json \
  --report /absolute/path/to/work/import-report.json
```

Omit `--collection` to import every collection. A selected collection's explicit
cross-space destinations also have their spaces created, but their content is
not imported until selected. Each collection publishes atomically in its own
run. A failure in one collection does not undo already published collections;
rerun the identical command to continue.

The importer creates a staging run before page identities, preserving recovery
from interruption during the first staging batch. The run key identifies the
vault path, collection, and content snapshot. Original uploads deduplicate by
server hash. A private, atomically replaced state file records source IDs,
space IDs, snapshot hashes, and run IDs; an OS file lock prevents simultaneous
use of the same state file.

An identical rerun does not republish completed collections. It verifies their
imported revisions are still selected by the latest publication. Changed inputs,
manually revised imported pages, cancelled runs, and unrelated nonempty spaces
stop the importer for review. This is a resumable snapshot migration, not a
continuous synchronization service. It does not overwrite later agent work.

## Reference conversion

Local bracket links resolve within their originating collection, using explicit
paths first and unique local filenames second. Bare names never fall back to
another collection. Extensionless references prefer a Markdown page over a raw
original with the same stem. Labels and heading fragments are preserved.
Explicit paths to another collection become cross-space navigation links.
Multiline labels retain their text with whitespace normalized; labels containing
inline code or brackets use the equivalent `page:` Markdown-link form.

The reader formats are:

```markdown
[[local-page|Label]]
[[local-page#Heading|Label]]
[Label with `inline code`](page:local-page#Heading)
[Original document](source:SOURCE_ID)
![Diagram](source:SOURCE_ID "size=640x480")
[Another collection](space:SPACE_ID/page-slug#Heading)
```

IDs above are placeholders; the importer uses actual returned IDs. Source links
are local to a space. Images are protected raster sources; display needs no OCR
or text extraction. A numeric image alias becomes a size hint. Ordinary image
titles remain captions. Non-image embeds become source links; page transclusions
become page links and are reported as unsupported transclusions. Block anchors
and source-specific fragments are reported and reduced to a link to the page or
original. Missing targets remain visible as unresolved imported references, with
the original target recorded in the report.

Code spans, fenced blocks, and indented code remain literal. Imported footnotes
are renamed to `import-N` labels, preserving their definitions and document
references separately from numbered passage citations. Every imported page
carries an explicit `[needs verification]` notice and provenance properties
(`import_format`, `original_path`, `original_sha256`). Preserving a reference
never asserts that a passage supports the associated claim.

Cross-space links navigate to the destination's current publication. They do not
couple publication manifests, enable cross-space evidence citations, or authorize
an agent to edit another space. Agent isolation is a workflow convention;
spaces are partitions within one user's project.

Non-text originals remain stored without extracted text until a separate agent
conversion uses `extract`. The import report describes a completed migration,
not completed evidence extraction or claim verification.

## Verification

```sh
python3 tests/obsidian_import_test.py
python3 tests/obsidian_import_e2e.py --binary bin/pocketcontext
```

Both checks use synthetic data. The first covers link resolution, code
preservation, footnotes, collisions, missing files, interrupted staging and
resume safety. The second initializes a temporary real project, imports sources
and pages, validates publication and source counts, reruns without duplication,
and verifies that a manual page revision prevents overwrite.
