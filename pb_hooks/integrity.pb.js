onRecordCreateRequest(e=>require(`${__hooks}/integrity.js`).write(e),'sources','renditions','passages','ingestion_runs','pages','page_revisions','citations','page_links');
onRecordCreateExecute(e=>require(`${__hooks}/integrity.js`).audit(e,"create"),'sources','renditions','passages','ingestion_runs','pages','page_revisions','citations','page_links');
onRecordUpdateRequest(e=>require(`${__hooks}/integrity.js`).write(e),'sources','renditions','passages','ingestion_runs','pages','page_revisions','citations','page_links');
onRecordUpdateExecute(e=>require(`${__hooks}/integrity.js`).audit(e,"update"),'sources','renditions','passages','ingestion_runs','pages','page_revisions','citations','page_links');
onRecordDeleteRequest(e=>{throw new ForbiddenError("History is retained; archive a page with a new revision");},'sources','renditions','passages','ingestion_runs','pages','page_revisions','citations','page_links',"publications","audit_log");
onRecordCreateRequest(e=>{throw new ForbiddenError("Server managed");},"publications","audit_log");
onRecordUpdateRequest(e=>{throw new ForbiddenError("Server managed");},"publications","audit_log");
// The publication checks without publishing: every problem of a staging run at once.
routerAdd('GET','/api/pocketcontext/runs/{id}/check',e=>require(`${__hooks}/integrity.js`).checkRequest(e),$apis.requireAuth('users'));
