function invalid(s){throw new BadRequestError(s);}
function rows(app,t,f,p={}){return app.findRecordsByFilter(t,f,'',0,0,p);}
function spaces(){return require(`${__hooks}/spaces.js`);}
// Every reference must resolve inside the same space; absent and foreign IDs look identical.
function local(app,t,id,space){
 if(typeof id!=='string'||!/^[a-z0-9]{15}$/.test(id))spaces().missing();
 let r;try{r=app.findRecordById(t,id);}catch(_){spaces().missing();}
 if(r.getString('space')!==space)spaces().missing();
 return r;
}
const ROOTS=['sources','ingestion_runs','pages'];
const PARENTS={renditions:['source','sources'],passages:['rendition','renditions'],page_revisions:['run','ingestion_runs'],citations:['page_revision','page_revisions'],page_links:['page_revision','page_revisions']};
function draft(app,id){const r=app.findRecordById('ingestion_runs',id);if(r.getString('status')!=='staging')invalid('Run is closed');return r;}
function publish(app,run){
 const space=run.getString('space');
 // Sequence, latest manifest, home and conflicts are all per space.
 const prior=app.findRecordsByFilter('publications','space = {:space}','-sequence',1,0,{space});
 const manifest=prior.length?JSON.parse(prior[0].getString('manifest')):{};
 const revisions=rows(app,'page_revisions','run = {:id}',{id:run.id});
 const previousHome=prior.length?prior[0].getString('home'):'';
 const changesHome=!!run.getString('home')||run.getBool('clear_home');
 if(!revisions.length&&!changesHome)invalid('Cannot publish an empty run');
 if(changesHome&&run.getString('home_base')!==previousHome)throw new ApiError(409,'Home page changed since staging; reassess the home choice',{});
 const home=run.getBool('clear_home')?'':(run.getString('home')||previousHome);
 for(const r of revisions){
  const page=r.getString('page');
  if((manifest[page]||'')!==r.getString('base_revision'))throw new ApiError(409,'Page changed since synthesis; reassess in a new run',{});
  manifest[page]=r.id;
 }
 if(home&&(!manifest[home]||app.findRecordById('page_revisions',manifest[home]).getBool('archived')))invalid('Home page must be published and unarchived; choose a replacement or clear home');
 for(const r of revisions){
  const body=r.getString('body');
  if(/^\[\^\d+\]:/m.test(body))invalid('Footnote definitions are rendered from citations');
  const citations=rows(app,'citations','page_revision = {:id}',{id:r.id});
  const bodyMarkers=[...body.matchAll(/\[\^(\d+)\]/g)].map(m=>m[1]);
  const metadata=require(`${__hooks}/properties.js`);
  const {properties,evidence}=metadata.validate(r);
  const markers=new Set(bodyMarkers);
  for(const key of Object.keys(evidence))for(const marker of evidence[key])markers.add(marker);
  for(const marker of markers)if(!citations.some(c=>c.getString('marker')===marker))invalid('Missing citation marker '+marker);
  for(const c of citations)if(!markers.has(c.getString('marker')))invalid('Unused citation');
  if(!bodyMarkers.length&&!body.includes('[needs verification]')&&!(properties.catalog_type==='repository_document'&&properties.output_mode==='markdown'&&Object.keys(evidence).some(key=>evidence[key].length)))invalid('Uncited content must include [needs verification]');
  const links=rows(app,'page_links','page_revision = {:id}',{id:r.id});
  const linkedIds=new Set(links.map(l=>l.getString('target')));
  for(const key of metadata.relationships)for(const id of properties[key]||[])if(!linkedIds.has(id))invalid('Relationship property needs a page_links record: '+key);
  const linked=new Set(links.map(l=>app.findRecordById('pages',l.getString('target')).getString('slug')));
  for(const match of body.matchAll(/\[\[([^\]]+)\]\]/g)){
   const slug=match[1].split('|')[0].split('#')[0];
   if(!linked.has(slug))invalid('Page link needs a page_links record: '+slug);
  }
  for(const link of links){
   const target=manifest[link.getString('target')];
   if(!target||app.findRecordById('page_revisions',target).getBool('archived'))invalid('Link target is not published');
  }
 }
 const destinationKeys=new Set();
 // Archiving cannot leave links from unchanged published pages dangling.
 for(const page in manifest){const r=app.findRecordById('page_revisions',manifest[page]);if(r.getBool('archived'))continue;
  const metadata=require(`${__hooks}/properties.js`),properties=metadata.validate(r).properties;
  for(const key of Object.keys(metadata.targetCatalogs))for(const id of properties[key]||[]){
   const selected=manifest[id];
   if(!selected)invalid('Relationship target is not published: '+key);
   const target=app.findRecordById('page_revisions',selected);
   if(target.getBool('archived')||metadata.validate(target).properties.catalog_type!==metadata.targetCatalogs[key])invalid('Relationship target has invalid catalog type: '+key);
  }
  if(properties.catalog_type==='repository_document'&&properties.output_mode==='exact_copy')local(app,'sources',properties.source_id,space);
  if(properties.catalog_type==='repository_destination'&&properties.lifecycle_status!=='retired'){
   const key=JSON.stringify([properties.github_repository.toLowerCase(),properties.github_branch,properties.github_path]);
   if(destinationKeys.has(key))invalid('Duplicate active GitHub destination');
   destinationKeys.add(key);
  }
  if(properties.catalog_type==='repository_sync'){
   const destination=local(app,'page_revisions',properties.synced_destination_revision,space);
   if(destination.getString('page')!==properties.destinations[0]||destination.getBool('archived')||metadata.validate(destination).properties.catalog_type!=='repository_destination'||app.findRecordById('ingestion_runs',destination.getString('run')).getString('status')!=='published')invalid('Sync destination revision must be published and belong to its destination');
   const document=metadata.validate(destination).properties.documents[0];
   const synced=local(app,'page_revisions',properties.synced_document_revision,space);
   if(synced.getString('page')!==document||synced.getBool('archived')||metadata.validate(synced).properties.catalog_type!=='repository_document'||app.findRecordById('ingestion_runs',synced.getString('run')).getString('status')!=='published')invalid('Sync revision must be a published revision of the destination document');
   const source=metadata.validate(synced).properties;
   if(source.output_mode==='exact_copy'&&local(app,'sources',source.source_id,space).getString('sha256')!==properties.rendered_sha256)invalid('Rendered hash does not match exact-copy source');
  }
  for(const l of rows(app,'page_links','page_revision = {:id}',{id:r.id})){
   const target=manifest[l.getString('target')];
   if(!target||app.findRecordById('page_revisions',target).getBool('archived'))invalid('Publication would leave a broken link');
  }
 }
 if(Object.keys(manifest).length>10000)invalid('Publication page budget exceeded');
 const p=new Record(app.findCollectionByNameOrId('publications'));p.set('space',space);p.set('run',run.id);p.set('sequence',prior.length?prior[0].getInt('sequence')+1:1);p.set('manifest',manifest);p.set('home',home);app.save(p);
}
function validate(app,r){
 const t=r.collection().name,space=r.getString('space');
 if(t==='sources'&&r.getString('supersedes'))local(app,'sources',r.getString('supersedes'),space);
 if(t==='ingestion_runs'){
  if(r.getString('home')&&r.getBool('clear_home'))invalid('Cannot select and clear home together');
  if(r.getString('home'))local(app,'pages',r.getString('home'),space);
  for(const id of r.getStringSlice('sources'))local(app,'sources',id,space);
  if(r.getString('home_base')&&!/^[a-z0-9]{15}$/.test(r.getString('home_base')))invalid('home_base must be empty or a page ID');
  if(r.isNew()&&r.getString('status')!=='staging')invalid('New runs start in staging');
  if(!r.isNew()){
   if(r.original().getString('status')!=='staging')invalid('Closed runs are immutable');
   if(r.getString('key')!==r.original().getString('key'))invalid('Run key is immutable');
  }
 }
 if(t==='pages'&&['index','log'].includes(r.getString('slug')))invalid('Reserved page slug');
 if(t==='page_revisions'){
  const metadata=require(`${__hooks}/properties.js`).validate(r).properties;
  if(metadata.catalog_type==='repository_document'&&metadata.output_mode==='exact_copy')local(app,'sources',metadata.source_id,space);
  draft(app,r.getString('run'));
  local(app,'pages',r.getString('page'),space);
  const base=r.getString('base_revision');
  if(base&&local(app,'page_revisions',base,space).getString('page')!==r.getString('page'))invalid('Base revision belongs to another page');
 }
 if(t==='citations'||t==='page_links')draft(app,app.findRecordById('page_revisions',r.getString('page_revision')).getString('run'));
 if(t==='citations')local(app,'passages',r.getString('passage'),space);
 if(t==='page_links')local(app,'pages',r.getString('target'),space);
}
// Root records take their space from the request (default: the company
// space); children inherit their parent's. Membership is checked before any other detail.
function scope(app,r,body,actor){
 const t=r.collection().name;
 let space;
 if(!r.isNew()){
  space=r.original().getString('space');
  if(r.getString('space')!==space)invalid('space is immutable');
 }else if(ROOTS.includes(t)){
  space=body.space||(actor?spaces().COMPANY_SPACE:'');
  if(!space)invalid('space required');
 }else{
  const [field,table]=PARENTS[t];
  let parent;try{parent=app.findRecordById(table,r.getString(field));}catch(_){spaces().missing();}
  space=parent.getString('space');
  if(body.space&&body.space!==space)spaces().missing();
 }
 if(actor)spaces().requireMember(app,space,actor,true);else spaces().requireSpace(app,space);
 r.set('space',space);
}
function write(e){
 const original=e.app,r=e.record,t=r.collection().name,fresh=r.isNew(),body=e.requestInfo().body;
 original.runInTransaction(app=>{e.app=app;try{
  if(!fresh){
   const actor=e.auth&&e.auth.collection().name==='users'?e.auth.id:'';
   if(actor)spaces().requireMember(app,r.original().getString('space'),actor,false);
   if(t!=='ingestion_runs')invalid('Immutable record; create a new version');
   const current=app.findRecordById(t,r.id);
   if(!Number.isInteger(body.expected_revision))invalid('expected_revision required');
   if(current.getInt('revision')!==body.expected_revision||current.getInt('revision')!==r.original().getInt('revision'))throw new ApiError(409,'Revision conflict',{});
  }
  for(const k of ['revision','created_by','updated_by','created','updated','sha256'])if(Object.prototype.hasOwnProperty.call(body,k))invalid(k+' is server managed');
  const actor=e.auth&&e.auth.collection().name==='users'?e.auth.id:'';
  scope(app,r,body,actor);
  r.set('_audit_actor',actor?'user:'+actor:'superuser:'+e.auth.id);
  r.set('created_by',fresh?actor:r.original().getString('created_by'));r.set('updated_by',actor);r.set('revision',fresh?1:r.original().getInt('revision')+1);
  validate(app,r);
  if(t==='ingestion_runs'&&!fresh&&r.getString('status')==='published')publish(app,r);
  e.next();
 }finally{e.app=original;}});
}
function audit(e,action){
 const actor=e.record.getString('_audit_actor');if(!actor)return e.next();
 e.record.set('_audit_actor','');
 e.next();
 if(e.record.collection().name==='sources'&&action==='create'){
  // Stream through PocketBase's storage backend: never assume originals are local.
  const fs=e.app.newFilesystem();let reader,hash;
  try {
   reader=fs.getReader(e.record.baseFilesPath()+'/'+e.record.getString('original'));
   const command=$os.cmd('sha256sum');command.stdin=reader;
   hash=toString(command.output()).split(' ')[0];
  } catch (_) { invalid('Cannot hash original'); }
  finally { if(reader)reader.close();fs.close(); }
  if(!/^[a-f0-9]{64}$/.test(hash))invalid('Cannot hash original');
  e.record.set('sha256',hash);e.app.saveNoValidate(e.record);
 }
 const changes={revision:e.record.getInt('revision'),status:e.record.getString('status')};
 if(e.record.collection().name==='ingestion_runs'){changes.home=e.record.getString('home');changes.home_base=e.record.getString('home_base');changes.clear_home=e.record.getBool('clear_home');}
 const row=new Record(e.app.findCollectionByNameOrId('audit_log'));row.set('space',e.record.getString('space'));row.set('action',action);row.set('collection',e.record.collection().name);row.set('record',e.record.id);row.set('actor',actor.split(':')[1]);row.set('actor_type',actor.split(':')[0]);row.set('changes',changes);e.app.save(row);
}
module.exports={write,audit};
