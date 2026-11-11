import assert from 'node:assert/strict';
import test from 'node:test';
import {imageModelsForApiKey} from './image-model-options.js';
test('image choices preserve configured identity and capabilities in tools and workflows', () => {
  const key = {channel:'Synthetic',modelOptions:[{id:'image',name:'Image',resolutions:['2k'],referenceLimit:3}]};
  for (const options of [{},{workflow:true}]) {
    const models = imageModelsForApiKey(key, options);
    assert.equal(models[0].id,'Synthetic::image');
    assert.equal(models[0].modelId,'image');
    assert.deepEqual(models[0].resolutions,['2k']);
    assert.equal(models[0].referenceLimit,3);
  }
  assert.deepEqual(imageModelsForApiKey({channel:'Unknown'}),[]);
});
