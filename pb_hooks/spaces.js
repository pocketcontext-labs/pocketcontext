// Spaces partition knowledge for the project's one account. They are created,
// renamed, archived and restored here; the settings row names the default
// space, which cannot be archived. Every change is revision-checked and audited.
const SETTINGS = 'projectsettings';

function missing() { throw new NotFoundError('The requested resource wasn\'t found.'); }
function invalid(message) { throw new BadRequestError(message); }

// Returns the space; write refuses an archived one.
function requireSpace(app, space, write) {
  if (typeof space !== 'string' || !/^[a-z0-9]{15}$/.test(space)) missing();
  let record;
  try { record = app.findRecordById('spaces', space); } catch (_) { missing(); }
  if (write && record.getBool('archived')) throw new ForbiddenError('Restore this archived space before making changes.');
  return record;
}

function settings(app) { return app.findRecordById('settings', SETTINGS); }
function defaultSpace(app) { return app.findRecordById('spaces', settings(app).getString('default_space')); }

function audit(app, space, record, action, changes) {
  const row = new Record(app.findCollectionByNameOrId('audit_log'));
  row.set('space', space);
  row.set('action', action);
  row.set('collection', record.collection().name);
  row.set('record', record.id);
  row.set('changes', changes);
  app.save(row);
}

function validName(name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 200) invalid('Space name must contain 1-200 characters.');
  return name.trim();
}

function only(body, allowed) {
  for (const k of Object.keys(body)) if (!allowed.includes(k)) invalid(k + ' cannot be set here');
}

function revisionCheck(body, record) {
  if (!Number.isInteger(body.expected_revision)) invalid('expected_revision required');
  if (record.getInt('revision') !== body.expected_revision) throw new ApiError(409, 'Revision conflict', {});
}

function createSpace(app, name) {
  let record;
  app.runInTransaction(tx => {
    record = new Record(tx.findCollectionByNameOrId('spaces'));
    record.set('name', validName(name));
    record.set('archived', false);
    record.set('revision', 1);
    tx.save(record);
    audit(tx, record.id, record, 'create', {revision: 1, name: record.getString('name')});
  });
  return record;
}

// POST /api/collections/spaces/records {name}
function createRequest(e) {
  const body = e.requestInfo().body;
  only(body, ['name']);
  const record = createSpace(e.app, body.name);
  return e.json(200, e.app.findRecordById('spaces', record.id));
}

// PATCH /api/collections/spaces/records/{id} {name?, archived?, expected_revision}
function updateRequest(e) {
  const body = e.requestInfo().body;
  only(body, ['name', 'archived', 'expected_revision']);
  let record;
  e.app.runInTransaction(tx => {
    record = requireSpace(tx, e.record.original().id, false);
    revisionCheck(body, record);
    const changes = {};
    if (Object.prototype.hasOwnProperty.call(body, 'name')) {
      changes.name = validName(body.name);
      record.set('name', changes.name);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'archived')) {
      if (typeof body.archived !== 'boolean') invalid('archived must be a boolean.');
      if (body.archived && settings(tx).getString('default_space') === record.id) invalid('The default space cannot be archived; make another space the default first.');
      changes.archived = body.archived;
      record.set('archived', body.archived);
    }
    if (!Object.keys(changes).length) invalid('No space changes supplied.');
    record.set('revision', record.getInt('revision') + 1);
    tx.save(record);
    changes.revision = record.getInt('revision');
    audit(tx, record.id, record, 'update', changes);
  });
  return e.json(200, e.app.findRecordById('spaces', record.id));
}

// PATCH /api/collections/settings/records/projectsettings {default_space, expected_revision}
function settingsRequest(e) {
  const body = e.requestInfo().body;
  only(body, ['default_space', 'expected_revision']);
  let record;
  e.app.runInTransaction(tx => {
    record = settings(tx);
    if (e.record.original().id !== record.id) missing();
    revisionCheck(body, record);
    const space = requireSpace(tx, body.default_space, false);
    if (space.getBool('archived')) invalid('Restore this archived space before making it the default.');
    record.set('default_space', space.id);
    record.set('revision', record.getInt('revision') + 1);
    tx.save(record);
    audit(tx, space.id, record, 'update', {revision: record.getInt('revision'), default_space: space.id});
  });
  return e.json(200, e.app.findRecordById('settings', record.id));
}

function view(space, settingsRecord) {
  return {id: space.id, name: space.getString('name'), archived: space.getBool('archived'), revision: space.getInt('revision'),
    settings_revision: settingsRecord.getInt('revision')};
}

// GET /api/spaces/default
function defaultRequest(e) {
  e.response.header().set('Cache-Control', 'no-store');
  const record = settings(e.app);
  return e.json(200, view(e.app.findRecordById('spaces', record.getString('default_space')), record));
}

module.exports = {SETTINGS, missing, requireSpace, defaultSpace, createSpace, createRequest, updateRequest, settingsRequest, defaultRequest};
