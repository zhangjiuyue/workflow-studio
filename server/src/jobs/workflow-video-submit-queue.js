import crypto from "node:crypto";
import { runWithUserConcurrency } from "./queue.js";
import {
  claimQueuedJob,
  createJob,
  getJobInternal,
  listJobs,
  listRunnableJobs,
  requeueInterruptedJobs,
  updateJobInternal,
} from "../services/job-store.js";
import { createVideoGeneration, extractVideoTaskId } from "../services/model-proxy.js";
import { getUserById } from "../services/user-store.js";
import { getWorkflowRun, updateWorkflowRun } from "../services/workflow-store.js";
import { persistWorkflowVideoTasks } from "../services/workflow-video-task-store.js";
import { workflowVideoResultStorageKey } from "../lib/workflow-video-results.mjs";
import { httpError } from "../http.js";

export const workflowVideoSubmissionNodeId = "workflow-video-submit";
const maximumVideoSubmissionTasks = 500;

export async function enqueueWorkflowVideoSubmissionJob(user, input = {}, config = {}, options = {}) {
  const runId = normalizeId(input.runId);
  if (!runId) throw httpError(400, "缺少工作流任务 ID。");
  const run = await getWorkflowRun(user.id, runId, config);
  const tasks = normalizeSubmissionTasks(input.tasks);
  if (!tasks.length) throw httpError(400, "没有可提交的视频任务。");
  if (tasks.length > maximumVideoSubmissionTasks) {
    throw httpError(400, `单次最多可提交 ${maximumVideoSubmissionTasks} 个视频任务。`);
  }

  const jobId = crypto.randomUUID();
  const queuedAt = new Date().toISOString();
  const title = tasks.length > 1 ? `批量提交 ${tasks.length} 个视频任务` : "提交视频任务";
  const progress = submissionProgress(tasks.length);
  const plannedJob = {
    id: jobId,
    nodeId: workflowVideoSubmissionNodeId,
    title,
    status: "queued",
    progress: 0,
    result: progress,
    error: "",
    queuedAt,
    startedAt: "",
    completedAt: "",
    updatedAt: queuedAt,
  };
  const jobInput = {
    id: jobId,
    kind: "tool",
    scope: "video",
    workflowId: run.workflowId,
    runId,
    nodeId: workflowVideoSubmissionNodeId,
    title,
    status: "queued",
    progress: 0,
    payload: { tasks },
    result: progress,
    queuedAt,
  };

  const queuedVideos = tasks.map(({ video }) => ({
    ...video,
    status: "queued",
    error: "",
    message: "已加入后台提交队列。",
    submissionState: "queued",
    submissionJobId: jobId,
    updatedAt: queuedAt,
  }));

  const updatedRun = await updateWorkflowRun(user.id, runId, {
    status: "running",
    completedAt: "",
    error: "",
    stages: {
      ...(run.stages || {}),
      video: "running",
      draft: "pending",
    },
    resultPatch: {
      videoResults: queuedVideos,
      videoStatus: "running",
      backendJobs: {
        ...(run.result?.backendJobs || {}),
        videoSubmit: compactSubmissionJob(plannedJob),
      },
    },
  }, config);

  const createSubmissionJob = options.createSubmissionJob || createJob;
  try {
    const job = await createSubmissionJob(user, jobInput, config);
    return { job, run: updatedRun };
  } catch (error) {
    const failedAt = new Date().toISOString();
    const message = error.message || "视频后台队列创建失败。";
    await updateWorkflowRun(user.id, runId, {
      status: "error",
      error: message,
      stages: {
        ...(updatedRun.stages || {}),
        video: "error",
      },
      resultPatch: {
        videoResults: queuedVideos.map((video) => ({
          ...video,
          status: "error",
          submissionState: "failed",
          error: message,
          message: "",
          updatedAt: failedAt,
        })),
        backendJobs: {
          ...(updatedRun.result?.backendJobs || {}),
          videoSubmit: compactSubmissionJob({
            ...plannedJob,
            status: "error",
            error: message,
            completedAt: failedAt,
            updatedAt: failedAt,
          }),
        },
      },
    }, config).catch(() => null);
    throw error;
  }
}

