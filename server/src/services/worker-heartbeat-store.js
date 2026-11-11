import { getStoreDriver, readStore, writeStore } from "../storage/store.js";
import { getWorkerHeartbeatPg, touchWorkerHeartbeatPg } from "../storage/postgres-repositories.js";

export const workflowWorkerHeartbeatName = "workflow-node-worker";

export async function touchWorkflowWorkerHeartbeat(config, metadata = {}) {
  const heartbeat = {
    name: workflowWorkerHeartbeatName,
    heartbeatAt: new Date().toISOString(),
    metadata: metadata && typeof metadata === "object" ? metadata : {},
  };
  if (getStoreDriver(config) === "postgres") return touchWorkerHeartbeatPg(config, heartbeat);
  const store = readStore(config);
  store.workerHeartbeats = store.workerHeartbeats && typeof store.workerHeartbeats === "object"
    ? store.workerHeartbeats
    : {};
  store.workerHeartbeats[heartbeat.name] = heartbeat;
  writeStore(config, store);
  return heartbeat;
}

export async function getWorkflowWorkerHeartbeat(config) {
  if (getStoreDriver(config) === "postgres") return getWorkerHeartbeatPg(config, workflowWorkerHeartbeatName);
  const store = readStore(config);
  return store.workerHeartbeats?.[workflowWorkerHeartbeatName] || null;
}

export async function workflowWorkerIsHealthy(config, nowMs = Date.now()) {
  const heartbeat = await getWorkflowWorkerHeartbeat(config).catch(() => null);
  if (!heartbeat?.heartbeatAt) return false;
  const heartbeatAt = new Date(heartbeat.heartbeatAt).getTime();
  const timeoutMs = Math.max(1000, Number(config.worker?.serviceHeartbeatTimeoutMs || 90 * 1000));
  return Number.isFinite(heartbeatAt) && nowMs - heartbeatAt < timeoutMs;
}
