// Archive preserves immutable evidence and membership; owners can restore it.
migrate(app => {
  const spaces = app.findCollectionByNameOrId('spaces');
  spaces.fields.add(new BoolField({name: 'archived'}));
  spaces.createRule = "@request.auth.id != '' && @request.auth.collectionName = 'users' && @request.auth.disabled = false";
  spaces.updateRule = spaces.viewRule;
  app.save(spaces);
}, () => { throw new Error('Restore a verified complete backup for rollback'); });
