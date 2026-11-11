import { runWithUserConcurrency } from "./queue.js";
import { httpError } from "../http.js";
import { claimQueuedJob, createJob, createOrReuseActiveJob, getJobInternal, listRunnableJobs, listStaleRunningJobs, updateJob, updateJobIfStatus, updateJobInternal } from "../services/job-store.js";
import { getUserById } from "../services/user-store.js";
import { executeWorkflowAudioNode } from "../services/workflow-audio-runner.js";
import { executeWorkflowDraftNode } from "../services/workflow-draft-exporter.js";
import { executeWorkflowImageNode } from "../services/workflow-image-runner.js";
import { executeWorkflowLlmNode } from "../services/workflow-llm-runner.js";
import { executeWorkflowVideoAnalysisNode } from "../services/workflow-story-video-analysis-runner.js";
import { executeWorkflowVideoPromptNode } from "../services/workflow-video-prompt-runner.js";
import { getWorkflowRun, listWorkflowRunsWithActiveAudio, listWorkflowRunsWithActiveImages, listWorkflows, markWorkflowAudioRunTimedOut, patchWorkflowRunBackendJob, updateWorkflowRun, workflowConfigForRunSnapshot } from "../services/workflow-store.js";
import { workflowWorkerIsHealthy } from "../services/worker-heartbeat-store.js";
import { runActiveJobWithTimeout } from "./active-job-timeout.js";

const nodeLabels = {
  source: "视频解析",
  topic: "选题生成",
  script: "文案创作",
  audio: "口播音频生成",
  shot: "分镜生成",
  image: "分镜图片生成",
  videoPrompt: "视频提示词组装",
  draft: "剪辑草稿生成",
};
const defaultWorkflowSourceTimeoutMs = 75 * 60 * 1000;

export async function enqueueWorkflowNodeJob(user, input, config) {
  const nodeId = String(input.nodeId || "").trim();
  const runId = String(input.runId || "").trim();
  const workflowId = String(input.workflowId || "").trim();
  const scope = workflowNodeScope(nodeId);
  let job = null;

  if (nodeId === "script" && !input.jobId) {
    const activeResult = await createOrReuseActiveJob(user, {
      kind: "workflow-node",
      scope,
      workflowId,
      runId,
      nodeId,
      title: input.title || nodeLabels[nodeId] || "工作流节点任务",
      status: "queued",
      payload: input.payload || {},
    }, config);
    return activeResult.job;
  }

  if (nodeId === "image" && !input.jobId) {
    const activeResult = await createOrReuseActiveJob(user, {
      kind: "workflow-node",
      scope,
      workflowId,
      runId,
      nodeId,
      title: input.title || nodeLabels[nodeId] || "工作流节点任务",
      status: "queued",
      payload: input.payload || {},
    }, config);
    if (activeResult.reused) {
      if (activeImageJobCoversRequest(activeResult.job, input.payload || {})) return activeResult.job;
      throw httpError(409, "该工作流已有图片任务在执行，请等待当前任务结束后再生成其他镜头。");
    }
    return await completeImageJobIfRunAlreadyDone(user, activeResult.job, config) || activeResult.job;
  }

  if (input.jobId) {
    try {
      job = await updateJob(user.id, input.jobId, {
        kind: "workflow-node",
        scope,
        workflowId,
        runId,
        nodeId,
        title: input.title || nodeLabels[nodeId] || "工作流节点任务",
        status: "queued",
        progress: 0,
        payload: input.payload || {},
        error: "",
      }, config);
    } catch {
      job = null;
    }
  }

  if (!job) {
    job = await createJob(user, {
      kind: "workflow-node",
      scope,
      workflowId,
      runId,
      nodeId,
      title: input.title || nodeLabels[nodeId] || "工作流节点任务",
      status: "queued",
      payload: input.payload || {},
    }, config);
  }

  return job;
}

export async function listQueuedWorkflowNodeJobs(config, limit = 10) {
  return listRunnableJobs(config, {
    kind: "workflow-node",
    limit,
  });
}

export async function expireStaleWorkflowNodeJobs(config, options = {}) {
  const excludeIds = new Set((options.excludeIds || []).map(normalizeId).filter(Boolean));
  const expired = [];
  for (const nodeId of Object.keys(nodeLabels)) {
    const timeoutMs = workflowNodeStaleQueryTimeoutMs(nodeId, config);
    if (!timeoutMs) continue;
    const before = new Date(Date.now() - timeoutMs).toISOString();
    const jobs = await listStaleRunningJobs(config, {
      kind: "workflow-node",
      nodeId,
      before,
      limit: 50,
    });
    for (const job of jobs) {
      if (excludeIds.has(job.id)) continue;
      const jobTimeoutMs = workflowNodeStaleTimeoutMs(nodeId, config, job);
      if (!jobTimeoutMs || !isOlderThan(jobHeartbeatAt(job), jobTimeoutMs)) continue;
      const message = `${nodeLabels[nodeId] || "工作流节点任务"}超时，已自动标记失败。`;
      const failedJob = await failWorkflowNodeJob(job, config, message, { expectedStatuses: ["running"] });
      if (failedJob) expired.push(failedJob);
    }
  }
  return expired;
}

