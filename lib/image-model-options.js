import { imageModelCatalog, modelsFromApiKey, modelDescriptor } from './provider-model-catalog.js';
export const allImageModels = imageModelCatalog;
export const workflowImageModels = imageModelCatalog;
export function imageModelsForApiKey(apiKey) {
  return apiKey ? modelsFromApiKey(apiKey).map(model => modelDescriptor(apiKey, model)) : [];
}
