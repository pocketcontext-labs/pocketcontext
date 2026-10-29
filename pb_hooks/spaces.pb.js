/// <reference path="../pb_data/types.d.ts" />
// Spaces and the default-space setting change only through these revision-checked handlers.
onRecordCreateRequest((e) => require(`${__hooks}/spaces.js`).createRequest(e), 'spaces');
onRecordUpdateRequest((e) => require(`${__hooks}/spaces.js`).updateRequest(e), 'spaces');
onRecordUpdateRequest((e) => require(`${__hooks}/spaces.js`).settingsRequest(e), 'settings');
onRecordCreateRequest((e) => { throw new ForbiddenError('The project has one settings record.'); }, 'settings');
onRecordDeleteRequest((e) => { throw new ForbiddenError('Spaces are retained; archive a space instead.'); }, 'spaces', 'settings');
routerAdd('GET', '/api/spaces/default', (e) => require(`${__hooks}/spaces.js`).defaultRequest(e), $apis.requireAuth('users'));