export async function failWorkflowNodeJob(job, config, message = "", options = {}) {
  const nodeId = normalizeId(job?.nodeId);
  const failureMessage = message || `${nodeLabels[nodeId] || "工作流节点任务"}失败。`;
  const patch = {
    status: "error",
    error: failureMessage,
  };
  const failedJob = options.expectedStatuses?.length
    ? await updateJobIfStatus(job.id, options.expectedStatuses, patch, config).catch(() => null)
    : await updateJobInternal(job.id, patch, config).catch(() => null);
  if (!failedJob && !options.allowMissingRecord) return null;
  const failureSnapshot = failedJob || {
    ...job,
    status: "error",
    error: failureMessage,
  };
  await markWorkflowRunNodeError(job.userId, job, failureMessage, config, failureSnapshot);
  return failureSnapshot;
}

export async function reconcileWorkflowImageRun(userId, runId, config, options = {}) {
  const run = await getWorkflowRun(userId, runId, config).catch(() => null);
  if (!run || run.status === "deleted") return run;
  const result = run.result && typeof run.result === "object" ? run.result : {};
  const shots = Array.isArray(result.shots) ? result.shots : [];
  const activeShots = shots.filter((shot) => (
    !shot.imageUrl && ["pending", "queued", "running"].includes(normalizeId(shot.imageStatus))
  ));
  const stages = run.stages && typeof run.stages === "object" ? run.stages : {};
  const backendJobs = result.backendJobs && typeof result.backendJobs === "object" ? result.backendJobs : {};
  const snapshotJob = backendJobs.image && typeof backendJobs.image === "object" ? backendJobs.image : null;
  if (stages.image !== "running" && !workflowJobIsActive(snapshotJob)) return run;

  const loadedJob = snapshotJob?.id ? await getJobInternal(snapshotJob.id, config).catch(() => null) : null;
  const actualJob = loadedJob?.userId === userId && loadedJob?.runId === run.id ? loadedJob : null;
  const nowMs = Number(options.nowMs || Date.now());
  const queuedTimeoutMs = imageQueuedTimeoutMs(config);
  const heartbeatTimeoutMs = imageHeartbeatTimeoutMs(config);
  let message = "";
  let expectedStatuses = [];

  if (
    actualJob &&
    ["done", "error", "canceled"].includes(normalizeId(actualJob.status)) &&
    !activeShots.length
  ) {
    return updateWorkflowRun(userId, run.id, {
      stages: {
        ...stages,
        image: workflowImageStageAfterTerminalJob(shots),
      },
      result: {
        ...result,
        backendJobs: {
          ...backendJobs,
          image: actualJob,
        },
      },
    }, config);
  }

  if (actualJob) {
    const status = normalizeId(actualJob.status);
    if (["error", "canceled"].includes(status)) {
      message = activeShots.length > 1
        ? "图片生成任务已经结束，但该镜头没有正确收口；为避免重复计费，请仅重试这些缺失镜头。"
        : actualJob.error || "图片生成任务已经结束，但仍有图片停留在生成中。";
    } else if (status === "done" && activeShots.length) {
      message = "图片生成任务已经完成，但仍有图片没有返回结果。";
    } else if (
      status === "queued"
      && isOlderThan(actualJob.queuedAt || actualJob.createdAt, queuedTimeoutMs, nowMs)
      && !await workflowWorkerIsHealthy(config, nowMs)
    ) {
      message = "图片生成 Worker 已离线，任务尚未提交到模型渠道，请恢复 Worker 后重试缺失图片。";
      expectedStatuses = ["queued"];
    } else if (status === "running" && isOlderThan(jobHeartbeatAt(actualJob), heartbeatTimeoutMs, nowMs)) {
      message = "图片生成任务心跳超时，已自动结束未完成图片。";
      expectedStatuses = ["running"];
    } else if (status === "running" && isOlderThan(jobProgressAt(actualJob), imageNoProgressTimeoutMs(config), nowMs)) {
      message = "图片生成任务长时间没有任何图片完成，已自动结束未完成图片。";
      expectedStatuses = ["running"];
    }
  } else if (snapshotJob) {
    const snapshotStatus = normalizeId(snapshotJob.status);
    if (["done", "error", "canceled"].includes(snapshotStatus)) {
      message = snapshotJob.error || "图片任务已经结束，但图片状态未正确收口。";
    } else if (isOlderThan(jobHeartbeatAt(snapshotJob) || run.updatedAt || run.createdAt, queuedTimeoutMs, nowMs)) {
      message = "图片生成任务记录已丢失或停止响应，已自动结束未完成图片。";
    }
  } else if (isOlderThan(run.updatedAt || run.createdAt, queuedTimeoutMs, nowMs)) {
    message = "图片生成任务记录不存在，已自动结束未完成图片。";
  }

  if (!message) return run;
  const job = actualJob || snapshotJob || {
    id: `orphan-image-${run.id}`,
    userId,
    workflowId: run.workflowId,
    runId: run.id,
    nodeId: "image",
    kind: "workflow-node",
    scope: "image",
    title: nodeLabels.image,
    status: "running",
    payload: {},
  };
  const failedJob = await failWorkflowNodeJob(job, config, message, {
    expectedStatuses,
    allowMissingRecord: !actualJob,
  });
  if (!failedJob) return await getWorkflowRun(userId, runId, config).catch(() => run);
  return await getWorkflowRun(userId, runId, config).catch(() => run);
}

export async function reconcileStaleWorkflowImageRuns(config, options = {}) {
  const runs = await listWorkflowRunsWithActiveImages(config, options.limit || 100);
  const reconciled = [];
  for (const run of runs) {
    const updated = await reconcileWorkflowImageRun(run.userId, run.id, config, options);
    if (updated && updated.stages?.image === "error") reconciled.push(updated);
  }
  return reconciled;
}