export async function listQueuedWorkflowVideoSubmissionJobs(config, limit = 1) {
  const jobs = await listRunnableJobs(config, {
    kind: "tool",
    scope: "video",
    nodeId: workflowVideoSubmissionNodeId,
    limit: Math.max(1, Number(limit || 1)),
  });
  return jobs;
}

export async function processWorkflowVideoSubmissionJobById(jobId, config = {}, options = {}) {
  const claimed = await claimQueuedJob(jobId, config);
  if (!claimed) return null;
  let user;
  try {
    user = await getUserById(config, claimed.userId);
  } catch (error) {
    await updateJobInternal(claimed.id, {
      status: "error",
      error: error.message || "后台视频队列无法读取用户信息。",
    }, config);
    throw error;
  }
  await processWorkflowVideoSubmissionJob(user, claimed, config, options);
  return await getJobInternal(jobId, config);
}

export async function processWorkflowVideoSubmissionJob(user, job, config = {}, options = {}) {
  const tasks = normalizeSubmissionTasks(job.payload?.tasks);
  const createVideo = options.createVideoGeneration || createVideoGeneration;
  let submitted = 0;
  let failed = 0;
  let skipped = 0;
  let unknown = 0;

  for (let index = 0; index < tasks.length; index += 1) {
    const currentJob = await getJobInternal(job.id, config);
    if (currentJob.status === "canceled") break;
    const task = tasks[index];
    const run = await getWorkflowRun(user.id, job.runId, config);
    const currentVideo = findVideoResult(run, task.video);
    if (!currentVideo) {
      skipped += 1;
      await reportSubmissionProgress(user, job, config, { submitted, failed, skipped, unknown, total: tasks.length });
      continue;
    }
    if (videoAlreadySubmitted(currentVideo)) {
      submitted += 1;
      await reportSubmissionProgress(user, job, config, { submitted, failed, skipped, unknown, total: tasks.length });
      continue;
    }
    if (currentVideo.submissionState === "submitting") {
      unknown += 1;
      failed += 1;
      await persistVideoResult(user, job, config, {
        ...currentVideo,
        status: "error",
        submissionState: "unknown",
        submissionErrorKind: "submission-unknown",
        error: "服务在提交过程中重启，上游可能已接收任务；为避免重复扣费，未自动重试。",
        message: "",
        updatedAt: new Date().toISOString(),
      });
      await reportSubmissionProgress(user, job, config, { submitted, failed, skipped, unknown, total: tasks.length });
      continue;
    }

    const submittingVideo = {
      ...currentVideo,
      status: "running",
      submissionState: "submitting",
      submissionStartedAt: new Date().toISOString(),
      error: "",
      message: "后台正在提交到模型服务。",
      updatedAt: new Date().toISOString(),
    };
    await persistVideoResult(user, job, config, submittingVideo);

    let result;
    try {
      result = await runWithUserConcurrency(user, "video", () => createVideo(task.request, config, user));
    } catch (error) {
      const recoveredTaskId = extractVideoTaskId(error?.detail);
      if (recoveredTaskId) {
        submitted += 1;
        await persistVideoResult(user, job, config, videoResultFromGeneration(submittingVideo, {
          taskId: recoveredTaskId,
          rawFields: Object.keys(normalizeObject(error?.detail)),
        }));
        await reportSubmissionProgress(user, job, config, { submitted, failed, skipped, unknown, total: tasks.length });
        continue;
      }
      const isUnknown = submissionErrorIsUnknown(error);
      if (isUnknown) unknown += 1;
      failed += 1;
      const errorMessage = error.message || "视频生成提交失败。";
      await persistVideoResult(user, job, config, {
        ...submittingVideo,
        status: "error",
        submissionState: isUnknown ? "unknown" : "failed",
        submissionErrorKind: isUnknown ? "submission-unknown" : "",
        error: isUnknown
          ? `${errorMessage} 上游可能已经创建任务，但本地尚未拿到任务编号；请勿直接重复提交。`
          : errorMessage,
        message: "",
        updatedAt: new Date().toISOString(),
      });
      await reportSubmissionProgress(user, job, config, { submitted, failed, skipped, unknown, total: tasks.length });
      continue;
    }

    submitted += 1;
    await persistVideoResult(user, job, config, videoResultFromGeneration(submittingVideo, result));
    await reportSubmissionProgress(user, job, config, { submitted, failed, skipped, unknown, total: tasks.length });
  }

  const latestJob = await getJobInternal(job.id, config);
  if (latestJob.status === "canceled") {
    await finalizeSubmissionRun(user, latestJob, config);
    return latestJob;
  }
  const finalJob = await updateJobInternal(job.id, {
    status: "done",
    progress: 100,
    error: "",
    result: submissionProgress(tasks.length, { submitted, failed, skipped, unknown }),
  }, config);
  await finalizeSubmissionRun(user, finalJob, config);
  return finalJob;
}

