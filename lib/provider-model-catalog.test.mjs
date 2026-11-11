import assert from 'node:assert/strict';
import test from 'node:test';
import { updateProviderModelCatalog, imageModelCatalog, videoModelCatalog } from './provider-model-catalog.js';
import { imageModelsForApiKey } from './image-model-options.js';
import { videoAnalysisModelsForApiKey } from './llm-model-options.js';

test('catalog follows configured metadata without built-in channels and clears on empty input', () => {
  updateProviderModelCatalog([]);
  assert.equal(imageModelCatalog.length, 0);
  const keys = [
    { channel: 'One', serviceType: 'image', modelOptions: [{ id: 'same', name: 'First' }] },
    { channel: 'Two', serviceType: 'image', modelOptions: [{ id: 'same', name: 'Second' }] },
    { channel: 'Three', serviceType: 'video', modelOptions: [{ id: 'v', modes: ['text', 'first-last-frame'], referenceLimit: 2 }] },
  ];
  updateProviderModelCatalog(keys);
  assert.deepEqual(imageModelCatalog.map(model => model.id), ['One::same', 'Two::same']);
  assert.equal(imageModelsForApiKey(keys[0])[0].modelId, 'same');
  assert.deepEqual(videoModelCatalog[0].modes.map(mode => mode.value), ['text', 'first-last-frame']);
  assert.equal(videoModelCatalog[0].referenceLimit, 2);
  updateProviderModelCatalog([]);
  assert.equal(imageModelCatalog.length, 0);
  assert.equal(videoModelCatalog.length, 0);
});

test('video analysis options require explicit backend capability metadata', () => {
  assert.deepEqual(videoAnalysisModelsForApiKey({ model: 'arbitrary-model' }), []);
  assert.deepEqual(videoAnalysisModelsForApiKey({ modelOptions: [{ id: 'text' }, { id: 'video', videoAnalysis: true }] }).map(model => model.id), ['video']);
});