export async function reconcileStaleWorkflowAudioRuns(config, options = {}) {
  const timeoutMs = audioRunStaleTimeoutMs(config);
  if (!timeoutMs) return [];
  const nowMs = Number(options.nowMs || Date.now());
  const staleBefore = new Date(nowMs - timeoutMs).toISOString();
  const timeoutMinutes = Math.max(1, Math.round(timeoutMs / (60 * 1000)));
  const message = `音频生成连续 ${timeoutMinutes} 分钟没有进度，已自动结束，请重试。`;
  const runs = await listWorkflowRunsWithActiveAudio(config, options.limit || 100);
  const reconciled = [];
  for (const run of runs) {
    if (!isOlderThan(run.updatedAt || run.createdAt, timeoutMs, nowMs)) continue;
    const updated = await markWorkflowAudioRunTimedOut(run.userId, run.id, {
      staleBefore,
      timedOutAt: new Date(nowMs).toISOString(),
      message,
    }, config);
    if (!updated) continue;
    reconciled.push(updated);
    console.warn(`[workflow-worker] audio run ${run.id} timed out: ${message}`);
  }
  return reconciled;
}

export function startWorkflowImageJobHeartbeat(job, config) {
  const intervalMs = Math.max(1000, Number(config.worker?.imageHeartbeatMs || 30 * 1000));
  let stopped = false;
  let timer = null;

  async function touch() {
    if (stopped) return null;
    const current = await getJobInternal(job.id, config).catch(() => null);
    if (!current || current.status !== "running") {
      stop();
      return current;
    }
    return updateJobIfStatus(job.id, ["running"], {
      result: {
        ...(current.result || {}),
        heartbeatAt: new Date().toISOString(),
        lastProgressAt: current.result?.lastProgressAt || current.startedAt || new Date().toISOString(),
      },
    }, config);
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(() => {
      touch()
        .catch((error) => console.warn(`[workflow-worker] image heartbeat failed for ${job.id}:`, error?.message || error))
        .finally(schedule);
    }, intervalMs);
    timer.unref?.();
  }

  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
  }

  schedule();
  return { touch, stop };
}

export async function processNextWorkflowNodeJob(config) {
  const jobs = await listQueuedWorkflowNodeJobs(config, 1);
  const job = jobs[0];
  if (!job) return null;
  await processWorkflowNodeJobById(job.id, config);
  return job.id;
}

export async function processWorkflowNodeJobById(jobId, config) {
  const claimed = await claimQueuedJob(jobId, config);
  if (!claimed) return null;
  let user;
  try {
    user = await getUserById(config, claimed.userId);
  } catch (error) {
    await updateJobInternal(claimed.id, {
      status: "error",
      error: error.message || "后台节点任务无法读取用户信息。",
    }, config);
    throw error;
  }
  const timeoutMs = workflowNodeActiveTimeoutMs(claimed.nodeId, config, claimed);
  const timeoutMessage = `${nodeLabels[claimed.nodeId] || claimed.title || "工作流节点任务"}超时，已自动标记失败。`;
  const heartbeat = claimed.nodeId === "image" ? startWorkflowImageJobHeartbeat(claimed, config) : null;
  let timedOut = false;
  const shouldContinue = async () => {
    if (timedOut) return false;
    if (claimed.nodeId !== "image") return true;
    const current = await getJobInternal(claimed.id, config).catch(() => null);
    return current?.status === "running";
  };
  try {
    await heartbeat?.touch();
    await runActiveJobWithTimeout(() => processWorkflowNodeJob(user, claimed, config, {
      shouldContinue,
    }), {
      timeoutMs,
      message: timeoutMessage,
      onTimeout: () => {
        timedOut = true;
        return failWorkflowNodeJob(claimed, config, timeoutMessage);
      },
      onLateError: (error) => {
        console.warn(`[workflow-worker] job ${claimed.id} failed after timeout:`, error?.message || error);
      },
    });
  } finally {
    heartbeat?.stop();
  }
  return await getJobInternal(jobId, config);
}

