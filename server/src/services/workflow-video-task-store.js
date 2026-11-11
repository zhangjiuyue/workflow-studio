import { workflowVideoResultStorageKey } from "../lib/workflow-video-results.mjs";
import { mergeWorkflowVideoTaskRecord } from "../lib/workflow-video-task-record.mjs";
import { readStore, writeStore, getStoreDriver } from "../storage/store.js";
import {
  deleteWorkflowVideoTasksPg,
  listWorkflowVideoTasksPg,
  upsertWorkflowVideoTasksPg,
} from "../storage/postgres-repositories.js";

export async function hydrateWorkflowVideoTasks(userId, runs = [], config) {
  const list = Array.isArray(runs) ? runs : [runs];
  const validRuns = list.filter(Boolean);
  if (!validRuns.length) return Array.isArray(runs) ? [] : null;
  const tasks = isPostgresStore(config)
    ? await listWorkflowVideoTasksPg(config, userId, validRuns.map((run) => run.id))
    : listWorkflowVideoTasksJson(userId, validRuns.map((run) => run.id), config);
  const tasksByRun = new Map();
  tasks.forEach((task) => {
    const current = tasksByRun.get(task.runId) || [];
    current.push(task.video);
    tasksByRun.set(task.runId, current);
  });
  const hydrated = validRuns.map((run) => hydrateRun(run, tasksByRun.get(run.id) || []));
  return Array.isArray(runs) ? hydrated : hydrated[0];
}

export async function persistWorkflowVideoTasks(userId, workflowId, runId, input = {}, config) {
  const videos = Array.isArray(input.videos) ? input.videos.filter(workflowVideoResultStorageKey) : [];
  const removals = Array.isArray(input.removals) ? input.removals.filter(workflowVideoResultStorageKey) : [];
  if (isPostgresStore(config)) {
    if (removals.length) await deleteWorkflowVideoTasksPg(config, userId, runId, removals);
    if (videos.length) {
      await upsertWorkflowVideoTasksPg(config, { userId, workflowId, runId, videos });
    }
    return;
  }

  const store = readStore(config);
  const removalKeys = new Set(removals.map(workflowVideoResultStorageKey));
  store.workflowVideoTasks = (store.workflowVideoTasks || []).filter((task) => (
    task.userId !== userId
    || task.runId !== runId
    || !removalKeys.has(task.resultKey)
  ));
  videos.forEach((video, index) => {
    const resultKey = workflowVideoResultStorageKey(video);
    const existingIndex = store.workflowVideoTasks.findIndex((task) => (
      task.userId === userId && task.runId === runId && task.resultKey === resultKey
    ));
    const existing = existingIndex >= 0 ? store.workflowVideoTasks[existingIndex] : null;
    const now = new Date().toISOString();
    const record = {
      id: existing?.id || `${runId}:${resultKey}`,
      userId,
      workflowId,
      runId,
      resultKey,
      sortOrder: existing?.sortOrder ?? index,
      video: existing ? mergeWorkflowVideoTaskRecord(existing.video, video) : { ...video },
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    if (existingIndex >= 0) store.workflowVideoTasks[existingIndex] = record;
    else store.workflowVideoTasks.push(record);
  });
  writeStore(config, store);
}

function listWorkflowVideoTasksJson(userId, runIds, config) {
  const requested = new Set(runIds);
  return (readStore(config).workflowVideoTasks || [])
    .filter((task) => task.userId === userId && requested.has(task.runId))
    .sort((left, right) => (
      String(left.runId).localeCompare(String(right.runId))
      || Number(left.sortOrder || 0) - Number(right.sortOrder || 0)
      || String(left.createdAt || "").localeCompare(String(right.createdAt || ""))
    ));
}

function hydrateRun(run, storedVideos) {
  const result = run.result && typeof run.result === "object" ? run.result : {};
  const tombstones = result.videoResultTombstones && typeof result.videoResultTombstones === "object"
    ? result.videoResultTombstones
    : {};
  const isRemoved = (video) => Boolean(tombstones[workflowVideoResultStorageKey(video)]);
  const legacyVideos = (Array.isArray(result.videoResults) ? result.videoResults : []).filter((video) => !isRemoved(video));
  const authoritativeVideos = storedVideos.filter((video) => !isRemoved(video));
  const authoritativeByKey = new Map(authoritativeVideos.map((video) => [workflowVideoResultStorageKey(video), video]));
  const includedKeys = new Set();
  const videoResults = legacyVideos.map((video) => {
    const key = workflowVideoResultStorageKey(video);
    const authoritative = authoritativeByKey.get(key);
    if (authoritative) includedKeys.add(key);
    return authoritative || video;
  });
  authoritativeVideos.forEach((video) => {
    const key = workflowVideoResultStorageKey(video);
    if (!includedKeys.has(key)) videoResults.push(video);
  });
  return {
    ...run,
    result: {
      ...result,
      videoResults,
    },
  };
}

function isPostgresStore(config) {
  return getStoreDriver(config) === "postgres";
}
