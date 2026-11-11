import { runWithUserConcurrency } from "./queue.js";
import { claimQueuedJob, createJob, getJobInternal, listRunnableJobs, listStaleRunningJobs, updateJobInternal } from "../services/job-store.js";
import { executeRoleAssetImageGenerationJob, markRoleAssetImageGenerationError } from "../services/role-asset-image-runner.js";
import { getUserById } from "../services/user-store.js";
import { runActiveJobWithTimeout } from "./active-job-timeout.js";

const roleAssetImageGenerationNodeId = "role-image-generation";
const defaultRoleAssetImageGenerationTimeoutMs = 90 * 60 * 1000;

export async function enqueueRoleAssetImageGenerationJob(user, input = {}, config = {}) {
  return await createJob(user, {
    kind: "tool",
    scope: "asset",
    nodeId: roleAssetImageGenerationNodeId,
    title: "角色库图片生成",
    status: "queued",
    progress: 0,
    payload: normalizePayload(input),
  }, config);
}

export async function listQueuedRoleAssetImageGenerationJobs(config, limit = 10) {
  const jobs = await listRunnableJobs(config, {
    kind: "tool",
    scope: "asset",
    limit: Math.max(1, Number(limit || 10)) * 3,
  });
  return jobs
    .filter((job) => job.nodeId === roleAssetImageGenerationNodeId)
    .slice(0, Math.max(1, Number(limit || 10)));
}

export async function expireStaleRoleAssetImageGenerationJobs(config, options = {}) {
  const excludeIds = new Set((options.excludeIds || []).map(normalizeId).filter(Boolean));
  const timeoutMs = roleAssetImageGenerationTimeoutMs(config);
  const before = new Date(Date.now() - timeoutMs).toISOString();
  const jobs = await listStaleRunningJobs(config, {
    kind: "tool",
    scope: "asset",
    nodeId: roleAssetImageGenerationNodeId,
    before,
    limit: 50,
  });
  const expired = [];
  for (const job of jobs) {
    if (excludeIds.has(job.id)) continue;
    const message = "角色图片生成超时，已自动标记为部分失败。";
    const failedJob = await failRoleAssetImageGenerationJob(job, config, message);
    expired.push(failedJob || job);
  }
  return expired;
}

export async function failRoleAssetImageGenerationJob(job, config, message = "") {
  const failureMessage = message || "角色图片生成失败。";
  const failedJob = await updateJobInternal(job.id, {
    status: "error",
    error: failureMessage,
  }, config).catch(() => null);
  const user = await getUserById(config, job.userId).catch(() => null);
  if (user) {
    await markRoleAssetImageGenerationError(user, { ...(job.payload || {}), jobId: job.id }, config, failureMessage).catch(() => null);
  }
  return failedJob || {
    ...job,
    status: "error",
    error: failureMessage,
  };
}

export async function processNextRoleAssetImageGenerationJob(config) {
  const jobs = await listQueuedRoleAssetImageGenerationJobs(config, 1);
  const job = jobs[0];
  if (!job) return null;
  await processRoleAssetImageGenerationJobById(job.id, config);
  return job.id;
}

export async function processRoleAssetImageGenerationJobById(jobId, config = {}) {
  const claimed = await claimQueuedJob(jobId, config);
  if (!claimed) return null;
  let user;
  try {
    user = await getUserById(config, claimed.userId);
  } catch (error) {
    await updateJobInternal(claimed.id, {
      status: "error",
      error: error.message || "后台角色图片生成无法读取用户信息。",
    }, config);
    throw error;
  }
  const timeoutMs = roleAssetImageGenerationTimeoutMs(config);
  const timeoutMessage = "角色图片生成超时，已自动标记为部分失败。";
  await runActiveJobWithTimeout(() => processRoleAssetImageGenerationJob(user, claimed, config), {
    timeoutMs,
    message: timeoutMessage,
    onTimeout: () => failRoleAssetImageGenerationJob(claimed, config, timeoutMessage),
    onLateError: (error) => {
      console.warn(`[role-image-worker] job ${claimed.id} failed after timeout:`, error?.message || error);
    },
  });
  return await getJobInternal(jobId, config);
}

export function startRoleAssetImageGenerationWorker(config, options = {}) {
  const pollMs = Math.max(500, Number(options.pollMs || config.worker?.pollMs || 1500));
  const batchSize = Math.max(1, Number(options.batchSize || config.worker?.batchSize || 8));
  const activeJobIds = new Set();
  let stopped = false;
  let timer = null;

  async function tick() {
    if (stopped) return;
    try {
      await expireStaleRoleAssetImageGenerationJobs(config, { excludeIds: [...activeJobIds] });
      const available = Math.max(0, batchSize - activeJobIds.size);
      if (available > 0) {
        const jobs = await listQueuedRoleAssetImageGenerationJobs(config, available);
        jobs.forEach((job) => {
          if (activeJobIds.has(job.id)) return;
          activeJobIds.add(job.id);
          processRoleAssetImageGenerationJobById(job.id, config)
            .catch((error) => {
              console.error(`[role-image-worker] job ${job.id} failed:`, error.message || error);
            })
            .finally(() => {
              activeJobIds.delete(job.id);
            });
        });
      }
    } catch (error) {
      console.error("[role-image-worker] polling failed:", error.message || error);
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

async function processRoleAssetImageGenerationJob(user, job, config = {}) {
  try {
    const result = await runWithUserConcurrency(user, "image", () =>
      executeRoleAssetImageGenerationJob(user, { ...(job.payload || {}), jobId: job.id }, config));
    await updateJobInternal(job.id, {
      status: "done",
      progress: 100,
      result: {
        assetId: result?.asset?.id || job.payload?.assetId || "",
        completed: result?.completed || 0,
        total: result?.total || 0,
        failed: result?.failed || 0,
        updatedAt: result?.asset?.updatedAt || new Date().toISOString(),
      },
      error: "",
    }, config);
  } catch (error) {
    const message = error.message || "后台角色图片生成失败。";
    await markRoleAssetImageGenerationError(user, { ...(job.payload || {}), jobId: job.id }, config, message).catch(() => null);
    await updateJobInternal(job.id, {
      status: "error",
      error: message,
    }, config);
    throw error;
  }
}

function roleAssetImageGenerationTimeoutMs(config = {}) {
  const timeoutMs = Number(config.worker?.imageNodeTimeoutMs || config.worker?.llmNodeTimeoutMs || 0);
  return Math.max(defaultRoleAssetImageGenerationTimeoutMs, timeoutMs);
}

function normalizePayload(input = {}) {
  const payload = input && typeof input === "object" ? input : {};
  return {
    assetId: normalizeId(payload.assetId || payload.id),
    imageKeyId: normalizeId(payload.imageKeyId),
    imageModelId: normalizeText(payload.imageModelId),
    imageRatio: normalizeText(payload.imageRatio || "1:1"),
    imageResolution: normalizeText(payload.imageResolution || "1k"),
    imageFormat: normalizeText(payload.imageFormat || "png"),
    roleImageDesignCount: payload.roleImageDesignCount || payload.count
      ? Math.max(1, Math.min(5, Number(payload.roleImageDesignCount || payload.count || 1)))
      : "",
    roleImageType: normalizeText(payload.roleImageType),
    roleImageCustomPrompt: normalizeText(payload.roleImageCustomPrompt),
  };
}

function normalizeText(value = "") {
  return String(value || "").trim();
}

function normalizeId(value = "") {
  return normalizeText(value);
}