async function processWorkflowNodeJob(user, job, config, options = {}) {
  const nodeId = String(job.nodeId || "").trim();
  const scope = workflowNodeScope(nodeId);
  const executor = workflowNodeExecutor(nodeId);
  const onProgress = nodeId === "draft" ? createDraftJobProgressReporter(user, job, config) : null;
  try {
    if (nodeId === "image") {
      const completedJob = await completeImageJobIfRunAlreadyDone(user, job, config);
      if (completedJob) return;
    }
    const executionResult = await runWithUserConcurrency(user, scope, () =>
      executor(user, {
        ...(job.payload || {}),
        runId: job.runId,
        nodeId: job.nodeId,
        workflowId: job.workflowId,
        jobId: job.id,
        shouldContinue: options.shouldContinue,
        ...(onProgress ? { onProgress } : {}),
      }, config));
    if (nodeId === "source") {
      const completedJob = await updateJobInternal(job.id, {
        status: "done",
        progress: 100,
        result: {
          scriptAssetId: executionResult?.savedAsset?.id || "",
          savedToScriptLibrary: Boolean(executionResult?.savedAsset?.id),
          sourceName: executionResult?.scriptAsset?.name || "",
        },
        error: "",
      }, config);
      await attachBackendJobToRun(user.id, job.runId, "source", completedJob, config, {
        runPatch: { status: "running", completedAt: "", error: "" },
      });
      await enqueueTopicAfterVideoAnalysis(user, job, config).catch(async (error) => {
        console.warn(`[workflow-worker] unable to enqueue topic after source job ${job.id}:`, error?.message || error);
        await markTopicQueueAfterSourceError(user.id, job, error?.message || "视频解析已完成，但选题排队失败。", config);
      });
    }
    if (nodeId === "draft") {
      await completeDraftWorkflowJob(user, job, executionResult, config).catch((error) => {
        console.warn(`[workflow-worker] unable to finalize draft job ${job.id}:`, error?.message || error);
      });
    }
    if (["script", "audio"].includes(nodeId)) {
      await enqueueNextAutomaticStage(user, job, config);
    }
    if (nodeId === "shot" && job.payload?.autoImages) {
      const imageJob = await enqueueWorkflowNodeJob(user, {
        workflowId: job.workflowId,
        runId: job.runId,
        nodeId: "image",
        title: "分镜图片生成",
        payload: {
          autoQueuedFrom: "shot",
          sourceJobId: job.id,
          imageKeyId: job.payload.imageKeyId || "",
          imageModelId: job.payload.imageModelId || "",
          visualStyleId: job.payload.visualStyleId || "",
          visualStyleName: job.payload.visualStyleName || "",
          visualStylePrompt: job.payload.visualStylePrompt || "",
          promptMode: job.payload.promptMode || "",
          imagePromptOverrides: job.payload.imagePromptOverrides || {},
          imageResolution: job.payload.imageResolution || "",
          ratio: job.payload.ratio || "",
          imageSize: job.payload.imageSize || "",
          customSize: job.payload.customSize || "",
        },
      }, config);
      await attachBackendJobToRun(user.id, job.runId, "image", imageJob, config);
    }
  } catch (error) {
    const failedJob = await updateJobInternal(job.id, {
      status: "error",
      error: error.message || "后台节点任务执行失败。",
    }, config);
    await markWorkflowRunNodeError(user.id, job, error.message || "后台节点任务执行失败。", config, failedJob);
    throw error;
  }
}

function createDraftJobProgressReporter(user, job, config) {
  let lastProgress = Math.max(0, Number(job.progress || 0));
  let lastStage = "";
  let lastReportedAt = 0;
  return async ({ progress = 0, stage = "", detail = "" } = {}) => {
    const normalizedStage = normalizeId(stage);
    const requestedProgress = Math.min(100, Math.max(0, Math.round(Number(progress || 0))));
    const now = Date.now();
    const shouldReport = requestedProgress >= 100
      || normalizedStage !== lastStage
      || requestedProgress - lastProgress >= 3
      || now - lastReportedAt >= 4000;
    if (!shouldReport) return;
    const current = await getJobInternal(job.id, config);
    if (["done", "error", "canceled"].includes(normalizeId(current.status))) return;
    const nextProgress = Math.max(Number(current.progress || 0), requestedProgress);
    const updated = await updateJobInternal(job.id, {
      status: "running",
      progress: nextProgress,
      result: {
        ...(current.result || {}),
        stage: normalizedStage,
        detail: normalizeId(detail),
        lastProgressAt: new Date().toISOString(),
      },
      error: "",
    }, config);
    lastProgress = nextProgress;
    lastStage = normalizedStage;
    lastReportedAt = now;
    await attachBackendJobToRun(user.id, job.runId, "draft", updated, config);
  };
}

async function completeDraftWorkflowJob(user, job, executionResult, config) {
  const current = await getJobInternal(job.id, config);
  if (["error", "canceled"].includes(normalizeId(current.status))) return current;
  const draft = executionResult?.draft && typeof executionResult.draft === "object" ? executionResult.draft : {};
  const draftUrl = normalizeId(draft.draft_url || draft.draftUrl || draft.url);
  const draftId = normalizeId(draft.draft_id || draft.draftId || draft.id);
  const completed = await updateJobInternal(job.id, {
    status: "done",
    progress: 100,
    result: {
      ...(current.result || {}),
      stage: "done",
      detail: "剪辑草稿已生成",
      draftUrl,
      draftId,
      lastProgressAt: new Date().toISOString(),
    },
    error: "",
  }, config);
  await attachBackendJobToRun(user.id, job.runId, "draft", completed, config, {
    runPatch: { status: "waiting", completedAt: "", error: "" },
  });
}

function workflowNodeScope(nodeId) {
  if (nodeId === "image") return "image";
  if (nodeId === "audio") return "audio";
  if (nodeId === "draft") return "video";
  return "llm";
}

function workflowNodeActiveTimeoutMs(nodeId, config = {}, job = {}) {
  const worker = config.worker || {};
  if (nodeId === "source") return Math.max(defaultWorkflowSourceTimeoutMs, Number(worker.llmNodeTimeoutMs || 0));
  if (nodeId === "image") return 0;
  if (nodeId === "audio") return Math.max(0, Number(worker.audioNodeTimeoutMs || 0));
  if (nodeId === "draft") return Math.max(0, Number(worker.draftNodeTimeoutMs || 0));
  if (nodeId === "shot" && normalizeId(job?.payload?.storyboardMode) === "ai-director") {
    return Math.max(0, Number(worker.aiDirectorLlmNodeTimeoutMs || worker.llmNodeTimeoutMs || 0));
  }
  return Math.max(0, Number(worker.llmNodeTimeoutMs || 0));
}

function workflowNodeStaleTimeoutMs(nodeId, config = {}, job = {}) {
  if (nodeId === "image") return imageHeartbeatTimeoutMs(config);
  return workflowNodeActiveTimeoutMs(nodeId, config, job);
}

