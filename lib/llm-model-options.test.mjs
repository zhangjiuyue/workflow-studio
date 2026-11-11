import assert from 'node:assert/strict';
import test from 'node:test';
import {llmModelsForApiKey, apiKeySupportsVideoAnalysis, videoAnalysisModelsForApiKey} from './llm-model-options.js';
test('text choices preserve deployment order and require explicit video capability', () => {
  const key={channel:'Synthetic',modelOptions:[{id:'text'},{id:'vision',videoAnalysis:true}]};
  assert.deepEqual(llmModelsForApiKey(key).map(model=>model.id),['text','vision']);
  assert.deepEqual(videoAnalysisModelsForApiKey(key).map(model=>model.id),['vision']);
  assert.equal(apiKeySupportsVideoAnalysis(key),true);
  assert.equal(apiKeySupportsVideoAnalysis({channel:'Unknown'}),false);
  assert.deepEqual(llmModelsForApiKey({channel:'Unknown'}),[]);
});
