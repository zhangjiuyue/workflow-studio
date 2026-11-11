import crypto from "node:crypto";
import { httpError } from "../http.js";
import { readStore, writeStore, getStoreDriver } from "../storage/store.js";
import {
  claimQueuedJobPg,
  createOrReuseActiveJobPg,
  getJobPg,
  listStaleRunningJobsPg,
  listJobsPg,
  listQueuedJobsPg,
  requeueInterruptedJobsPg,
  updateJobIfStatusPg,
  updateJobPg,
  upsertJobPg,
} from "../storage/postgres-repositories.js";

const allowedStatuses = new Set(["queued", "running", "done", "error", "canceled"]);
const allowedKinds = new Set(["workflow-node", "tool", "system"]);
const allowedScopes = new Set(["workflow", "llm", "image", "video", "audio", "asset", "other"]);

export async function listJobs(userId, config, filters = {}) {
  if (isPostgresStore(config)) return (await listJobsPg(config, userId, filters)).map(publicJob);
  const store = readStore(config);
  return store.jobs
    .filter((job) => job.userId === userId)
    .filter((job) => !filters.status || job.status === filters.status)
    .filter((job) => !filters.kind || job.kind === filters.kind)
    .filter((job) => !filters.scope || job.scope === filters.scope)
    .filter((job) => !filters.workflowId || job.workflowId === filters.workflowId)
    .filter((job) => !filters.runId || job.runId === filters.runId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map(publicJob);
}

export async function listRunnableJobs(config, filters = {}) {
  if (isPostgresStore(config)) return (await listQueuedJobsPg(config, filters)).map(publicJob);
  const store = readStore(config);
  return store.jobs
    .filter((job) => job.status === "queued")
    .filter((job) => !filters.kind || job.kind === filters.kind)
    .filter((job) => !filters.scope || job.scope === filters.scope)
    .filter((job) => !filters.nodeId || job.nodeId === filters.nodeId)
    .sort((left, right) => {
      const priority = Number(right.priority || 0) - Number(left.priority || 0);
      return priority || String(left.queuedAt || left.createdAt).localeCompare(String(right.queuedAt || right.createdAt));
    })
    .slice(0, Math.max(1, Number(filters.limit || 10)))
    .map(publicJob);
}

export async function listStaleRunningJobs(config, filters = {}) {
  if (isPostgresStore(config)) return (await listStaleRunningJobsPg(config, filters)).map(publicJob);
  const store = readStore(config);
  const before = filters.before ? new Date(filters.before).getTime() : 0;
  return store.jobs
    .filter((job) => job.status === "running" && !job.completedAt)
    .filter((job) => !filters.kind || job.kind === filters.kind)
    .filter((job) => !filters.scope || job.scope === filters.scope)
    .filter((job) => !filters.nodeId || job.nodeId === filters.nodeId)
    .filter((job) => !before || new Date(job.result?.heartbeatAt || job.startedAt || job.updatedAt || job.createdAt || 0).getTime() < before)
    .sort((left, right) => String(left.result?.heartbeatAt || left.startedAt || left.updatedAt || left.createdAt).localeCompare(String(right.result?.heartbeatAt || right.startedAt || right.updatedAt || right.createdAt)))
    .slice(0, Math.max(1, Number(filters.limit || 50)))
    .map(publicJob);
}

export async function createJob(user, input, config) {
  const job = createJobRecord(user, input);
  if (isPostgresStore(config)) return publicJob(await upsertJobPg(config, job));
  const store = readStore(config);
  store.jobs.unshift(job);
  writeStore(config, store);
  return publicJob(job);
}

export async function createOrReuseActiveJob(user, input, config) {
  const job = createJobRecord(user, input);
  if (isPostgresStore(config)) {
    const result = await createOrReuseActiveJobPg(config, job);
    return { job: publicJob(result.job), reused: Boolean(result.reused) };
  }
  const store = readStore(config);
  const existing = store.jobs
    .filter((item) => item.userId === job.userId)
    .filter((item) => item.runId === job.runId)
    .filter((item) => item.nodeId === job.nodeId)
    .filter((item) => item.kind === job.kind)
    .filter((item) => ["queued", "running"].includes(item.status))
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0];
  if (existing) return { job: publicJob(existing), reused: true };
  store.jobs.unshift(job);
  writeStore(config, store);
  return { job: publicJob(job), reused: false };
}