function workflowNodeStaleQueryTimeoutMs(nodeId, config = {}) {
  const standardTimeoutMs = workflowNodeStaleTimeoutMs(nodeId, config);
  if (nodeId !== "shot") return standardTimeoutMs;
  const aiDirectorTimeoutMs = workflowNodeStaleTimeoutMs(nodeId, config, {
    payload: { storyboardMode: "ai-director" },
  });
  const timeouts = [standardTimeoutMs, aiDirectorTimeoutMs].filter((value) => Number(value) > 0);
  return timeouts.length ? Math.min(...timeouts) : 0;
}

async function markWorkflowRunNodeError(userId, job, message, config, failedJob = null) {
  const runId = normalizeId(job?.runId);
  const nodeId = normalizeId(job?.nodeId);
  if (!userId || !runId || !nodeId) return null;
  try {
    const run = await getWorkflowRun(userId, runId, config);
    if (!run || run.status === "deleted") return null;
    const result = run.result && typeof run.result === "object" ? run.result : {};
    const stages = run.stages && typeof run.stages === "object" ? run.stages : {};
    const backendJobs = result.backendJobs && typeof result.backendJobs === "object" ? result.backendJobs : {};
    const currentNodeJobId = normalizeId(backendJobs[nodeId]?.id);
    if (nodeId === "image" && currentNodeJobId && currentNodeJobId !== normalizeId(job.id)) return run;
    const topLevelPatch = ["source", "topic"].includes(nodeId)
      ? {
          topicGenerationStatus: "error",
          topicGenerationError: message,
        }
      : {};
    const dependentErrorStages = workflowNodeDependentErrorStages(nodeId, job);
    const dependentErrorResultPatch = workflowNodeDependentErrorResultPatch(nodeId, job, message);
    const dependentErrorJobs = workflowNodeDependentErrorJobs(nodeId, job, message, backendJobs);
    const nextResult = {
      ...result,
      ...workflowNodeErrorResultPatch(nodeId, job, message, result),
      ...dependentErrorResultPatch,
      backendJobs: {
        ...backendJobs,
        [nodeId]: failedJob || {
          ...job,
          status: "error",
          error: message,
        },
        ...dependentErrorJobs,
      },
    };
    return await updateWorkflowRun(userId, runId, {
      ...topLevelPatch,
      status: "waiting",
      completedAt: "",
      stages: {
        ...stages,
        [nodeId]: "error",
        ...dependentErrorStages,
      },
      result: nextResult,
      error: message,
    }, config);
  } catch (error) {
    console.warn("Unable to mark workflow node as failed:", error?.message || error);
    return null;
  }
}

function workflowNodeErrorResultPatch(nodeId, job = {}, message = "", result = {}) {
  if (nodeId === "topic") return {};
  if (nodeId === "source") {
    return {
      storyVideoAnalysis: {
        ...(result.storyVideoAnalysis && typeof result.storyVideoAnalysis === "object" ? result.storyVideoAnalysis : {}),
        status: "error",
        error: message,
      },
    };
  }
  if (nodeId === "script") return { scriptError: message };
  if (nodeId === "shot") return { shotError: message };
  if (nodeId === "audio") return { audioStatus: "error", audioError: message };
  if (nodeId === "videoPrompt") return { videoPromptError: message };
  if (nodeId === "draft") return { draftError: message, draftStatus: "error" };
  if (nodeId === "image") {
    const patch = { imageError: message };
    const shots = markWorkflowImageShotsError(result.shots, job, message);
    if (shots) patch.shots = shots;
    return patch;
  }
  return {};
}

function markWorkflowImageShotsError(shots, job = {}, message = "") {
  if (!Array.isArray(shots)) return null;
  const requestedShotIds = new Set((Array.isArray(job.payload?.shotIds) ? job.payload.shotIds : []).map(normalizeId).filter(Boolean));
  const errorMessage = message || "分镜图片生成失败。";
  return shots.map((shot) => {
    const shotId = workflowShotId(shot);
    if (requestedShotIds.size && !requestedShotIds.has(shotId)) return shot;
    if (shot.imageUrl) return shot;
    if (normalizeId(shot.imageJobId) && normalizeId(shot.imageJobId) !== normalizeId(job.id)) return shot;
    const status = normalizeId(shot.imageStatus);
    if (status && !["pending", "queued", "running"].includes(status)) return shot;
    const submitted = Boolean(normalizeId(shot.imageSubmittedAt));
    if (!submitted) {
      return {
        ...shot,
        imageStatus: "paused",
        imageError: "",
        imagePauseReason: `等待已暂停：图片任务已停止，本镜头尚未发起请求，未产生费用。原因：${errorMessage}`,
        imageCompletedAt: new Date().toISOString(),
      };
    }
    return {
      ...shot,
      imageStatus: "error",
      imageError: normalizeId(shot.imageError) || errorMessage,
      imagePauseReason: "",
      imageCompletedAt: new Date().toISOString(),
    };
  });
}

function workflowNodeDependentErrorStages(nodeId, job = {}) {
  if (nodeId === "shot" && job.payload?.autoImages) return { image: "error" };
  return {};
}

function workflowNodeDependentErrorResultPatch(nodeId, job = {}, message = "") {
  if (nodeId === "shot" && job.payload?.autoImages) {
    return { imageError: blockedImageMessage(message) };
  }
  return {};
}

