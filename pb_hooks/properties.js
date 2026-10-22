// Flat, bounded metadata; the Markdown body remains the place for explanations.
const relationships=['deployment_profiles','applications','resources','credentials','consumers','replaces','replaced_by','members','accountable_owners','backup_owners','documents','destinations'];
const targetCatalogs={members:'person',accountable_owners:'group',backup_owners:'group',documents:'repository_document',destinations:'repository_destination'};
const reserved=['pocketcontext_page','pocketcontext_revision','id','page','page_id','revision','revision_id','publication','publication_id','kind','title','summary','body','archived','run','base_revision','created','updated','created_by','updated_by','properties','property_evidence','constructor','prototype','__proto__'];
function invalid(message){throw new BadRequestError(message);}
function object(record,field){
 const raw=record.getString(field);
 const value=raw?JSON.parse(raw):null;
 if(value===null)return {};
 if(typeof value!=='object'||Array.isArray(value))invalid(field+' must be an object');
 return value;
}
function navigation(properties){
 const has=key=>Object.prototype.hasOwnProperty.call(properties,key);
 for(const key of ['topics','catalogs'])if(has(key)){
  const value=properties[key];
  if(!Array.isArray(value)||value.length>100||value.some(v=>typeof v!=='string'||v.length>64||! /^[a-z0-9]+(-[a-z0-9]+)*$/.test(v))||new Set(value).size!==value.length)invalid(key+' must contain up to 100 unique lowercase hyphenated slugs of at most 64 characters');
 }
 if(has('navigation_kind')&&!['topic','catalog'].includes(properties.navigation_kind))invalid('navigation_kind must be topic or catalog');
 if(has('navigation_order')&&(!has('navigation_kind')||!Number.isSafeInteger(properties.navigation_order)||properties.navigation_order<0))invalid('navigation_order requires a definition and a nonnegative safe integer');
 for(const key of ['catalog_columns','catalog_sort'])if(has(key)&&properties.navigation_kind!=='catalog')invalid(key+' requires navigation_kind catalog');
 if(has('catalog_columns')){
  const columns=properties.catalog_columns;
  const valid=key=>typeof key==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(key)&&(!reserved.includes(key)||['title','summary','slug','kind'].includes(key));
  if(!Array.isArray(columns)||columns.length>12||columns.some(key=>!valid(key))||new Set(columns).size!==columns.length)invalid('catalog_columns requires up to 12 unique safe property or display field names');
 }
 if(has('catalog_sort')){
  const sort=properties.catalog_sort;
  const key=typeof sort==='string'?sort.replace(/^-/, ''):'';
  if(!key||(key!=='title'&&!(properties.catalog_columns||[]).includes(key)))invalid('catalog_sort must be title or a listed column, optionally prefixed with -');
 }
}
function validate(record){
 const properties=object(record,'properties'),evidence=object(record,'property_evidence');
 if(Object.keys(properties).length>64)invalid('Too many properties');
 for(const key of Object.keys(properties)){
  if(!/^[a-z][a-z0-9_]{0,63}$/.test(key)||reserved.includes(key))invalid('Invalid or reserved property key: '+key);
  const value=properties[key];
  if(Array.isArray(value)){
   if(value.length>100||value.some(v=>typeof v!=='string'||v.length>2048)||new Set(value).size!==value.length)invalid('Property lists must contain up to 100 unique bounded strings');
  }else if(value!==null&&typeof value!=='boolean'&&!(typeof value==='string'&&value.length<=2048)&&!(typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=Number.MAX_SAFE_INTEGER))invalid('Property values must be bounded scalars or string lists');
  if(key==='catalog_type'&&!['resource','credential','deployment','person','group','organization','product','model','repository_document','repository_destination','repository_sync'].includes(value))invalid('Invalid catalog_type');
  if(relationships.includes(key)&&(!Array.isArray(value)||value.some(v=>! /^[a-z0-9]{15}$/.test(v))))invalid('Relationship properties require page ID lists');
 }
 navigation(properties);
 if(Object.prototype.hasOwnProperty.call(properties,'members')&&properties.catalog_type!=='group')invalid('Only group pages can declare members');
 const catalog=properties.catalog_type;
 const required=(key,pattern)=>{if(typeof properties[key]!=='string'||!pattern.test(properties[key]))invalid('Invalid or missing '+key);};
 for(const [key,type] of [['documents','repository_destination'],['destinations','repository_sync']])if(Object.prototype.hasOwnProperty.call(properties,key)&&catalog!==type)invalid('Invalid relationship source: '+key);
 if(catalog==='repository_document'){
  if(!['readme','license','copyright','notice','contributing','prompt','other'].includes(properties.document_type))invalid('Invalid document_type');
  if(!['exact_copy','markdown'].includes(properties.output_mode))invalid('Invalid output_mode');
  if(properties.output_mode==='exact_copy')required('source_id',/^[a-z0-9]{15}$/);
 }
 if(catalog==='repository_destination'){
  if(!Array.isArray(properties.documents)||properties.documents.length!==1)invalid('Destination requires one document');
  required('github_repository',/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/);
  if(properties.github_repository.split('/')[1]==='.'||properties.github_repository.split('/')[1]==='..')invalid('Invalid github_repository');
  required('github_branch',/^[^\s\x00-\x1f\x7f~^:?*\[\\]+$/);
  const branch=properties.github_branch;
  if(branch.startsWith('-')||branch.startsWith('/')||branch.endsWith('/')||branch.endsWith('.')||branch.includes('..')||branch.includes('@{')||branch==='@'||branch.split('/').some(v=>!v||v.startsWith('.')||v.endsWith('.lock')))invalid('Invalid github_branch');
  required('github_path',/^[^\x00-\x1f\x7f\\]+$/);
  if(properties.github_path.split('/').some(v=>!v||v==='.'||v==='..'||v.toLowerCase()==='.git'))invalid('Invalid github_path');
 }
 if(catalog==='repository_sync'){
  if(!Array.isArray(properties.destinations)||properties.destinations.length!==1)invalid('Sync requires one destination');
  required('synced_destination_revision',/^[a-z0-9]{15}$/);
  required('synced_document_revision',/^[a-z0-9]{15}$/);
  required('rendered_sha256',/^[a-f0-9]{64}$/);
  if(!['unknown','pending'].includes(properties.sync_status)||properties.github_commit!=null)required('github_commit',/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
  required('checked_at',/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/);
  if(!Number.isFinite(Date.parse(properties.checked_at))||new Date(properties.checked_at).toISOString().replace('.000Z','Z')!==properties.checked_at.replace('.000Z','Z'))invalid('Invalid checked_at');
  if(!['current','behind','diverged','pending','unknown'].includes(properties.sync_status))invalid('Invalid sync_status');
 }
 for(const key of Object.keys(evidence)){
  if(!Object.prototype.hasOwnProperty.call(properties,key))invalid('Evidence requires a property: '+key);
  const markers=evidence[key];
  if(!Array.isArray(markers)||markers.length>32||markers.some(v=>typeof v!=='string'||! /^[1-9][0-9]{0,5}$/.test(v))||new Set(markers).size!==markers.length)invalid('Property evidence requires up to 32 unique citation markers');
 }
 return {properties,evidence};
}
module.exports={validate,relationships,targetCatalogs};
