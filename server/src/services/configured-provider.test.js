import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { normalizeProviderDefinitions, validateProviderEndpoint } from './provider-config.js';
import { publicProviderCatalog } from './trusted-api-registry.js';
import { resolveConfiguredModel, executeConfiguredProvider } from './configured-provider-runner.js';
import { saveApiKey } from './api-key-store.js';
import { ensureUser } from './user-store.js';

test('configuration rejects unsafe endpoint forms and invalid service/model definitions', () => {
  for (const endpoint of ['http://api.example.com', 'https://127.0.0.1', 'https://[::1]', 'https://localhost', 'https://api.internal', 'https://user:password@api.example.com', 'https://api.example.com?token=x', 'https://api.example.com/#x']) {
    assert.throws(() => validateProviderEndpoint(endpoint));
  }
  const service = { endpoint: 'https://api.example.com/v1', models: ['m'] };
  assert.throws(() => normalizeProviderDefinitions([{ channel: 'one', services: { image: service } }]));
  assert.throws(() => normalizeProviderDefinitions([{ channel: 'one', services: { llm: { ...service, models: ['m', 'm'] } } }]));
  assert.throws(() => normalizeProviderDefinitions([{ channel: 'one', services: { video: { ...service, adapter: 'module' } } }]));
});

test('selection resolves only exact configured model IDs and channel-scoped UI IDs', () => {
  const policy = { channel: 'Example', models: ['one', 'native::id'] };
  assert.equal(resolveConfiguredModel(policy), 'one');
  assert.equal(resolveConfiguredModel(policy, 'Example::one'), 'one');
  assert.equal(resolveConfiguredModel(policy, 'native::id'), 'native::id');
  assert.throws(() => resolveConfiguredModel(policy, 'Other::one'));
  assert.throws(() => resolveConfiguredModel(policy, 'unconfigured'));
});

test('configured channel enforces backend policy, blocks unknown models, and keeps content out of logs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'configured-provider-test-'));
  const filename = join(dir, 'providers.json');
  await writeFile(filename, JSON.stringify([{ channel: 'Synthetic', services: {
    llm: { endpoint: 'https://api.example.com/v1', models: ['test-model'], authType: 'x-api-key' },
  } }]));
  const previousConfig = process.env.WORKFLOW_PROVIDER_CONFIG;
  const originalFetch = globalThis.fetch;
  process.env.WORKFLOW_PROVIDER_CONFIG = filename;
  const config = { env: 'test', dataDir: dir, apiKeyEncryptionKey: randomBytes(32).toString('base64'), store: { driver: 'json' } };
  const user = ensureUser(config, { id: 'synthetic-user', email: 'synthetic@example.invalid', displayName: 'Synthetic' });
  const secret = randomBytes(32).toString('hex');
  const prompt = 'private-prompt-must-not-appear-in-logs';
  let calls = 0;
  try {
    const key = await saveApiKey(user, { id: 'synthetic-key', serviceType: 'llm', channel: 'Synthetic', apiKey: secret,
      endpoint: 'https://untrusted.example.com', model: 'untrusted', authType: 'Bearer' }, config);
    assert.equal(key.endpoint, 'https://api.example.com/v1');
    const catalog = JSON.stringify(publicProviderCatalog());
    assert.ok(!catalog.includes('endpoint') && !catalog.includes(secret));
    globalThis.fetch = async (url, options) => {
      calls += 1;
      assert.equal(url, 'https://api.example.com/v1/chat/completions');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers['x-api-key'], secret);
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'test-model');
      assert.equal(body.max_tokens, 1234);
      assert.equal(body.messages[0].content, prompt);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'synthetic-result' } }] }));
    };
    const input = { apiKeyId: key.id, model: 'Synthetic::test-model', endpoint: 'https://untrusted.example.com',
      messages: [{ role: 'user', content: prompt }], maxOutputTokens: 1234 };
    assert.equal((await executeConfiguredProvider('llm', 'llm', input, config, user)).content, 'synthetic-result');
    await assert.rejects(executeConfiguredProvider('llm', 'llm', { ...input, model: 'unknown' }, config, user), error => error.status === 400);
    await assert.rejects(executeConfiguredProvider('image', 'image', input, config, user), error => error.status === 400);
    assert.equal(calls, 1);
    globalThis.fetch = async () => { throw new Error(`${secret} ${prompt}`); };
    await assert.rejects(executeConfiguredProvider('llm', 'llm', input, config, user), error => !error.message.includes(secret) && !error.message.includes(prompt));
    const persisted = await readFile(join(dir, 'flowstudio-store.json'), 'utf8');
    assert.ok(!persisted.includes(secret));
    assert.ok(!persisted.includes(prompt));
    assert.ok(!persisted.includes('synthetic-result'));
  } finally {
    globalThis.fetch = originalFetch;
    if (previousConfig === undefined) delete process.env.WORKFLOW_PROVIDER_CONFIG;
    else process.env.WORKFLOW_PROVIDER_CONFIG = previousConfig;
  }
});