function workflowNodeDependentErrorJobs(nodeId, job = {}, message = "", backendJobs = {}) {
  if (nodeId !== "shot" || !job.payload?.autoImages) return {};
  const existingImageJob = backendJobs.image && typeof backendJobs.image === "object" ? backendJobs.image : {};
  const imageError = blockedImageMessage(message);
  return {
    image: {
      id: job.id ? `${job.id}-blocked-image` : "",
      userId: job.userId || "",
      kind: "workflow-node",
      scope: "image",
      workflowId: job.workflowId || "",
      runId: job.runId || "",
      nodeId: "image",
      title: existingImageJob.title || nodeLabels.image,
      status: "error",
      error: imageError,
      payload: {
        ...(existingImageJob.payload && typeof existingImageJob.payload === "object" ? existingImageJob.payload : {}),
        autoSkippedFrom: "shot",
        sourceJobId: job.id || "",
      },
    },
  };
}

function blockedImageMessage(message = "") {
  return `分镜节点失败，图片节点未执行：${message || "请先修复分镜节点。"}`;
}

function workflowNodeExecutor(nodeId) {
  if (nodeId === "source") return executeWorkflowVideoAnalysisNode;
  if (nodeId === "image") return executeWorkflowImageNode;
  if (nodeId === "audio") return executeWorkflowAudioNode;
  if (nodeId === "videoPrompt") return executeWorkflowVideoPromptNode;
  if (nodeId === "draft") return executeWorkflowDraftNode;
  return executeWorkflowLlmNode;
}

async function enqueueTopicAfterVideoAnalysis(user, job, config) {
  const run = await getWorkflowRun(user.id, job.runId, config);
  if (!run || run.status === "deleted") return null;
  const result = run.result && typeof run.result === "object" ? run.result : {};
  const backendJobs = result.backendJobs && typeof result.backendJobs === "object" ? result.backendJobs : {};
  if (workflowJobIsActive(backendJobs.topic)) return backendJobs.topic;
  const payload = job.payload?.topicPayload && typeof job.payload.topicPayload === "object"
    ? job.payload.topicPayload
    : {};
  const topicJob = await enqueueWorkflowNodeJob(user, {
    workflowId: job.workflowId,
    runId: job.runId,
    nodeId: "topic",
    title: "选题生成",
    payload: {
      ...payload,
      autoQueuedFrom: "source",
      sourceJobId: job.id,
    },
  }, config);
  await attachBackendJobToRun(user.id, job.runId, "topic", topicJob, config, {
    stages: { topic: "running" },
    runPatch: {
      status: "running",
      completedAt: "",
      topicGenerationStatus: "running",
      topicGenerationError: "",
      error: "",
    },
  });
  return topicJob;
}

async function markTopicQueueAfterSourceError(userId, job, message, config) {
  const run = await getWorkflowRun(userId, job.runId, config).catch(() => null);
  if (!run || run.status === "deleted") return null;
  return await updateWorkflowRun(userId, run.id, {
    status: "waiting",
    topicGenerationStatus: "error",
    topicGenerationError: message,
    error: message,
    stages: {
      ...(run.stages || {}),
      topic: "error",
    },
  }, config);
}

async function enqueueNextAutomaticStage(user, job, config) {
  const workflow = await workflowForJob(user.id, job.workflowId, config);
  const run = await getWorkflowRun(user.id, job.runId, config).catch(() => null);
  if (!run || run.status === "deleted") return;
  const workflowForRun = workflowConfigForRunSnapshot(workflow || {}, run);
  const wf = workflowForRun?.config && typeof workflowForRun.config === "object" ? workflowForRun.config : workflowForRun || {};
  const executionStep = normalizeExecutionStep(job.payload?.executionStep || wf.executionStep);
  const nextNode = workflowNextAutomaticNode(wf, run, job.nodeId, executionStep);
  if (nextNode === "audio") {
    await enqueueAutomaticAudioAfterScript(user, job, config, wf, run, executionStep);
    return;
  }
  if (nextNode !== "shot") return;
  await enqueueAutomaticShot(user, job, config, wf, run, executionStep);
}

async function enqueueAutomaticAudioAfterScript(user, job, config, wf, run, executionStep) {
  const result = run.result && typeof run.result === "object" ? run.result : {};
  const backendJobs = result.backendJobs && typeof result.backendJobs === "object" ? result.backendJobs : {};
  const existingAudioJob = backendJobs.audio;
  if (workflowJobIsActive(existingAudioJob)) return;
  const audioKeyId = job.payload?.audioKeyId || wf.audioKeyId || "";
  if (!audioKeyId) return;
  const audioJob = await enqueueWorkflowNodeJob(user, {
    workflowId: job.workflowId,
    runId: job.runId,
    nodeId: "audio",
    title: "口播音频生成",
    payload: {
      autoQueuedFrom: "script",
      sourceJobId: job.id,
      executionStep,
      audioKeyId,
      audioModelId: job.payload?.audioModelId || wf.audioModelId || "",
      modelId: job.payload?.audioModelId || wf.audioModelId || "",
      voice: job.payload?.voice || wf.audioVoice || "alloy",
      format: job.payload?.format || wf.audioFormat || "mp3",
      emotion: job.payload?.emotion || wf.audioEmotion || "natural",
      bitrate: job.payload?.bitrate || wf.audioBitrate || 128,
      speed: job.payload?.speed || wf.audioSpeed || 1,
      voicePresetId: job.payload?.voicePresetId || wf.audioVoicePresetId || "default",
      referenceId: job.payload?.referenceId || wf.audioReferenceId || "",
      references: job.payload?.references || wf.audioReferences || [],
      llmKeyId: job.payload?.llmKeyId || wf.llmKeyId || "",
      shotModelId: job.payload?.shotModelId || wf.shotModelId || wf.storyModelId || "",
      imageKeyId: job.payload?.imageKeyId || wf.imageKeyId || "",
      imageModelId: job.payload?.imageModelId || wf.imageModelId || "",
      visualStyleId: job.payload?.visualStyleId || wf.visualStyleId || "",
      visualStyleName: job.payload?.visualStyleName || wf.visualStyleName || "",
      visualStylePrompt: job.payload?.visualStylePrompt || wf.visualStylePrompt || "",
      promptMode: job.payload?.promptMode || "create-compatible",
      imageResolution: job.payload?.imageResolution || wf.imageResolution || "",
      ratio: job.payload?.ratio || wf.ratio || "",
      imageSize: job.payload?.imageSize || wf.imageSize || "",
      customSize: job.payload?.customSize || wf.customSize || "",
    },
  }, config);
  await attachBackendJobToRun(user.id, job.runId, "audio", audioJob, config, {
    stages: {
      shot: "pending",
      image: "pending",
      videoPrompt: "pending",
      video: "pending",
    },
    runPatch: {
      status: "running",
      completedAt: "",
    },
  });
}

