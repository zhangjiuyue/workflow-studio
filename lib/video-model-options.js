import { videoModelCatalog, modelsFromApiKey, modelDescriptor } from './provider-model-catalog.js';
export const videoGenerationModels = videoModelCatalog;
export function videoModelsForApiKey(apiKey) {
  return apiKey ? modelsFromApiKey(apiKey).map(model => modelDescriptor(apiKey, model)) : [];
}
