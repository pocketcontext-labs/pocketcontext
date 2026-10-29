// The initial schema of a single-user project. One hidden account signs in;
// spaces only partition knowledge. Every domain record belongs to one space,
// evidence and page revisions are immutable, and publications and the audit
// log are written by the hooks only. Databases created by earlier releases are
// refused before any migration runs (internal/bundle/legacy.go).
migrate(app => {
  const authed = "@request.auth.id != '' && @request.auth.collectionName = 'users'";

  // The built-in auth collection holds exactly one account (pb_hooks/account_access.js).
  // It is never readable through SQL and no one can list, create or change it over REST.
  const users = app.findCollectionByNameOrId('users');
  users.listRule = null;
  users.viewRule = "id = @request.auth.id";
  users.createRule = null;
  users.updateRule = null;
  users.deleteRule = null;
  users.manageRule = null;
  users.authRule = '';
  users.passwordAuth = {enabled: true, identityFields: ['email']};
  users.oauth2.enabled = false;
  users.otp.enabled = false;
  users.mfa.enabled = false;
  users.authToken.duration = 604800;
  users.authAlert.enabled = false;
  app.save(users);

  const text = (name, required = false, max = 2000) => ({name, type: 'text', required, max});
  const choice = (name, values) => ({name, type: 'select', values, maxSelect: 1, required: true});
  const revision = {name: 'revision', type: 'number', required: true, min: 1, onlyInt: true};
  const created = {name: 'created', type: 'autodate', onCreate: true};
  const updated = {name: 'updated', type: 'autodate', onCreate: true, onUpdate: true};

  // Spaces are created, renamed, archived and restored through pb_hooks/spaces.js.
  app.save(new Collection({name: 'spaces', type: 'base',
    listRule: authed, viewRule: authed, createRule: authed, updateRule: authed, deleteRule: null,
    fields: [text('name', true, 200), {name: 'archived', type: 'bool'}, revision, created, updated]}));
  const spaces = app.findCollectionByNameOrId('spaces');
  const rel = (name, table, required = true) => ({name, type: 'relation', collectionId: app.findCollectionByNameOrId(table).id,
    maxSelect: 1, required, cascadeDelete: false});

  // One row: the space that root records and clients use when none is named.
  app.save(new Collection({name: 'settings', type: 'base',
    listRule: authed, viewRule: authed, createRule: null, updateRule: authed, deleteRule: null,
    fields: [rel('default_space', 'spaces'), revision, created, updated]}));

  const space = new Record(spaces);
  space.set('name', 'Default');
  space.set('revision', 1);
  app.save(space);
  const settings = new Record(app.findCollectionByNameOrId('settings'));
  settings.set('id', 'projectsettings');
  settings.set('default_space', space.id);
  settings.set('revision', 1);
  app.save(settings);

  // Domain collections. Writable ones are checked by pb_hooks/integrity.js
  // (same-space references, archived spaces, immutability, revisions);
  // publications and audit_log are server-owned.
  function create(name, fields, indexes, writable) {
    app.save(new Collection({name, type: 'base',
      listRule: authed, viewRule: authed,
      createRule: writable ? authed : null, updateRule: writable ? authed : null, deleteRule: null,
      fields: [rel('space', 'spaces')].concat(fields, writable ? [revision, created, updated] : [created]),
      indexes: indexes.concat([`CREATE INDEX idx_${name}_space ON ${name}(space)`])}));
  }
  create('sources', [text('title', true, 500), text('original_name', true, 500), text('media_type', true, 100),
    text('source_date', false, 100), text('sha256', false, 64), text('supersedes', false, 15),
    {name: 'original', type: 'file', maxSelect: 1, maxSize: 104857600, protected: true, required: true}],
  ["CREATE UNIQUE INDEX idx_source_hash ON sources(space, sha256) WHERE sha256 != ''"], true);
  create('renditions', [rel('source', 'sources'), text('kind', true, 100), text('processor', true, 300),
    text('version_label', true, 100), text('notes', false, 10000)],
  ['CREATE UNIQUE INDEX idx_rendition ON renditions(source, kind, version_label)'], true);
  create('passages', [rel('rendition', 'renditions'), {name: 'ordinal', type: 'number', required: true, min: 1, onlyInt: true},
    text('locator', true, 500), text('body', true, 30000)],
  ['CREATE UNIQUE INDEX idx_passage ON passages(rendition, ordinal)'], true);
  create('pages', [{name: 'slug', type: 'text', required: true, max: 150, pattern: '^[a-z0-9]+(-[a-z0-9]+)*$'},
    choice('kind', ['summary', 'concept', 'entity', 'transcript', 'answer', 'legacy'])],
  ['CREATE UNIQUE INDEX idx_page_slug ON pages(space, slug)'], true);
  create('ingestion_runs', [text('key', true, 100), choice('status', ['staging', 'published', 'cancelled']),
    text('description', true, 2000),
    {name: 'sources', type: 'relation', collectionId: app.findCollectionByNameOrId('sources').id, maxSelect: 100, cascadeDelete: false},
    text('issue', false, 10000), rel('home', 'pages', false),
    {name: 'home_base', type: 'text', max: 15, pattern: '^([a-z0-9]{15})?$'}, {name: 'clear_home', type: 'bool'}],
  ['CREATE UNIQUE INDEX idx_run_key ON ingestion_runs(space, key)'], true);
  create('page_revisions', [rel('run', 'ingestion_runs'), rel('page', 'pages'), text('base_revision', false, 15),
    text('title', true, 500), text('summary', true, 2000), text('body', true, 100000), {name: 'archived', type: 'bool'},
    {name: 'properties', type: 'json', maxSize: 65536}, {name: 'property_evidence', type: 'json', maxSize: 16384}],
  ['CREATE UNIQUE INDEX idx_run_page ON page_revisions(run, page)'], true);
  create('citations', [rel('page_revision', 'page_revisions'), rel('passage', 'passages'),
    {name: 'marker', type: 'text', required: true, max: 8, pattern: '^[1-9][0-9]*$'}, text('note', false, 2000)],
  ['CREATE UNIQUE INDEX idx_citation_marker ON citations(page_revision, marker)'], true);
  create('page_links', [rel('page_revision', 'page_revisions'), rel('target', 'pages')],
    ['CREATE UNIQUE INDEX idx_page_link ON page_links(page_revision, target)'], true);
  create('publications', [rel('run', 'ingestion_runs'), {name: 'sequence', type: 'number', required: true, min: 1, onlyInt: true},
    {name: 'manifest', type: 'json', required: true, maxSize: 8388608}, rel('home', 'pages', false)],
  ['CREATE UNIQUE INDEX idx_publication_seq ON publications(space, sequence)', 'CREATE UNIQUE INDEX idx_publication_run ON publications(run)'], false);
  create('audit_log', [choice('action', ['create', 'update']), text('collection', true), text('record', true),
    {name: 'changes', type: 'json', maxSize: 5242880}],
  ['CREATE INDEX idx_audit_record ON audit_log(collection, record, created)'], false);

  const config = app.settings();
  config.batch.enabled = true;
  config.batch.maxRequests = 20;
  config.batch.timeout = 5;
  app.save(config);
}, () => { throw new Error('Restore a verified complete backup for rollback'); });