async function enqueueAutomaticShot(user, job, config, wf, run, executionStep) {
  const result = run.result && typeof run.result === "object" ? run.result : {};
  const backendJobs = result.backendJobs && typeof result.backendJobs === "object" ? result.backendJobs : {};
  const existingShotJob = backendJobs.shot;
  if (workflowJobIsActive(existingShotJob)) return;
  const autoImages = executionStep === "all";
  const talkingVideo = normalizeId(wf.type || wf.workflowType || wf.config?.type) === "explain";
  const shotJob = await enqueueWorkflowNodeJob(user, {
    workflowId: job.workflowId,
    runId: job.runId,
    nodeId: "shot",
    title: autoImages ? "分镜和图片生成" : "分镜生成",
    payload: {
      autoQueuedFrom: job.nodeId,
      sourceJobId: job.id,
      executionStep,
      autoImages,
      ...(talkingVideo ? {
        talkingShotSegmentationMode: job.payload?.talkingShotSegmentationMode === "punctuation"
          ? "punctuation"
          : "duration-semantic",
      } : {}),
      llmKeyId: job.payload?.llmKeyId || wf.llmKeyId || "",
      shotModelId: job.payload?.shotModelId || wf.shotModelId || wf.storyModelId || "",
      modelId: job.payload?.shotModelId || (job.nodeId === "script" ? job.payload?.modelId : "") || wf.shotModelId || wf.storyModelId || "",
      imageKeyId: job.payload?.imageKeyId || wf.imageKeyId || "",
      imageModelId: job.payload?.imageModelId || wf.imageModelId || "",
      visualStyleId: job.payload?.visualStyleId || wf.visualStyleId || "",
      visualStyleName: job.payload?.visualStyleName || wf.visualStyleName || "",
      visualStylePrompt: job.payload?.visualStylePrompt || wf.visualStylePrompt || "",
      promptMode: job.payload?.promptMode || "create-compatible",
      imageResolution: job.payload?.imageResolution || wf.imageResolution || "",
      ratio: job.payload?.ratio || wf.ratio || "",
      imageSize: job.payload?.imageSize || wf.imageSize || "",
      customSize: job.payload?.customSize || wf.customSize || "",
    },
  }, config);
  await attachBackendJobToRun(user.id, job.runId, "shot", shotJob, config, {
    stages: {
      image: "pending",
      videoPrompt: "pending",
      video: "pending",
    },
    runPatch: {
      status: "running",
      completedAt: "",
    },
  });
}

export function workflowNextAutomaticNode(workflow = {}, run = {}, nodeId = "", executionStep = "") {
  const step = normalizeExecutionStep(executionStep || workflow.executionStep);
  if (!["shot", "all"].includes(step)) return "";
  const type = normalizeId(workflow.type || workflow.workflowType || workflow.config?.type);
  if (nodeId === "script") {
    if (type === "explain" && !workflowRunHasAudioResult(run)) return "audio";
    return "shot";
  }
  if (nodeId === "audio" && type === "explain") return "shot";
  return "";
}

function workflowRunHasAudioResult(run = {}) {
  const result = run.result && typeof run.result === "object" ? run.result : {};
  return Boolean(
    result.audioUrl
    || result.audio?.audio_url
    || (Array.isArray(result.audioSegments) && result.audioSegments.length)
    || (Array.isArray(result.audioTracks) && result.audioTracks.length),
  );
}

async function workflowForJob(userId, workflowId, config) {
  if (!workflowId) return null;
  const workflows = await listWorkflows(userId, config);
  return workflows.find((workflow) => workflow.id === workflowId && workflow.userId === userId) || null;
}

function normalizeExecutionStep(value) {
  return ["story", "shot", "all"].includes(value) ? value : "story";
}

function workflowJobIsActive(job) {
  return Boolean(job && ["queued", "running"].includes(job.status));
}

function activeImageJobCoversRequest(job = {}, requestedPayload = {}) {
  const activePayload = job.payload && typeof job.payload === "object" ? job.payload : {};
  if (hasForcedImageRegeneration(requestedPayload) && !hasForcedImageRegeneration(activePayload)) return false;
  const activeShotIds = new Set((Array.isArray(activePayload.shotIds) ? activePayload.shotIds : []).map(normalizeId).filter(Boolean));
  const requestedShotIds = (Array.isArray(requestedPayload.shotIds) ? requestedPayload.shotIds : []).map(normalizeId).filter(Boolean);
  if (!activeShotIds.size) return true;
  if (!requestedShotIds.length) return false;
  return requestedShotIds.every((shotId) => activeShotIds.has(shotId));
}

