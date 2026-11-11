import { assertDeploymentConfig } from './security/deployment-config.js';
import http from "node:http";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { startWorkflowNodeWorker } from "./jobs/workflow-node-worker.js";
import { startWorkflowVideoSubmissionWorker } from "./jobs/workflow-video-submit-queue.js";

const config = loadConfig();
assertDeploymentConfig(config);
const app = createApp(config);

const server = http.createServer(app);
const shouldStartEmbeddedWorker = config.worker?.enabled && config.env !== "production";
const workers = shouldStartEmbeddedWorker
  ? [startWorkflowNodeWorker(config), startWorkflowVideoSubmissionWorker(config)]
  : [];

server.listen(config.port, config.host, () => {
  console.log(`Workflow Studio server listening on http://${config.host}:${config.port}`);
  if (workers.length) console.log("Workflow Studio workflow and video submission workers started");
});
