import { runWithUserConcurrency } from "./queue.js";
import { claimQueuedJob, createJob, getJobInternal, listRunnableJobs, listStaleRunningJobs, updateJobInternal } from "../services/job-store.js";
import { executeScriptAssetVideoAnalysisJob, markScriptAssetVideoAnalysisError } from "../services/script-asset-video-analysis-runner.js";
import { getUserById } from "../services/user-store.js";

const scriptAssetVideoAnalysisNodeId = "script-video-analysis";
const defaultAssetVideoAnalysisTimeoutMs = 75 * 60 * 1000;

export async function enqueueScriptAssetVideoAnalysisJob(user, input = {}, config = {}) {
  return await createJob(user, {
    kind: "tool",
    scope: "asset",
    nodeId: scriptAssetVideoAnalysisNodeId,
    title: "脚本库视频解析",
    status: "queued",
    progress: 0,
    payload: normalizePayload(input),
  }, config);
}

export async function listQueuedScriptAssetVideoAnalysisJobs(config, limit = 10) {
  const jobs = await listRunnableJobs(config, {
    kind: "tool",
    scope: "asset",
    limit: Math.max(1, Number(limit || 10)) * 3,
  });
  return jobs
    .filter((job) => job.nodeId === scriptAssetVideoAnalysisNodeId)
    .slice(0, Math.max(1, Number(limit || 10)));
}

export async function expireStaleScriptAssetVideoAnalysisJobs(config, options = {}) {
  const excludeIds = new Set((options.excludeIds || []).map(normalizeId).filter(Boolean));
  const timeoutMs = scriptAssetVideoAnalysisTimeoutMs(config);
  const before = new Date(Date.now() - timeoutMs).toISOString();
  const jobs = await listStaleRunningJobs(config, {
    kind: "tool",
    scope: "asset",
    nodeId: scriptAssetVideoAnalysisNodeId,
    before,
    limit: 50,
  });
  const expired = [];
  for (const job of jobs) {
    if (excludeIds.has(job.id)) continue;
    const message = "脚本视频解析超时，已自动标记失败。";
    const failedJob = await updateJobInternal(job.id, {
      status: "error",
      error: message,
    }, config).catch(() => null);
    const user = await getUserById(config, job.userId).catch(() => null);
    if (user) await markScriptAssetVideoAnalysisError(user, job.payload || {}, config, message).catch(() => null);
    expired.push(failedJob || job);
  }
  return expired;
}

export async function processNextScriptAssetVideoAnalysisJob(config) {
  const jobs = await listQueuedScriptAssetVideoAnalysisJobs(config, 1);
  const job = jobs[0];
  if (!job) return null;
  await processScriptAssetVideoAnalysisJobById(job.id, config);
  return job.id;
}

export async function processScriptAssetVideoAnalysisJobById(jobId, config = {}) {
  const claimed = await claimQueuedJob(jobId, config);
  if (!claimed) return null;
  let user;
  try {
    user = await getUserById(config, claimed.userId);
  } catch (error) {
    await updateJobInternal(claimed.id, {
      status: "error",
      error: error.message || "后台脚本解析无法读取用户信息。",
    }, config);
    throw error;
  }
  await processScriptAssetVideoAnalysisJob(user, claimed, config);
  return await getJobInternal(jobId, config);
}

export function startScriptAssetVideoAnalysisWorker(config, options = {}) {
  const pollMs = Math.max(500, Number(options.pollMs || config.worker?.pollMs || 1500));
  const batchSize = Math.max(1, Number(options.batchSize || config.worker?.batchSize || 8));
  const activeJobIds = new Set();
  let stopped = false;
  let timer = null;

  async function tick() {
    if (stopped) return;
    try {
      await expireStaleScriptAssetVideoAnalysisJobs(config, { excludeIds: [...activeJobIds] });
      const available = Math.max(0, batchSize - activeJobIds.size);
      if (available > 0) {
        const jobs = await listQueuedScriptAssetVideoAnalysisJobs(config, available);
        jobs.forEach((job) => {
          if (activeJobIds.has(job.id)) return;
          activeJobIds.add(job.id);
          processScriptAssetVideoAnalysisJobById(job.id, config)
            .catch((error) => {
              console.error(`[asset-video-worker] job ${job.id} failed:`, error.message || error);
            })
            .finally(() => {
              activeJobIds.delete(job.id);
            });
        });
      }
    } catch (error) {
      console.error("[asset-video-worker] polling failed:", error.message || error);
    } finally {
      if (!stopped) timer = setTimeout(tick, pollMs);
    }
  }

  timer = setTimeout(tick, 0);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    activeCount() {
      return activeJobIds.size;
    },
  };
}

async function processScriptAssetVideoAnalysisJob(user, job, config = {}) {
  try {
    const result = await runWithUserConcurrency(user, "llm", () =>
      executeScriptAssetVideoAnalysisJob(user, job.payload || {}, config));
    await updateJobInternal(job.id, {
      status: "done",
      progress: 100,
      result: {
        assetId: result?.asset?.id || job.payload?.assetId || "",
        updatedAt: result?.asset?.updatedAt || new Date().toISOString(),
      },
      error: "",
    }, config);
  } catch (error) {
    const message = error.message || "后台脚本解析失败。";
    await markScriptAssetVideoAnalysisError(user, job.payload || {}, config, message).catch(() => null);
    await updateJobInternal(job.id, {
      status: "error",
      error: message,
    }, config);
    throw error;
  }
}

function scriptAssetVideoAnalysisTimeoutMs(config = {}) {
  const timeoutMs = Number(config.worker?.llmNodeTimeoutMs || 0);
  return Math.max(defaultAssetVideoAnalysisTimeoutMs, timeoutMs);
}

function normalizePayload(input = {}) {
  const payload = input && typeof input === "object" ? input : {};
  return {
    assetId: normalizeId(payload.assetId || payload.id),
    name: normalizeText(payload.name),
    groupId: normalizeId(payload.groupId),
    llmKeyId: normalizeId(payload.llmKeyId),
    modelId: normalizeText(payload.modelId),
    roleCountMode: payload.roleCountMode === "custom" ? "custom" : "auto",
    roleCount: Math.max(1, Math.min(20, Number(payload.roleCount || 1))),
    targetDurationMode: payload.targetDurationMode === "custom" ? "custom" : "source",
    targetDurationSeconds: Math.max(0, Math.round(Number(payload.targetDurationSeconds || 0))),
    sourceFile: payload.sourceFile && typeof payload.sourceFile === "object" ? payload.sourceFile : null,
    createdAt: normalizeText(payload.createdAt),
    analysisStartedAt: normalizeText(payload.analysisStartedAt),
    analysisTimeoutMs: Math.max(0, Math.round(Number(payload.analysisTimeoutMs || 0))),
    publicApiBaseUrl: normalizeText(payload.publicApiBaseUrl),
  };
}

function normalizeText(value = "") {
  return String(value || "").trim();
}

function normalizeId(value = "") {
  return normalizeText(value);
}