export async function recoverInterruptedWorkflowVideoSubmissionJobs(config = {}) {
  return await requeueInterruptedJobs(config, {
    kind: "tool",
    scope: "video",
    nodeId: workflowVideoSubmissionNodeId,
  });
}

export function startWorkflowVideoSubmissionWorker(config, options = {}) {
  const pollMs = Math.max(500, Number(options.pollMs || config.worker?.pollMs || 1500));
  const batchSize = Math.max(1, Number(options.batchSize || config.worker?.videoSubmissionBatchSize || 1));
  const activeJobIds = new Set();
  let stopped = false;
  let timer = null;
  const recovery = recoverInterruptedWorkflowVideoSubmissionJobs(config).catch((error) => {
    console.error("[video-submit-worker] recovery failed:", error.message || error);
    return [];
  });

  async function tick() {
    if (stopped) return;
    try {
      await recovery;
      const available = Math.max(0, batchSize - activeJobIds.size);
      if (available > 0) {
        const jobs = await listQueuedWorkflowVideoSubmissionJobs(config, available);
        jobs.forEach((job) => {
          if (activeJobIds.has(job.id)) return;
          activeJobIds.add(job.id);
          processWorkflowVideoSubmissionJobById(job.id, config, options)
            .catch((error) => console.error(`[video-submit-worker] job ${job.id} failed:`, error.message || error))
            .finally(() => activeJobIds.delete(job.id));
        });
      }
    } catch (error) {
      console.error("[video-submit-worker] polling failed:", error.message || error);
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

async function persistVideoResult(user, job, config, video) {
  await persistWorkflowVideoTasks(user.id, job.workflowId, job.runId, { videos: [video] }, config);
  const run = await getWorkflowRun(user.id, job.runId, config);
  return await updateWorkflowRun(user.id, job.runId, {
    status: "running",
    completedAt: "",
    error: "",
    stages: {
      ...(run.stages || {}),
      video: "running",
      draft: "pending",
    },
    resultPatch: {
      videoStatus: "running",
      backendJobs: {
        ...(run.result?.backendJobs || {}),
        videoSubmit: compactSubmissionJob(await getJobInternal(job.id, config)),
      },
    },
  }, config);
}

async function reportSubmissionProgress(user, job, config, counts) {
  const processed = counts.submitted + counts.failed + counts.skipped;
  const progress = counts.total ? Math.min(99, Math.round((processed / counts.total) * 100)) : 99;
  const updatedJob = await updateJobInternal(job.id, {
    progress,
    result: submissionProgress(counts.total, counts),
  }, config);
  const run = await getWorkflowRun(user.id, job.runId, config);
  await updateWorkflowRun(user.id, job.runId, {
    status: "running",
    completedAt: "",
    resultPatch: {
      backendJobs: {
        ...(run.result?.backendJobs || {}),
        videoSubmit: compactSubmissionJob(updatedJob),
      },
    },
  }, config);
}

async function finalizeSubmissionRun(user, job, config) {
  const run = await getWorkflowRun(user.id, job.runId, config);
  const jobs = await listJobs(user.id, config, { runId: job.runId, scope: "video" });
  const activeOther = jobs.find((item) => (
    item.id !== job.id
    && item.nodeId === workflowVideoSubmissionNodeId
    && ["queued", "running"].includes(item.status)
  ));
  const videos = Array.isArray(run.result?.videoResults) ? run.result.videoResults : [];
  const videoStatus = videoStageStatus(videos);
  return await updateWorkflowRun(user.id, job.runId, {
    status: activeOther ? "running" : "waiting",
    completedAt: "",
    error: "",
    stages: {
      ...(run.stages || {}),
      video: videoStatus,
      draft: "pending",
    },
    resultPatch: {
      videoStatus,
      backendJobs: {
        ...(run.result?.backendJobs || {}),
        videoSubmit: compactSubmissionJob(activeOther || job),
      },
    },
  }, config);
}

function normalizeSubmissionTasks(tasks) {
  return (Array.isArray(tasks) ? tasks : [])
    .map((task) => ({
      video: normalizeSubmissionVideo(task?.video),
      request: normalizeVideoRequest(task?.request),
    }))
    .filter((task) => workflowVideoResultStorageKey(task.video) && task.request.apiKeyId && task.request.prompt);
}

function normalizeSubmissionVideo(input = {}) {
  const video = normalizeObject(input);
  return {
    ...video,
    id: normalizeId(video.id || video.resultId) || `video_${crypto.randomUUID()}`,
  };
}

function normalizeVideoRequest(input = {}) {
  const request = normalizeObject(input);
  return {
    apiKeyId: normalizeId(request.apiKeyId),
    channel: normalizeId(request.channel),
    modelId: normalizeId(request.modelId),
    modelProvider: normalizeId(request.modelProvider),
    prompt: String(request.prompt || "").trim(),
    ratio: normalizeId(request.ratio),
    resolution: normalizeId(request.resolution),
    duration: normalizeId(request.duration),
    generationMode: normalizeId(request.generationMode),
    frames: (Array.isArray(request.frames) ? request.frames : []).map(normalizeId).filter(Boolean).slice(0, 8),
  };
}

function findVideoResult(run, target) {
  const key = workflowVideoResultStorageKey(target);
  if (!key) return null;
  const videos = Array.isArray(run.result?.videoResults) ? run.result.videoResults : [];
  return videos.find((video) => workflowVideoResultStorageKey(video) === key) || null;
}

function videoAlreadySubmitted(video = {}) {
  return Boolean(video.taskId || video.meta?.taskId || video.videoUrl || video.url)
    || ["done", "completed"].includes(normalizeId(video.status).toLowerCase());
}

function videoResultFromGeneration(video, result = {}) {
  const now = new Date().toISOString();
  const taskId = normalizeId(result.taskId || result.id);
  const videoUrl = normalizeId(result.videoUrl || result.url);
  return {
    ...video,
    status: videoUrl ? "done" : "running",
    videoUrl,
    taskId,
    upstreamStatus: taskId ? "queued" : "",
    submissionState: "submitted",
    submittedAt: now,
    lastQueriedAt: now,
    recentQueryError: "",
    queryError: "",
    error: "",
    message: videoUrl ? "视频已生成。" : "已由后台提交到模型服务。",
    rawFields: Array.isArray(result.rawFields) ? result.rawFields : video.rawFields || [],
    updatedAt: now,
    completedAt: videoUrl ? now : video.completedAt || "",
  };
}

function submissionErrorIsUnknown(error) {
  const status = Number(error?.status || 0);
  const message = String(error?.message || error || "");
  return !status
    || [408, 500, 502, 503, 504].includes(status)
    || /network|fetch|timeout|timed out|超时|网络|连接失败|重置|socket|aborted/i.test(message);
}

function submissionProgress(total, counts = {}) {
  return {
    total: Number(total || 0),
    submitted: Number(counts.submitted || 0),
    failed: Number(counts.failed || 0),
    skipped: Number(counts.skipped || 0),
    unknown: Number(counts.unknown || 0),
    heartbeatAt: new Date().toISOString(),
  };
}

function compactSubmissionJob(job = {}) {
  return {
    id: job.id || "",
    nodeId: workflowVideoSubmissionNodeId,
    title: job.title || "视频后台提交",
    status: job.status || "queued",
    progress: Number(job.progress || 0),
    result: normalizeObject(job.result),
    error: job.error || "",
    queuedAt: job.queuedAt || "",
    startedAt: job.startedAt || "",
    completedAt: job.completedAt || "",
    updatedAt: job.updatedAt || "",
  };
}

function videoStageStatus(videos) {
  const statuses = videos.map((video) => normalizeId(video.status).toLowerCase());
  if (statuses.some((status) => ["running", "processing"].includes(status))) return "running";
  if (statuses.some((status) => ["queued", "pending"].includes(status))) return "queued";
  if (statuses.some((status) => ["done", "completed"].includes(status))) return "partial";
  if (statuses.some((status) => ["error", "failed"].includes(status))) return "error";
  return "pending";
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeId(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}
