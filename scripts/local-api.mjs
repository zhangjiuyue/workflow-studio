import { assertDeploymentConfig } from '../server/src/security/deployment-config.js';
// Local single-process runner: JSON storage has an in-process cache and must not
// be shared by separate API/worker processes. Production deployments use PostgreSQL.
import http from 'node:http';
import { createApp } from '../server/src/app.js';
import { loadConfig } from '../server/src/config.js';
import { startWorkflowNodeWorker } from '../server/src/jobs/workflow-node-worker.js';
import { startWorkflowVideoSubmissionWorker } from '../server/src/jobs/workflow-video-submit-queue.js';
import { startRoleAssetImageGenerationWorker } from '../server/src/jobs/asset-role-image-queue.js';
import { startScriptAssetVideoAnalysisWorker } from '../server/src/jobs/asset-video-analysis-queue.js';
import { startWritingStyleAnalysisWorker } from '../server/src/jobs/asset-writing-style-analysis-queue.js';
const config = loadConfig();
assertDeploymentConfig(config);
if (config.env !== 'production' || config.host !== '127.0.0.1' || !config.sessionSecret || !config.apiKeyEncryptionKey || !config.bootstrapAdmin.password) {
  throw new Error('Use npm run local:setup and npm run local:start; local runner requires loopback binding and generated credentials.');
}
const server = http.createServer(createApp(config));
const workers = [startWorkflowNodeWorker, startWorkflowVideoSubmissionWorker, startRoleAssetImageGenerationWorker,
  startScriptAssetVideoAnalysisWorker, startWritingStyleAnalysisWorker].map(start => start(config));
server.listen(config.port, config.host, () => console.log(`Local API and five workers: http://${config.host}:${config.port}`));
function stop() { workers.forEach(worker => worker.stop()); server.close(() => process.exit(0)); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
