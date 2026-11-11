import { pathToFileURL } from 'node:url';
import { httpError } from '../http.js';
import { getDecryptedApiKey } from './api-key-store.js';
import { assertTrustedApiModel, trustedApiPolicy } from './trusted-api-registry.js';
import { assertUserCanUseModels } from './user-store.js';
import { recordBackendRequestLog } from './backend-request-log-store.js';
import { recordUsageEvent } from './usage-store.js';

export async function executeConfiguredProvider(operation, serviceType, input, config, user) {
  assertUserCanUseModels(user);
  const apiKey = await getDecryptedApiKey(user.id, input.apiKeyId, config);
  if (!apiKey || apiKey.serviceType !== serviceType) throw httpError(400, '请选择对应服务的 API Key。');
  const policy = trustedApiPolicy(apiKey.channel, serviceType);
  const model = resolveConfiguredModel(policy, input.modelId || input.model);
  input = { ...input, model, modelId: model };
  for (const field of ['endpoint', 'baseUrl', 'baseURL', 'apiKey', 'headers', 'authType', 'module', 'modulePath', 'adapter']) delete input[field];
  assertTrustedApiModel(apiKey, model);
  const started = Date.now();
  let statusCode = 200;
  try {
    let result;
    if (policy.adapter === 'chat-completions') {
      if (operation !== 'llm') throw httpError(400, '当前适配器不支持此操作。');
      result = await requestChatCompletion(policy, apiKey.apiKey, input, config);
    } else {
      const adapter = await import(pathToFileURL(policy.modulePath).href);
      if (typeof adapter.execute !== 'function') throw httpError(503, '适配器必须导出 execute 函数。');
      // Endpoint, credential and model are overwritten after client fields.
      const timeoutMs = Math.min(Math.max(Number(config.modelProxy?.adapterTimeoutMs) || 120000, 1), 45 * 60 * 1000);
      const controller = new AbortController();
      const signal = input.signal instanceof AbortSignal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
      let timer;
      try {
        result = await Promise.race([
          adapter.execute({ operation, input: { ...input, endpoint: policy.endpoint, model, modelId: model },
            endpoint: policy.endpoint, model, apiKey: apiKey.apiKey, authType: policy.authType, signal }),
          new Promise((_, reject) => { timer = setTimeout(() => {
            const error = httpError(504, '适配器调用超时。');
            controller.abort(error);
            reject(error);
          }, timeoutMs); }),
        ]);
      } finally { clearTimeout(timer); }
    }
    validateAdapterResult(operation, result);
    if (operation === 'image') {
      result = { ...result, imageObjects: result.imageObjects || result.images.map(image => typeof image === 'string' ? { url: image } : image),
        images: result.images.map(image => typeof image === 'string' ? image : image.url) };
    }
    await recordUsageEvent(config, { userId: apiKey.billingUserId || user.id, apiKeyId: apiKey.id,
      provider: apiKey.channel, model, taskType: input.taskType || operation, status: 'success', units: 1 }).catch(() => console.warn('Usage metadata recording failed.'));
    return result;
  } catch (error) {
    statusCode = Number(error.status) || 502;
    // Do not expose supplier errors, response bodies, URLs or credentials.
    throw httpError(statusCode >= 400 && statusCode <= 599 ? statusCode : 502,
      statusCode === 504 ? '模型请求超时，请先查询任务状态，避免重复提交。' : statusCode === 429 ? '模型服务繁忙或达到调用限额。' : error.code === 'CONTENT_REJECTED' ? '内容审核未通过。' : '模型服务请求失败，请检查服务端适配器配置。',
      { network: !Number(error.status), submissionUncertain: !Number(error.status) });
  } finally {
    await recordBackendRequestLog(config, { user, endpointPath: `/api/tools/${operation}`, method: 'POST',
      statusCode, provider: apiKey.channel, model, taskType: input.taskType || operation,
      durationMs: Date.now() - started, requestSummary: { operation },
      errorMessage: statusCode >= 400 ? 'Configured provider request failed' : '' }).catch(() => console.warn('Request metadata recording failed.'));
  }
}

export async function requestChatCompletion(policy, secret, input, config = {}) {
  if (!Array.isArray(input.messages) || !input.messages.length) throw httpError(400, '缺少对话内容。');
  const model = String(input.modelId || input.model || '').trim();
  if (!policy.models.includes(model)) throw httpError(400, '当前渠道不支持该模型。');
  const timeoutMs = Math.min(Math.max(Number(config.modelProxy?.llmTimeoutMs) || 120000, 1000), 45 * 60 * 1000);
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (policy.authType === 'x-api-key') headers['x-api-key'] = secret;
  else headers.Authorization = `Bearer ${secret}`;
  const body = { model, messages: input.messages, stream: false };
  if (Number.isFinite(input.temperature)) body.temperature = input.temperature;
  const maxTokens = input.max_tokens ?? input.maxOutputTokens;
  if (Number.isInteger(maxTokens) && maxTokens > 0) body.max_tokens = maxTokens;
  const response = await fetch(`${policy.endpoint.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw httpError(response.status >= 400 && response.status < 500 ? response.status : 502, '模型服务返回失败。');
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw httpError(502, '模型服务没有返回文本。');
  return { data, content, rawFields: Object.keys(data) };
}

export function resolveConfiguredModel(policy, requested) {
  if (!policy) throw httpError(503, '此渠道尚未由站点管理员启用');
  const value = String(requested || policy.models[0] || '').trim();
  if (policy.models.includes(value)) return value;
  const prefix = `${policy.channel}::`;
  if (value.startsWith(prefix) && policy.models.includes(value.slice(prefix.length))) return value.slice(prefix.length);
  throw httpError(400, '当前渠道不支持该模型。');
}

export function validateAdapterResult(operation, result) {
  const text = value => typeof value === 'string' && value.trim().length > 0;
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw httpError(502, '适配器返回格式不正确。');
  const valid = {
    llm: () => text(result.content),
    image: () => Array.isArray(result.images) && result.images.length > 0 && result.images.every(image => text(image) || text(image?.url)),
    audio: () => text(result.audioUrl) || text(result.audioDataUrl),
    transcribe: () => typeof result.text === 'string' || Array.isArray(result.segments) || Array.isArray(result.tokens),
    'video-create': () => text(result.taskId) || text(result.videoUrl),
    'video-query': () => text(result.status),
    draft: () => [result.draft_url, result.draftUrl, result.url].some(text),
  }[operation];
  if (!valid || !valid()) throw httpError(502, '适配器缺少此操作需要的结果字段。');
  return result;
}
