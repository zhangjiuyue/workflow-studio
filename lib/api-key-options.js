export function apiKeysForService(apiKeys = [], serviceType = '') {
  return (Array.isArray(apiKeys) ? apiKeys : []).filter(key => key?.serviceType === serviceType && Array.isArray(key.modelOptions) && key.modelOptions.length > 0);
}
export function sortLlmApiKeys(apiKeys = []) { return [...apiKeys]; }
export function isRemovedApiChannel() { return false; }
