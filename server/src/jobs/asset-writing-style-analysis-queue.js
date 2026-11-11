import { runWithUserConcurrency } from "./queue.js";
import { claimQueuedJob, createJob, getJobInternal, listRunnableJobs, updateJobInternal } from "../services/job-store.js";
import { executeWritingStyleAnalysisJob, markWritingStyleAnalysisError } from "../services/writing-style-analysis-runner.js";
import { getUserById } from "../services/user-store.js";

const writingStyleAnalysisNodeId = "writing-style-analysis";

export async function enqueueWritingStyleAnalysisJob(user, input = {}, config = {}) {
  return await createJob(user, {
    kind: "tool",
    scope: "asset",
    nodeId: writingStyleAnalysisNodeId,
    title: "文风库文件分析",
    status: "queued",
    progress: 0,
    payload: normalizePayload(input),
  }, config);
}

export async function listQueuedWritingStyleAnalysisJobs(config, limit = 10) {
  const jobs = await listRunnableJobs(config, {
    kind: "tool",
    scope: "asset",
    limit: Math.max(1, Number(limit || 10)) * 3,
  });
  return jobs.filter((job) => job.nodeId === writingStyleAnalysisNodeId).slice(0, Math.max(1, Number(limit || 10)));
}

export async function processWritingStyleAnalysisJobById(jobId, config = {}) {
  const claimed = await claimQueuedJob(jobId, config);
  if (!claimed) return null;
  let user;
  try {
    user = await getUserById(config, claimed.userId);
    const result = await runWithUserConcurrency(user, "llm", () => executeWritingStyleAnalysisJob(user, claimed.payload || {}, config));
    await updateJobInternal(claimed.id, {
      status: "done",
      progress: 100,
      result: { assetId: result?.asset?.id || claimed.payload?.assetId || "" },
      error: "",
    }, config);
  } catch (error) {
    const message = error.message || "后台文风分析失败。";
    if (user) await markWritingStyleAnalysisError(user, claimed.payload || {}, config, message).catch(() => null);
    await updateJobInternal(claimed.id, { status: "error", error: message }, config);
    throw error;
  }
  return await getJobInternal(jobId, config);
}

export function startWritingStyleAnalysisWorker(config, options = {}) {
  const pollMs = Math.max(500, Number(options.pollMs || config.worker?.pollMs || 1500));
  const batchSize = Math.max(1, Number(options.batchSize || config.worker?.batchSize || 8));
  const activeJobIds = new Set();
  let stopped = false;
  let timer = null;

  async function tick() {
    if (stopped) return;
    try {
      const available = Math.max(0, batchSize - activeJobIds.size);
      if (available > 0) {
        const jobs = await listQueuedWritingStyleAnalysisJobs(config, available);
        jobs.forEach((job) => {
          if (activeJobIds.has(job.id)) return;
          activeJobIds.add(job.id);
          processWritingStyleAnalysisJobById(job.id, config)
            .catch((error) => console.error(`[writing-style-worker] job ${job.id} failed:`, error.message || error))
            .finally(() => activeJobIds.delete(job.id));
        });
      }
    } catch (error) {
      console.error("[writing-style-worker] polling failed:", error.message || error);
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

function normalizePayload(input = {}) {
  const payload = input && typeof input === "object" ? input : {};
  return {
    assetId: normalizeText(payload.assetId || payload.id),
    name: normalizeText(payload.name),
    groupId: normalizeText(payload.groupId),
    llmKeyId: normalizeText(payload.llmKeyId),
    modelId: normalizeText(payload.modelId),
    sourceFile: payload.sourceFile && typeof payload.sourceFile === "object" ? payload.sourceFile : null,
    createdAt: normalizeText(payload.createdAt),
    analysisStartedAt: normalizeText(payload.analysisStartedAt),
  };
}

function normalizeText(value = "") {
  return String(value || "").trim();
}
