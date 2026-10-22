const COMPANY_SPACE = 'companyspace001';
// Spaces are the access boundary. Absent and foreign records produce the same
// not-found response so membership checks never confirm another space's contents.
const ROLES = ['owner', 'editor', 'reader'];
const WRITE_ROLES = ['owner', 'editor'];

function missing() { throw new NotFoundError('The requested resource wasn\'t found.'); }
function invalid(message) { throw new BadRequestError(message); }

function membership(app, space, account) {
  const rows = app.findRecordsByFilter('space_members', 'space = {:space} && account = {:account}', '', 1, 0, {space, account});
  return rows.length ? rows[0] : null;
}

// Returns the space when the account is an active member; otherwise not found.
function requireMember(app, space, account, write) {
  if (typeof space !== 'string' || !/^[a-z0-9]{15}$/.test(space)) missing();
  let record;
  try { record = app.findRecordById('spaces', space); } catch (_) { missing(); }
  const row = membership(app, record.id, account);
  if (!row || !row.getBool('active')) missing();
  if (write && record.getBool('archived')) throw new ForbiddenError('Restore this archived space before making changes.');
  if (write && !WRITE_ROLES.includes(row.getString('role'))) throw new ForbiddenError('This space membership is read-only.');
  return record;
}

function requireSpace(app, space) {
  if (typeof space !== 'string' || !/^[a-z0-9]{15}$/.test(space)) missing();
  try { return app.findRecordById('spaces', space); } catch (_) { missing(); }
}

function audit(app, record, action, actor, actorType, changes) {
  const row = new Record(app.findCollectionByNameOrId('audit_log'));
  row.set('space', record.collection().name === 'spaces' ? record.id : record.getString('space'));
  row.set('action', action);
  row.set('collection', record.collection().name);
  row.set('record', record.id);
  row.set('actor', actor || '');
  row.set('actor_type', actorType);
  row.set('changes', changes);
  app.save(row);
}

function activeUser(app, account) {
  let user;
  try { user = app.findRecordById('users', account); } catch (_) { missing(); }
  if (user.getBool('disabled')) throw new ForbiddenError('Disabled accounts cannot hold spaces.');
  return user;
}

function defaultPolicy(app) {
  return app.findRecordById('project_policy', 'projectpolicy01').getString('default_space');
}

// Read-only resolution: never creates a space or repairs revoked membership.
function defaultSpace(app, account) {
  activeUser(app, account);
  const policy = defaultPolicy(app);
  let id = COMPANY_SPACE;
  if (policy === 'personal') {
    const rows = app.findRecordsByFilter('spaces', "kind = 'personal' && created_by = {:account}", '', 1, 0, {account});
    if (!rows.length) missing();
    id = rows[0].id;
  } else if (policy !== 'company') {
    throw new InternalServerError('Invalid project space policy.');
  }
  const space = requireMember(app, id, account, false);
  return {id: space.id, kind: space.getString('kind'), name: space.getString('name'), policy};
}

function defaultRequest(e) {
  e.response.header().set('Cache-Control', 'no-store');
  return e.json(200, defaultSpace(e.app, e.auth.id));
}

// Idempotent and transactional. Returns the account's personal space ID, creating
// the space and its single owner membership when absent. Disabled accounts throw.
function ensurePersonalSpace(app, accountId) {
  let id = '';
  app.runInTransaction(tx => {
    activeUser(tx, accountId);
    const existing = tx.findRecordsByFilter('spaces', "kind = 'personal' && created_by = {:account}", '', 1, 0, {account: accountId});
    if (existing.length) { id = existing[0].id; return; }
    const space = new Record(tx.findCollectionByNameOrId('spaces'));
    space.set('kind', 'personal');
    space.set('name', 'Personal');
    space.set('created_by', accountId);
    space.set('updated_by', accountId);
    space.set('revision', 1);
    tx.save(space);
    const owner = new Record(tx.findCollectionByNameOrId('space_members'));
    owner.set('space', space.id);
    owner.set('account', accountId);
    owner.set('role', 'owner');
    owner.set('active', true);
    owner.set('created_by', accountId);
    owner.set('updated_by', accountId);
    owner.set('revision', 1);
    tx.save(owner);
    audit(tx, space, 'create', accountId, 'system', {revision: 1, kind: 'personal'});
    audit(tx, owner, 'create', accountId, 'system', {revision: 1, role: 'owner', active: true, account: accountId});
    id = space.id;
  });
  return id;
}

