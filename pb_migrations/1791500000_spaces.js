// Spaces partition every domain record. Active membership of a record's space is
// the only read path; owner/editor membership is required for writes.
// Existing shared knowledge retains its IDs and history in the company space.
migrate(app => {
  const domain = ['sources', 'renditions', 'passages', 'ingestion_runs', 'pages', 'page_revisions',
    'citations', 'page_links', 'publications', 'audit_log'];
  // Shared FTS indexes every space together; private search derives per-requester data instead.
  try { app.delete(app.findCollectionByNameOrId('search_state')); } catch (_) {}
  app.db().newQuery('DROP TABLE IF EXISTS published_pages_fts').execute();

  const users = app.findCollectionByNameOrId('users');
  const authed = "@request.auth.id != '' && @request.auth.collectionName = 'users' && @request.auth.disabled = false";
  // One shared @collection join keeps every condition on the same membership row.
  const member = field => authed + ` && @collection.space_members.space ?= ${field} && @collection.space_members.account ?= @request.auth.id && @collection.space_members.active ?= true`;
  const stamps = [
    {name: 'created_by', type: 'relation', collectionId: users.id, maxSelect: 1, cascadeDelete: false},
    {name: 'updated_by', type: 'relation', collectionId: users.id, maxSelect: 1, cascadeDelete: false},
    {name: 'revision', type: 'number', required: true, min: 1, onlyInt: true},
    {name: 'created', type: 'autodate', onCreate: true},
    {name: 'updated', type: 'autodate', onCreate: true, onUpdate: true},
  ];
  app.save(new Collection({name: 'spaces', type: 'base', listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    fields: [
      {name: 'kind', type: 'select', values: ['personal', 'group'], maxSelect: 1, required: true},
      {name: 'name', type: 'text', required: true, max: 200},
    ].concat(stamps),
    indexes: ["CREATE UNIQUE INDEX idx_personal_space ON spaces(created_by) WHERE kind = 'personal'"]}));
  const spaces = app.findCollectionByNameOrId('spaces');
  app.save(new Collection({name: 'space_members', type: 'base', listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    fields: [
      {name: 'space', type: 'relation', collectionId: spaces.id, maxSelect: 1, required: true, cascadeDelete: false},
      {name: 'account', type: 'relation', collectionId: users.id, maxSelect: 1, required: true, cascadeDelete: false},
      {name: 'role', type: 'select', values: ['owner', 'editor', 'reader'], maxSelect: 1, required: true},
      {name: 'active', type: 'bool'},
    ].concat(stamps),
    indexes: ['CREATE UNIQUE INDEX idx_space_member ON space_members(space, account)',
      'CREATE INDEX idx_space_member_account ON space_members(account, active)']}));
  const members = app.findCollectionByNameOrId('space_members');
  const company = new Record(spaces);
  company.set('id', 'companyspace001');
  company.set('kind', 'group');
  company.set('name', 'Company');
  company.set('revision', 1);
  app.save(company);
  // No owner is inferred: company membership remains operator-managed.
  for (const user of app.findAllRecords('users')) {
    const row = new Record(members);
    row.set('space', company.id);
    row.set('account', user.id);
    row.set('role', 'editor');
    row.set('active', !user.getBool('disabled'));
    row.set('revision', 1);
    app.save(row);
  }

  // Creation and membership changes are trusted server operations in this phase.
  spaces.listRule = spaces.viewRule = member('id');
  app.save(spaces);
  members.listRule = members.viewRule = member('space');
  app.save(members);

  const unique = {
    sources: ["CREATE UNIQUE INDEX idx_source_hash ON sources(space, sha256) WHERE sha256 != ''"],
    ingestion_runs: ['CREATE UNIQUE INDEX idx_run_key ON ingestion_runs(space, key)'],
    pages: ['CREATE UNIQUE INDEX idx_page_slug ON pages(space, slug)'],
    publications: ['CREATE UNIQUE INDEX idx_publication_seq ON publications(space, sequence)'],
  };
  for (const name of domain) {
    const collection = app.findCollectionByNameOrId(name);
    collection.fields.add(new RelationField({name: 'space', collectionId: spaces.id, maxSelect: 1, required: false, cascadeDelete: false}));
    const replaced = (unique[name] || []).map(sql => sql.split(' ')[3]);
    collection.indexes = collection.indexes.filter(sql => !replaced.some(index => sql.includes(' ' + index + ' ')))
      .concat(unique[name] || [], [`CREATE INDEX idx_${name}_space ON ${name}(space)`]);
    collection.listRule = collection.viewRule = member('space');
    if (!['publications', 'audit_log'].includes(name)) {
      // Hooks verify the request's or parent's space and the member's role before saving.
      collection.createRule = authed;
      collection.updateRule = member('space');
    }
    if (name === 'audit_log') {
      const actorType = collection.fields.getByName('actor_type');
      actorType.values = ['user', 'superuser', 'system'];
    }
    app.save(collection);
    // Schema metadata backfill only: preserve all original columns, including
    // immutable timestamps and audit history, without invoking business hooks.
    app.db().newQuery('UPDATE ' + name + ' SET space = {:space}').bind({space: company.id}).execute();
    collection.fields.getByName('space').required = true;
    app.save(collection);
  }
  // Directory labels are SQL-only, filtered to the requester and co-members.
  const directory = app.findCollectionByNameOrId('user_directory');
  directory.listRule = null;
  directory.viewRule = null;
  app.save(directory);
}, () => { throw new Error('Restore a verified complete backup for rollback'); });
