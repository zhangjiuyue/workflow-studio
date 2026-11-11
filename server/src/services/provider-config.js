import { readFileSync } from 'node:fs';
import { isAbsolute, resolve, dirname } from 'node:path';
import { isIP } from 'node:net';

const services = new Set(['llm', 'image', 'video', 'audio', 'draft']);
const cache = new Map();
export function normalizeProviderDefinitions(input, baseDir = process.cwd()) {
  if (!Array.isArray(input)) throw new Error('Provider configuration must be an array.');
  const channels = new Set();
  return input.map(provider => {
    const channel = String(provider.channel || '').trim();
    const normalized = channel.toLowerCase();
    if (!channel || channels.has(normalized)) throw new Error('Provider channel names must be nonempty and unique.');
    channels.add(normalized);
    const normalizedServices = {};
    for (const [serviceType, service] of Object.entries(provider.services || {})) {
      if (!services.has(serviceType)) throw new Error('Unsupported provider service type.');
      const endpoint = validateProviderEndpoint(service.endpoint || provider.endpoint);
      const adapter = service.adapter || 'chat-completions';
      if (!['chat-completions', 'module'].includes(adapter)) throw new Error('Unsupported adapter type.');
      if (adapter === 'chat-completions' && serviceType !== 'llm') throw new Error('chat-completions only supports llm.');
      const modulePath = adapter === 'module' ? String(service.module || '').trim() : '';
      if (adapter === 'module' && !modulePath) throw new Error('Module adapters require an administrator-configured file path.');
      const models = (Array.isArray(service.models) ? service.models : []).map(model => {
        const data = typeof model === 'string' ? { id: model } : model;
        const id = String(data?.id || '').trim();
        if (!id || /[\r\n]/.test(id)) throw new Error('Provider models require a valid id.');
        const metadata = {};
        for (const field of ['ratios', 'resolutions', 'formats', 'durations', 'modes']) {
          if (Array.isArray(data[field])) metadata[field] = data[field].filter(value => typeof value === 'string' && value.length <= 100).slice(0, 32);
        }
        if (Number.isInteger(data.referenceLimit)) metadata.referenceLimit = Math.min(32, Math.max(0, data.referenceLimit));
        return { id, name: String(data.name || id), videoAnalysis: data.videoAnalysis === true, ...metadata };
      });
      if (!models.length || new Set(models.map(model => model.id)).size !== models.length) throw new Error('Provider models must be a nonempty unique list.');
      const authType = service.authType || provider.authType || 'Bearer';
      if (!['Bearer', 'x-api-key'].includes(authType)) throw new Error('Unsupported provider authentication type.');
      normalizedServices[serviceType] = { endpoint, adapter, authType, models,
        ...(modulePath ? { modulePath: isAbsolute(modulePath) ? modulePath : resolve(baseDir, modulePath) } : {}) };
    }
    if (!Object.keys(normalizedServices).length) throw new Error('Provider requires at least one service.');
    return { channel, services: normalizedServices };
  });
}

export function validateProviderEndpoint(value) {
  let url;
  try { url = new URL(String(value || '')); } catch { throw new Error('Provider endpoint must be a valid HTTPS URL.'); }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || isIP(host) || !host.includes('.') || /(?:^|\.)(?:localhost|local|internal|test)$/.test(host)) {
    throw new Error('Provider endpoint must use a public HTTPS hostname without embedded credentials, query or fragment.');
  }
  return url.href.replace(/\/$/, '');
}

export function configuredProviders() {
  const filename = process.env.WORKFLOW_PROVIDER_CONFIG;
  if (!filename) return [];
  const absolute = resolve(filename);
  if (!cache.has(absolute)) {
    let data;
    try { data = JSON.parse(readFileSync(absolute, 'utf8')); }
    catch { throw new Error('Unable to read WORKFLOW_PROVIDER_CONFIG; check the server configuration file.'); }
    cache.set(absolute, normalizeProviderDefinitions(data, dirname(absolute)));
  }
  return cache.get(absolute);
}
