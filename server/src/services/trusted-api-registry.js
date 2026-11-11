import { httpError } from '../http.js';
import { configuredProviders } from './provider-config.js';
export const CUSTOM_API_CHANNEL = '自定义渠道';
export const CUSTOM_API_UNAVAILABLE_MESSAGE = '此渠道尚未由站点管理员启用';
export const CUSTOM_API_STORED_SECRET = 'custom-channel-secret-not-stored';
const normalizeChannel = value => String(value || '').trim().toLowerCase();
export function trustedApiPolicy(channel = '', serviceType = '') {
  const provider = configuredProviders().find(item => normalizeChannel(item.channel) === normalizeChannel(channel));
  const service = provider?.services?.[String(serviceType).trim()];
  if (!service) return null;
  const models = service.models.map(model => model.id);
  return { channel: provider.channel, serviceType, endpoint: service.endpoint, authType: service.authType,
    adapter: service.adapter, modulePath: service.modulePath, models, modelAliases: [], modelText: models.join(', '),
    modelOptions: service.models.map(model => ({ ...model })) };
}
export function publicProviderCatalog() {
  return configuredProviders().flatMap(provider => Object.entries(provider.services).map(([serviceType, service]) => ({
    channel: provider.channel, serviceType, models: service.models.map(model => ({ ...model })),
    protocol: service.adapter === 'chat-completions' ? 'chat-completions' : 'configured-adapter',
  })));
}
export function isTrustedApiChannel(channel = '') {
  return configuredProviders().some(provider => normalizeChannel(provider.channel) === normalizeChannel(channel));
}
export function isTrustedApiConfiguration(channel = '', serviceType = '') { return Boolean(trustedApiPolicy(channel, serviceType)); }
export function isUntrustedApiConfiguration(channel = '', serviceType = '') { return !isTrustedApiConfiguration(channel, serviceType); }
export function applyTrustedApiPolicy(record = {}) {
  const policy = trustedApiPolicy(record.channel, record.serviceType);
  if (!policy) return { ...record };
  return { ...record, channel: policy.channel, endpoint: policy.endpoint, authType: policy.authType,
    model: policy.modelText, modelOptions: policy.modelOptions, protocol: policy.adapter };
}
export function assertTrustedApiModel(apiKey = {}, model = '') {
  const policy = trustedApiPolicy(apiKey.channel, apiKey.serviceType);
  if (!policy) throw httpError(503, CUSTOM_API_UNAVAILABLE_MESSAGE);
  const value = String(model || '').trim();
  if (!policy.models.includes(value)) throw httpError(400, '当前渠道不支持该模型。');
  return value;
}