export async function getJob(userId, jobId, config) {
  if (isPostgresStore(config)) {
    const job = await getJobPg(config, jobId, userId);
    if (!job) throw httpError(404, "任务记录不存在。");
    return publicJob(job);
  }
  const store = readStore(config);
  return publicJob(findJob(store, userId, jobId));
}

export async function getJobInternal(jobId, config) {
  if (isPostgresStore(config)) {
    const job = await getJobPg(config, jobId);
    if (!job) throw httpError(404, "任务记录不存在。");
    return publicJob(job);
  }
  const store = readStore(config);
  const job = store.jobs.find((item) => item.id === jobId);
  if (!job) throw httpError(404, "任务记录不存在。");
  return publicJob(job);
}

export async function claimQueuedJob(jobId, config) {
  if (isPostgresStore(config)) return claimQueuedJobPg(config, jobId);
  const store = readStore(config);
  const job = store.jobs.find((item) => item.id === jobId);
  if (!job) throw httpError(404, "任务记录不存在。");
  if (job.status !== "queued") return null;
  const now = new Date().toISOString();
  job.status = "running";
  job.startedAt = now;
  job.updatedAt = now;
  writeStore(config, store);
  return publicJob(job);
}

export async function requeueInterruptedJobs(config, filters = {}) {
  if (isPostgresStore(config)) return (await requeueInterruptedJobsPg(config, filters)).map(publicJob);
  const store = readStore(config);
  const now = new Date().toISOString();
  const jobs = store.jobs.filter((job) =>
    job.status === "running" &&
    !job.completedAt &&
    (!filters.kind || job.kind === filters.kind) &&
    (!filters.scope || job.scope === filters.scope) &&
    (!filters.nodeId || job.nodeId === filters.nodeId) &&
    !(filters.excludeNodeIds || []).includes(job.nodeId));
  jobs.forEach((job) => {
    job.status = "queued";
    job.attempts = normalizeNumber(job.attempts, 0) + 1;
    job.error = job.error || "服务重启后自动重新排队。";
    job.queuedAt = now;
    job.startedAt = "";
    job.updatedAt = now;
  });
  if (jobs.length) writeStore(config, store);
  return jobs.map(publicJob);
}

export async function updateJob(userId, jobId, input, config) {
  if (isPostgresStore(config)) {
    const existing = await getJobPg(config, jobId, userId);
    if (!existing) throw httpError(404, "任务记录不存在。");
    const updated = await updateJobPg(config, jobId, input);
    return publicJob(updated);
  }
  const store = readStore(config);
  const job = findJob(store, userId, jobId);
  applyJobUpdate(job, input);
  writeStore(config, store);
  return publicJob(job);
}

export async function updateJobInternal(jobId, input, config) {
  if (isPostgresStore(config)) {
    const updated = await updateJobPg(config, jobId, input);
    if (!updated) throw httpError(404, "任务记录不存在。");
    return publicJob(updated);
  }
  const store = readStore(config);
  const job = store.jobs.find((item) => item.id === jobId);
  if (!job) throw httpError(404, "任务记录不存在。");
  applyJobUpdate(job, input);
  writeStore(config, store);
  return publicJob(job);
}

export async function updateJobIfStatus(jobId, expectedStatuses, input, config) {
  const statuses = [...new Set((Array.isArray(expectedStatuses) ? expectedStatuses : [expectedStatuses])
    .map((status) => String(status || "").trim())
    .filter(Boolean))];
  if (!statuses.length) return null;
  if (isPostgresStore(config)) {
    const updated = await updateJobIfStatusPg(config, jobId, statuses, input);
    return updated ? publicJob(updated) : null;
  }
  const store = readStore(config);
  const job = store.jobs.find((item) => item.id === jobId);
  if (!job || !statuses.includes(job.status)) return null;
  applyJobUpdate(job, input);
  writeStore(config, store);
  return publicJob(job);
}

