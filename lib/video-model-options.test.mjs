import assert from 'node:assert/strict';
import test from 'node:test';
import {videoModelsForApiKey} from './video-model-options.js';
test('video tools and workflows use exact administrator-configured capabilities', () => {
  const key={channel:'Synthetic',modelOptions:[{id:'video',resolutions:['720p'],durations:['5s','10s'],modes:['text','first-last-frame'],referenceLimit:2}]};
  for(const options of [{},{workflow:true}]) {
    const [model]=videoModelsForApiKey(key,options);
    assert.equal(model.modelId,'video');
    assert.deepEqual(model.resolutions,['720p']);
    assert.deepEqual(model.durations,['5s','10s']);
    assert.deepEqual(model.modes.map(mode=>mode.value),['text','first-last-frame']);
    assert.equal(model.referenceLimit,2);
  }
  assert.deepEqual(videoModelsForApiKey({channel:'Unknown'}),[]);
});
