import { saveGeneratedObject } from '../server/src/storage/object-storage.js';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createApp } from '../server/src/app.js';
import { loadConfig } from '../server/src/config.js';
import { startWorkflowNodeWorker } from '../server/src/jobs/workflow-node-worker.js';
import { startWorkflowVideoSubmissionWorker } from '../server/src/jobs/workflow-video-submit-queue.js';
import { startRoleAssetImageGenerationWorker } from '../server/src/jobs/asset-role-image-queue.js';
import { startScriptAssetVideoAnalysisWorker } from '../server/src/jobs/asset-video-analysis-queue.js';
import { startWritingStyleAnalysisWorker } from '../server/src/jobs/asset-writing-style-analysis-queue.js';
const dataDir = await mkdtemp(join(tmpdir(), 'workflow-clean-smoke-'));
const password = randomBytes(24).toString('hex');
const config = { ...loadConfig(), env: 'production', host: '127.0.0.1', databaseUrl: '', dataDir,
  store: { driver: 'json' }, storage: { provider: 'local' },
  sessionSecret: randomBytes(32).toString('hex'), apiKeyEncryptionKey: randomBytes(32).toString('base64'),
  bootstrapAdmin: { email: 'first@example.invalid', password }, appOrigin: 'http://127.0.0.1:13000', appOrigins: ['http://127.0.0.1:13000'] };
const server = http.createServer(createApp(config));
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const base = `http://127.0.0.1:${server.address().port}`;
const workers = [startWorkflowNodeWorker, startWorkflowVideoSubmissionWorker, startRoleAssetImageGenerationWorker,
  startScriptAssetVideoAnalysisWorker, startWritingStyleAnalysisWorker].map(start => start(config, { pollMs: 100 }));
async function call(path, { method = 'GET', token, body, headers = {} } = {}) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
  return { status: response.status, data: await response.json() };
}
try {
  assert.equal((await call('/health')).status, 200);
  assert.equal((await call('/api/workflows')).status, 401);
  assert.equal((await call('/api/workflows', { headers: { 'X-FlowStudio-User-Id': 'dev-user' } })).status, 401);
  const first = await call('/api/auth/login', { method: 'POST', body: { email: config.bootstrapAdmin.email, password } });
  assert.equal(first.status, 200); const token = first.data.token; assert.ok(token);
  assert.equal((await call('/api/auth/me', { token })).status, 200);
  const asset = await call('/api/assets/prompt', { method: 'POST', token, body: { name: 'Synthetic smoke asset', payload: { prompt: 'Synthetic text only' } } });
  assert.equal(asset.status, 200);
  const workflow = await call('/api/workflows', { method: 'POST', token, body: { name: 'Synthetic smoke workflow', type: 'explain', config: {} } });
  assert.equal(workflow.status, 200);
  assert.equal((await call('/api/workflows', { token })).data.workflows.length, 1);
  config.bootstrapAdmin.email = 'second@example.invalid';
  const second = await call('/api/auth/login', { method: 'POST', body: { email: config.bootstrapAdmin.email, password } });
  assert.equal(second.status, 200);
  assert.equal((await call('/api/assets/prompt', { token: second.data.token })).data.assets.length, 0);
  assert.equal((await call('/api/workflows', { token: second.data.token })).data.workflows.length, 0);
  const syntheticImage = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const ownedFile = await saveGeneratedObject(config, first.data.user.id, {buffer: syntheticImage, filename:'synthetic.png',mimeType:'image/png'});
  const download = await fetch(base + '/api/tools/image-download', {method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({url:ownedFile.url})});
  assert.equal(download.status,200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()),syntheticImage);
  const otherDownload=await fetch(base + '/api/tools/image-download', {method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${second.data.token}`},body:JSON.stringify({url:ownedFile.url})});
  assert.notEqual(otherDownload.status,200);
  const marker = randomBytes(20).toString('hex');
  const unknown = await call('/api/api-keys', { method: 'POST', token, body: { serviceType: 'llm', channel: 'Unknown test channel', apiKey: marker, endpoint: 'https://example.invalid', model: 'test-model' } });
  assert.equal(unknown.status, 200);
  assert.ok(!(await readFile(join(dataDir, 'flowstudio-store.json'), 'utf8')).includes(marker));
  assert.ok(!JSON.stringify(unknown.data).includes(marker));
  const rejected = await call('/api/tools/llm', { method: 'POST', token, body: { apiKeyId: unknown.data.apiKey.id, model: 'test-model', messages: [{ role: 'user', content: 'test' }] } });
  assert.equal(rejected.status, 503);
  assert.equal((await call('/api/auth/logout', { method: 'POST', token })).status, 200);
  assert.equal((await call('/api/auth/me', { token })).status, 401);
  console.log(JSON.stringify({ passed: true, checks: ['health', 'unauthenticated denied', 'development identity spoof denied', 'admin bootstrap/login', 'asset save', 'workflow save', 'user isolation', 'owned local file download and cross-user denial', 'unknown channel secret discarded and call blocked', 'logout invalidation', 'five workers started'], data: 'temporary synthetic data only', outboundProviderCalls: 0 }));
} finally {
  workers.forEach(worker => worker.stop());
  await new Promise(resolve => server.close(resolve));
}