export async function cancelJob(userId, jobId, config) {
  return updateJob(userId, jobId, { status: "canceled" }, config);
}

function createJobRecord(user, input) {
  const now = new Date().toISOString();
  const status = normalizeStatus(input.status || "queued");
  return {
    id: normalizeId(input.id) || crypto.randomUUID(),
    userId: user.id,
    kind: normalizeKind(input.kind || "workflow-node"),
    scope: normalizeScope(input.scope || "workflow"),
    workflowId: normalizeId(input.workflowId),
    runId: normalizeId(input.runId),
    nodeId: normalizeId(input.nodeId),
    title: String(input.title || "").trim(),
    status,
    priority: normalizeNumber(input.priority, 0),
    attempts: normalizeNumber(input.attempts, 0),
    progress: normalizeNumber(input.progress, 0),
    payload: normalizeObject(input.payload),
    result: normalizeObject(input.result),
    error: String(input.error || ""),
    queuedAt: input.queuedAt || now,
    startedAt: input.startedAt || (status === "running" ? now : ""),
    completedAt: input.completedAt || (["done", "error", "canceled"].includes(status) ? now : ""),
    createdAt: input.createdAt || now,
    updatedAt: now,
  };
}

function applyJobUpdate(job, input) {
  const now = new Date().toISOString();
  if (input.kind !== undefined) job.kind = normalizeKind(input.kind);
  if (input.scope !== undefined) job.scope = normalizeScope(input.scope);
  if (input.workflowId !== undefined) job.workflowId = normalizeId(input.workflowId);
  if (input.runId !== undefined) job.runId = normalizeId(input.runId);
  if (input.nodeId !== undefined) job.nodeId = normalizeId(input.nodeId);
  if (input.title !== undefined) job.title = String(input.title || "").trim();
  if (input.priority !== undefined) job.priority = normalizeNumber(input.priority, job.priority || 0);
  if (input.attempts !== undefined) job.attempts = normalizeNumber(input.attempts, job.attempts || 0);
  if (input.progress !== undefined) job.progress = normalizeNumber(input.progress, job.progress || 0);
  if (input.payload !== undefined) job.payload = normalizeObject(input.payload);
  if (input.result !== undefined) job.result = normalizeObject(input.result);
  if (input.error !== undefined) job.error = String(input.error || "");
  if (input.status !== undefined) {
    const previousStatus = job.status;
    job.status = normalizeStatus(input.status);
    if (job.status === "running" && previousStatus !== "running") job.startedAt = now;
    if (["done", "error", "canceled"].includes(job.status)) job.completedAt = now;
    if (job.status === "queued") {
      job.queuedAt = now;
      job.startedAt = "";
      job.completedAt = "";
    }
  }
  job.updatedAt = now;
}

function findJob(store, userId, jobId) {
  const job = store.jobs.find((item) => item.id === jobId && item.userId === userId);
  if (!job) throw httpError(404, "任务记录不存在。");
  return job;
}

function publicJob(job) {
  return { ...job };
}

function normalizeStatus(value) {
  const status = String(value || "").trim();
  if (!allowedStatuses.has(status)) throw httpError(400, "任务状态无效。");
  return status;
}

function normalizeKind(value) {
  const kind = String(value || "").trim();
  if (!allowedKinds.has(kind)) throw httpError(400, "任务类型无效。");
  return kind;
}

function normalizeScope(value) {
  const scope = String(value || "").trim();
  if (!allowedScopes.has(scope)) throw httpError(400, "任务范围无效。");
  return scope;
}

function normalizeId(value) {
  return String(value || "").trim();
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function isPostgresStore(config) {
  return getStoreDriver(config) === "postgres";
}
