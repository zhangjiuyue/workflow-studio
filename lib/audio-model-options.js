import { audioModelCatalog } from './provider-model-catalog.js';
export const configuredAudioModels = audioModelCatalog;
export function mergeAudioModelOptions(customModels = []) {
  return Array.from(new Map([...audioModelCatalog, ...customModels].filter(model => model?.id).map(model => [model.id, model])).values());
}