function validName(name) {
  if (typeof name !== 'string' || !name.trim() || name.length > 200) invalid('Space name must contain 1-200 characters.');
  return name.trim();
}

function activeOwners(app, space) {
  return app.findRecordsByFilter('space_members', "space = {:space} && role = 'owner' && active = true", '', 0, 0, {space}).length;
}

// Creation atomically grants the creator ownership; actor '' means a trusted operator.
function createGroupSpace(app, actorId, name) {
  let id = '';
  app.runInTransaction(tx => {
    if (actorId) activeUser(tx, actorId);
    const space = new Record(tx.findCollectionByNameOrId('spaces'));
    space.set('kind', 'group');
    space.set('name', validName(name));
    space.set('created_by', actorId);
    space.set('updated_by', actorId);
    space.set('revision', 1);
    tx.save(space);
    audit(tx, space, 'create', actorId, actorId ? 'user' : 'superuser', {revision: 1, kind: 'group'});
    if (actorId) putMembership(tx, actorId, space, actorId, 'owner', true, null, true);
    id = space.id;
  });
  return id;
}

function putMembership(app, actorId, space, accountId, role, active, expectedRevision, bootstrap) {
  if (space.getString('kind') !== 'group') invalid('Personal space membership is fixed.');
  if (actorId && !bootstrap) {
    const own = membership(app, space.id, actorId);
    if (!own || !own.getBool('active')) missing();
    if (own.getString('role') !== 'owner') throw new ForbiddenError('Only space owners can change membership.');
  }
  if (!ROLES.includes(role)) invalid('Invalid space role.');
  if (typeof active !== 'boolean') invalid('active must be a boolean.');
  let row = membership(app, space.id, accountId);
  if (row) {
    if (expectedRevision !== row.getInt('revision')) throw new ApiError(409, 'Revision conflict', {});
  } else {
    if (expectedRevision != null && expectedRevision !== 0) throw new ApiError(409, 'Revision conflict', {});
    if (typeof accountId !== 'string' || !/^[a-z0-9]{15}$/.test(accountId)) missing();
    row = new Record(app.findCollectionByNameOrId('space_members'));
    row.set('space', space.id);
    row.set('account', accountId);
    row.set('created_by', actorId);
  }
  if (active) activeUser(app, accountId);
  const fresh = row.isNew();
  row.set('role', role);
  row.set('active', active);
  row.set('updated_by', actorId);
  row.set('revision', fresh ? 1 : row.getInt('revision') + 1);
  app.save(row);
  if (space.id !== COMPANY_SPACE && !activeOwners(app, space.id) && !bootstrap) invalid('A group space requires an active owner.');
  audit(app, row, fresh ? 'create' : 'update', actorId, actorId ? 'user' : 'superuser', {revision: row.getInt('revision'), role, active, account: accountId});
  return row;
}

function setMembership(app, actorId, spaceId, accountId, role, active, expectedRevision) {
  let result;
  app.runInTransaction(tx => {
    if (actorId) activeUser(tx, actorId);
    const space = requireSpace(tx, spaceId);
    if (actorId && !membership(tx, space.id, actorId)) missing();
    const row = putMembership(tx, actorId, space, accountId, role, active, expectedRevision, false);
    result = {id: row.id, revision: row.getInt('revision')};
  });
  return result;
}

// Superuser REST fixtures share the same validation as the guarded functions.
function trusted(e) {
  if (!e.hasSuperuserAuth()) throw new ForbiddenError('Only superusers can perform this action.');
}

