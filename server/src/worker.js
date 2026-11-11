import { assertDeploymentConfig } from './security/deployment-config.js';
import { loadConfig } from "./config.js";
import { startRoleAssetImageGenerationWorker } from "./jobs/asset-role-image-queue.js";
import { startScriptAssetVideoAnalysisWorker } from "./jobs/asset-video-analysis-queue.js";
import { startWritingStyleAnalysisWorker } from "./jobs/asset-writing-style-analysis-queue.js";
import { startWorkflowNodeWorker } from "./jobs/workflow-node-worker.js";
import { startWorkflowVideoSubmissionWorker } from "./jobs/workflow-video-submit-queue.js";

const config = loadConfig();
assertDeploymentConfig(config, { separateWorker: true });
startWorkflowNodeWorker(config, {
  pollMs: config.worker?.pollMs,
  batchSize: config.worker?.batchSize,
});
startScriptAssetVideoAnalysisWorker(config, {
  pollMs: config.worker?.pollMs,
  batchSize: config.worker?.batchSize,
});
startWritingStyleAnalysisWorker(config, {
  pollMs: config.worker?.pollMs,
  batchSize: config.worker?.batchSize,
});
startRoleAssetImageGenerationWorker(config, {
  pollMs: config.worker?.pollMs,
  batchSize: config.worker?.batchSize,
});
startWorkflowVideoSubmissionWorker(config, {
  pollMs: config.worker?.pollMs,
  batchSize: config.worker?.videoSubmissionBatchSize,
});

console.log(`Workflow Studio worker listening for queued workflow, video submission, and asset jobs every ${config.worker?.pollMs || 1500}ms`);
