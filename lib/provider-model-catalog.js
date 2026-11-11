// Only public model metadata lives here. Credentials and endpoint policies remain on the server.
export const imageModelCatalog = [];
export const videoModelCatalog = [];
export const audioModelCatalog = [];
export function modelsFromApiKey(key) {
  return Array.isArray(key?.modelOptions) ? key.modelOptions : [];
}
export function modelDescriptor(key, item) {
  const ratios = (item.ratios || ['16:9', '9:16', '1:1']).map(value => ({ value, label: value, detail: value }));
  return { ...item, id: `${key.channel}::${item.id}`, modelId: item.id, channel: key.channel, provider: 'configured-adapter',
    description: item.name || item.id, tags: [], ratios,
    resolutions: item.resolutions || ['default'], formats: item.formats || (key.serviceType === 'audio' ? ['mp3'] : ['png']),
    durations: item.durations || ['5s'], modes: (item.modes || ['text']).map(value => ({ value, label: value })),
    referenceLimit: item.referenceLimit || 0,
    emotions: ['natural', 'happy', 'sad', 'angry'].map(value => ({ value, label: value })) };
}
export function updateProviderModelCatalog(keys = []) {
  for (const [type, catalog] of [['image', imageModelCatalog], ['video', videoModelCatalog], ['audio', audioModelCatalog]]) {
    const models = keys.filter(key => key.serviceType === type).flatMap(key => modelsFromApiKey(key).map(item => modelDescriptor(key, item)));
    catalog.splice(0, catalog.length, ...Array.from(new Map(models.map(item => [item.id, item])).values()));
  }
}