function createRequest(e) {
  if (e.record.collection().name !== 'spaces') trusted(e);
  if (!e.hasSuperuserAuth()) activeUser(e.app, e.auth.id);
  const body = e.requestInfo().body;
  const t = e.record.collection().name;
  for (const k of ['revision', 'created_by', 'updated_by', 'created', 'updated']) {
    if (Object.prototype.hasOwnProperty.call(body, k)) invalid(k + ' is server managed');
  }
  if (t === 'spaces') {
    for (const k of Object.keys(body)) if (!['name', 'kind'].includes(k)) invalid(k + ' is server managed');
    if (body.kind !== 'group') invalid('Personal spaces are created by the server.');
    const id = createGroupSpace(e.app, e.hasSuperuserAuth() ? '' : e.auth.id, body.name);
    return e.json(200, e.app.findRecordById('spaces', id));
  }
  const space = requireSpace(e.app, body.space);
  if (typeof body.account === 'string' && membership(e.app, space.id, body.account)) invalid('Membership already exists; update it instead.');
  let row;
  e.app.runInTransaction(tx => {
    row = putMembership(tx, '', tx.findRecordById('spaces', space.id), body.account, body.role, body.active === undefined ? true : body.active, null, false);
  });
  return e.json(200, e.app.findRecordById('space_members', row.id));
}

function updateRequest(e) {
  const body = e.requestInfo().body;
  const t = e.record.collection().name;
  const original = e.record.original();
  if (!Number.isInteger(body.expected_revision)) invalid('expected_revision required');
  if (t === 'spaces') {
    for (const k of Object.keys(body)) if (!['name', 'archived', 'expected_revision'].includes(k)) invalid(k + ' is immutable');
    const actor = e.hasSuperuserAuth() ? '' : e.auth.id;
    let record;
    e.app.runInTransaction(tx => {
      if (actor) activeUser(tx, actor);
      record = actor ? requireMember(tx, original.id, actor, false) : requireSpace(tx, original.id);
      if (actor && membership(tx, record.id, actor).getString('role') !== 'owner') throw new ForbiddenError('Only space owners can manage this space.');
      if (record.getInt('revision') !== body.expected_revision) throw new ApiError(409, 'Revision conflict', {});
      const changes = {};
      if (Object.prototype.hasOwnProperty.call(body, 'name')) {
        changes.name = validName(body.name);
        record.set('name', changes.name);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'archived')) {
        if (typeof body.archived !== 'boolean') invalid('archived must be a boolean.');
        if (record.id === COMPANY_SPACE || record.getString('kind') === 'personal') invalid('Company and Personal spaces cannot be archived.');
        changes.archived = body.archived;
        record.set('archived', body.archived);
      }
      if (!Object.keys(changes).length) invalid('No space changes supplied.');
      record.set('updated_by', actor);
      record.set('revision', record.getInt('revision') + 1);
      tx.save(record);
      changes.revision = record.getInt('revision');
      audit(tx, record, 'update', actor, actor ? 'user' : 'superuser', changes);
    });
    return e.json(200, record);
  }
  trusted(e);
  for (const k of Object.keys(body)) if (!['role', 'active', 'expected_revision'].includes(k)) invalid(k + ' is immutable');
  let row;
  e.app.runInTransaction(tx => {
    const current = tx.findRecordById('space_members', original.id);
    const space = tx.findRecordById('spaces', current.getString('space'));
    row = putMembership(tx, '', space, current.getString('account'),
      body.role === undefined ? current.getString('role') : body.role,
      body.active === undefined ? current.getBool('active') : body.active, body.expected_revision, false);
  });
  return e.json(200, e.app.findRecordById('space_members', row.id));
}

// Provision company access only when an account is first created. Existing
// inactive membership is an explicit revocation and is never reactivated.
function admitCompany(app, accountId) {
  app.runInTransaction(tx => {
    const user = tx.findRecordById('users', accountId);
    if (user.getBool('disabled') || membership(tx, COMPANY_SPACE, accountId)) return;
    putMembership(tx, '', requireSpace(tx, COMPANY_SPACE), accountId, 'editor', true, null, true);
  });
}

function admitRequest(e) {
  const original = e.app;
  original.runInTransaction(tx => {
    e.app = tx;
    try {
      e.next();
      admitCompany(tx, e.record.id);
      if (!e.record.getBool('disabled') && defaultPolicy(tx) === 'personal') ensurePersonalSpace(tx, e.record.id);
    } finally { e.app = original; }
  });
}

function personalRequest(e) {
  return e.json(200, {id: ensurePersonalSpace(e.app, e.auth.id)});
}

module.exports = {COMPANY_SPACE, defaultSpace, defaultRequest, admitCompany, admitRequest, personalRequest, ensurePersonalSpace, requireMember, requireSpace, membership, missing, createGroupSpace, setMembership, createRequest, updateRequest};
