import assert from 'node:assert/strict';
import test from 'node:test';
import {apiKeysForService} from './api-key-options.js';
test('service selectors exclude keys without backend-enabled models', () => {
  const keys = [{id:'unknown',serviceType:'llm',channel:'Unknown'},
    {id:'enabled',serviceType:'llm',channel:'Synthetic',modelOptions:[{id:'m'}]},
    {id:'image',serviceType:'image',channel:'Synthetic',modelOptions:[{id:'i'}]}];
  assert.deepEqual(apiKeysForService(keys,'llm').map(key=>key.id), ['enabled']);
});
