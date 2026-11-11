import { modelsFromApiKey } from './provider-model-catalog.js';
// Empty until the user selects an administrator-configured model.
export const videoAnalysisModelId = '';
export function llmModelsForApiKey(apiKey) { return modelsFromApiKey(apiKey).map(model => ({ ...model })); }
export function videoAnalysisModelsForApiKey(apiKey) { return llmModelsForApiKey(apiKey).filter(model => model.videoAnalysis); }
export function apiKeySupportsVideoAnalysis(apiKey) { return videoAnalysisModelsForApiKey(apiKey).length > 0; }