test('module adapters receive only backend-owned credentials and routing fields', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'configured-module-test-'));
  const moduleFile = join(dir, 'adapter.mjs');
  await writeFile(moduleFile, `export async function execute(ctx) {
    if (ctx.endpoint !== 'https://adapter.example.com' || ctx.input.endpoint !== ctx.endpoint || ctx.model !== 'image-model') throw Error('wrong routing');
    if (ctx.input.apiKey || ctx.input.headers || ctx.input.modulePath || ctx.input.baseURL) throw Error('untrusted authentication fields');
    if (!ctx.apiKey || !ctx.signal) throw Error('missing server context');
    return {images:[{url:'https://assets.example.com/generated.png'}]};
  }`);
  const filename = join(dir, 'providers.json');
  await writeFile(filename, JSON.stringify([{ channel: 'Adapter Test', services: { image: {
    endpoint: 'https://adapter.example.com', adapter: 'module', module: './adapter.mjs', models: ['image-model'],
  } } }]));
  const previous = process.env.WORKFLOW_PROVIDER_CONFIG;
  process.env.WORKFLOW_PROVIDER_CONFIG = filename;
  try {
    const config = { env: 'test', dataDir: dir, apiKeyEncryptionKey: randomBytes(32).toString('base64'), store: { driver: 'json' } };
    const user = ensureUser(config, { id: 'adapter-user', email: 'adapter@example.invalid' });
    const key = await saveApiKey(user, { serviceType: 'image', channel: 'Adapter Test', apiKey: randomBytes(32).toString('hex') }, config);
    const result = await executeConfiguredProvider('image', 'image', { apiKeyId: key.id, modelId: 'Adapter Test::image-model',
      apiKey: 'attacker', headers: { Authorization: 'attacker' }, endpoint: 'https://attacker.example.com', modulePath: '/tmp/attacker.mjs', baseURL: 'https://attacker.example.com' }, config, user);
    assert.equal(result.images.length, 1);
    assert.ok(!JSON.stringify(publicProviderCatalog()).includes(moduleFile));
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_PROVIDER_CONFIG;
    else process.env.WORKFLOW_PROVIDER_CONFIG = previous;
  }
});

test('adapter timeout returns an uncertain submission even when a module ignores cancellation', async()=>{
  const dir=await mkdtemp(join(tmpdir(),'adapter-timeout-'));
  await writeFile(join(dir,'hang.mjs'),'export async function execute(){return new Promise(()=>{});}');
  const file=join(dir,'providers.json');
  await writeFile(file,JSON.stringify([{channel:'Timeout Test',services:{image:{endpoint:'https://adapter.example.com',adapter:'module',module:'./hang.mjs',models:['image']}}}]));
  const previous=process.env.WORKFLOW_PROVIDER_CONFIG;
  process.env.WORKFLOW_PROVIDER_CONFIG=file;
  try{
    const config={env:'test',dataDir:dir,apiKeyEncryptionKey:randomBytes(32).toString('base64'),store:{driver:'json'},modelProxy:{adapterTimeoutMs:10}};
    const user=ensureUser(config,{id:'timeout',email:'timeout@example.invalid'});
    const key=await saveApiKey(user,{serviceType:'image',channel:'Timeout Test',apiKey:'synthetic-secret'},config);
    await assert.rejects(executeConfiguredProvider('image','image',{apiKeyId:key.id},config,user),error=>error.status===504&&/超时/.test(error.message));
  }finally{if(previous===undefined)delete process.env.WORKFLOW_PROVIDER_CONFIG;else process.env.WORKFLOW_PROVIDER_CONFIG=previous;}
});
