migrate(app => {
  const access = "@request.auth.id != '' && @request.auth.collectionName = 'users' && @request.auth.disabled = false";
  const text = (name,required=false,max=2000) => ({name,type:'text',required,max});
  const rel = (name,table,required=true) => ({name,type:'relation',collectionId:app.findCollectionByNameOrId(table).id,maxSelect:1,required,cascadeDelete:false});
  const choice = (name,values) => ({name,type:'select',values,maxSelect:1,required:true});
  function create(name,fields,indexes=[],writable=true) {
    app.save(new Collection({name,type:'base',listRule:access,viewRule:access,createRule:writable?access:null,updateRule:writable?access:null,deleteRule:null,
      fields:fields.concat(writable?[rel('created_by','users',false),rel('updated_by','users',false),{name:'revision',type:'number',required:true,min:1,onlyInt:true},{name:'created',type:'autodate',onCreate:true},{name:'updated',type:'autodate',onCreate:true,onUpdate:true}]:[]),indexes}));
  }
  create('user_directory',[text('name',true,200)],[],false);
  create('sources',[text('title',true,500),text('original_name',true,500),text('media_type',true,100),text('source_date',false,100),text('sha256',false,64),text('supersedes',false,15),{name:'original',type:'file',maxSelect:1,maxSize:104857600,protected:true,required:true}],['CREATE UNIQUE INDEX idx_source_hash ON sources(sha256) WHERE sha256 != \'\'']);
  create('renditions',[rel('source','sources'),text('kind',true,100),text('processor',true,300),text('version_label',true,100),text('notes',false,10000)],['CREATE UNIQUE INDEX idx_rendition ON renditions(source,kind,version_label)']);
  create('passages',[rel('rendition','renditions'),{name:'ordinal',type:'number',required:true,min:1,onlyInt:true},text('locator',true,500),text('body',true,30000)],['CREATE UNIQUE INDEX idx_passage ON passages(rendition,ordinal)']);
  create('ingestion_runs',[text('key',true,100),choice('status',['staging','published','cancelled']),text('description',true,2000),{name:'sources',type:'relation',collectionId:app.findCollectionByNameOrId('sources').id,maxSelect:100},text('issue',false,10000)],['CREATE UNIQUE INDEX idx_run_key ON ingestion_runs(key)']);
  create('pages',[{name:'slug',type:'text',required:true,max:150,pattern:'^[a-z0-9]+(-[a-z0-9]+)*$'},choice('kind',['summary','concept','entity','transcript','answer','legacy'])],['CREATE UNIQUE INDEX idx_page_slug ON pages(slug)']);
  create('page_revisions',[rel('run','ingestion_runs'),rel('page','pages'),text('base_revision',false,15),text('title',true,500),text('summary',true,2000),text('body',true,100000),{name:'archived',type:'bool'}],['CREATE UNIQUE INDEX idx_run_page ON page_revisions(run,page)']);
  create('citations',[rel('page_revision','page_revisions'),rel('passage','passages'),{name:'marker',type:'text',required:true,max:8,pattern:'^[1-9][0-9]*$'},text('note',false,2000)],['CREATE UNIQUE INDEX idx_citation_marker ON citations(page_revision,marker)']);
  create('page_links',[rel('page_revision','page_revisions'),rel('target','pages')],['CREATE UNIQUE INDEX idx_page_link ON page_links(page_revision,target)']);
  create('publications',[rel('run','ingestion_runs'),{name:'sequence',type:'number',required:true,min:1,onlyInt:true},{name:'manifest',type:'json',required:true,maxSize:8388608},{name:'created',type:'autodate',onCreate:true}],['CREATE UNIQUE INDEX idx_publication_seq ON publications(sequence)','CREATE UNIQUE INDEX idx_publication_run ON publications(run)'],false);
  create('audit_log',[choice('action',['create','update']),text('collection',true),text('record',true),text('actor'),choice('actor_type',['user','superuser']),{name:'changes',type:'json',maxSize:5242880},{name:'created',type:'autodate',onCreate:true}],['CREATE INDEX idx_audit_record ON audit_log(collection,record,created)'],false);
  const settings=app.settings();settings.batch.enabled=true;settings.batch.maxRequests=20;settings.batch.timeout=5;app.save(settings);
},()=>{throw new Error('Restore a verified complete backup for rollback');});