async function completeImageJobIfRunAlreadyDone(user, job, config) {
  if (!user?.id || !job?.runId || hasForcedImageRegeneration(job.payload)) return null;
  let run = null;
  try {
    run = await getWorkflowRun(user.id, job.runId, config);
  } catch {
    return null;
  }
  const shots = currentRunShots(run);
  if (!shots.length) return null;
  const requestedShotIds = new Set((Array.isArray(job.payload?.shotIds) ? job.payload.shotIds : []).map(normalizeId).filter(Boolean));
  const targetShots = requestedShotIds.size ? shots.filter((shot) => requestedShotIds.has(workflowShotId(shot))) : shots;
  if (!targetShots.length) return null;
  if (targetShots.some(workflowShotMissingProductImage)) return null;
  const targetImageShots = targetShots.filter(workflowShotRequiresGeneratedImage);
  if (targetImageShots.some((shot) => !shot?.imageUrl)) return null;

  const result = run.result && typeof run.result === "object" ? run.result : {};
  const backendJobs = result.backendJobs && typeof result.backendJobs === "object" ? result.backendJobs : {};
  const stages = run.stages && typeof run.stages === "object" ? run.stages : {};
  const doneCount = targetImageShots.filter((shot) => shot.imageUrl).length;
  const jobResult = {
    total: targetImageShots.length,
    done: doneCount,
    missing: targetImageShots.length - doneCount,
    skipped: true,
  };
  const completedJob = job.id
    ? await updateJobInternal(job.id, {
        status: "done",
        progress: 100,
        result: jobResult,
        error: "",
      }, config)
    : await createJob(user, {
        kind: "workflow-node",
        scope: "image",
        workflowId: job.workflowId || run.workflowId,
        runId: job.runId,
        nodeId: "image",
        title: job.title || nodeLabels.image,
        status: "done",
        progress: 100,
        payload: job.payload || {},
        result: jobResult,
      }, config);
  await updateWorkflowRun(user.id, run.id, {
    status: run.status === "running" ? "waiting" : run.status,
    stages: {
      ...stages,
      image: "done",
    },
    result: {
      ...result,
      shots,
      backendJobs: {
        ...backendJobs,
        image: completedJob,
      },
    },
  }, config);
  return completedJob;
}

function currentRunShots(run) {
  const result = run?.result && typeof run.result === "object" ? run.result : {};
  return Array.isArray(result.shots) ? result.shots : Array.isArray(run?.shots) ? run.shots : [];
}

function hasForcedImageRegeneration(payload = {}) {
  return Boolean(payload.forceRegenerate || payload.force || payload.regenerate);
}

function normalizeId(value) {
  return String(value || "").trim();
}

function workflowImageStageAfterTerminalJob(shots = []) {
  const generatedShots = (Array.isArray(shots) ? shots : [])
    .filter((shot) => normalizeId(shot.assetType) !== "product");
  return generatedShots.every((shot) => normalizeId(shot.imageUrl)) ? "done" : "error";
}

function imageHeartbeatTimeoutMs(config = {}) {
  return Math.max(1000, Number(config.worker?.imageHeartbeatTimeoutMs || 3 * 60 * 1000));
}

function imageQueuedTimeoutMs(config = {}) {
  return Math.max(1000, Number(config.worker?.imageQueuedTimeoutMs || 5 * 60 * 1000));
}

function imageNoProgressTimeoutMs(config = {}) {
  return Math.max(1000, Number(config.worker?.imageNoProgressTimeoutMs || 45 * 60 * 1000));
}

function audioRunStaleTimeoutMs(config = {}) {
  return Math.max(0, Number(config.worker?.audioRunStaleTimeoutMs || 0));
}

function jobHeartbeatAt(job = {}) {
  return job.result?.heartbeatAt || job.startedAt || job.queuedAt || job.createdAt || "";
}

function jobProgressAt(job = {}) {
  return job.result?.lastProgressAt || job.startedAt || job.queuedAt || job.createdAt || "";
}

function isOlderThan(value, timeoutMs, nowMs = Date.now()) {
  const timestamp = new Date(value || 0).getTime();
  return Number.isFinite(timestamp) && timestamp > 0 && nowMs - timestamp >= timeoutMs;
}

function workflowShotId(shot = {}) {
  return normalizeId(shot.id || shot.shotId || shot.uuid);
}

function workflowShotRequiresGeneratedImage(shot = {}) {
  return normalizeId(shot.assetType) !== "product";
}

function workflowShotMissingProductImage(shot = {}) {
  return normalizeId(shot.assetType) === "product" && !normalizeId(shot.imageUrl || shot.fileUrl || shot.url);
}

async function attachBackendJobToRun(userId, runId, nodeId, job, config, options = {}) {
  try {
    const stageStatus = job.status === "done" ? "done" : job.status === "error" ? "error" : "running";
    await patchWorkflowRunBackendJob(userId, runId, {
      nodeId,
      job,
      runPatch: options.runPatch || {},
      stages: {
        [nodeId]: stageStatus,
        ...(options.stages || {}),
      },
    }, config);
  } catch (error) {
    console.warn("Unable to attach backend workflow job to run:", error?.message || error);
  }
}
