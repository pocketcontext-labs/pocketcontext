// Store policy with the database, never a machine's account selection. Missing
// startup evidence always means an existing project and preserves Company.
migrate(app => {
  const collection = new Collection({name: 'project_policy', type: 'base',
    listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    fields: [{name: 'default_space', type: 'select', values: ['company', 'personal'], required: true, maxSelect: 1}]});
  app.save(collection);
  const policy = new Record(collection);
  policy.set('id', 'projectpolicy01');
  policy.set('default_space', app.store().get('pocketcontextNewDatabase') === true ? 'personal' : 'company');
  app.save(policy);
}, () => { throw new Error('Restore a complete backup to undo project default policy.'); });
