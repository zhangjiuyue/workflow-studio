import crypto from "node:crypto";
import { httpError } from "../http.js";
import { mergeWorkflowVideoResultLists, removeWorkflowVideoResultInstances, workflowVideoResultStorageKey } from "../lib/workflow-video-results.mjs";
import { readStore, writeStore, getStoreDriver } from "../storage/store.js";
import { hydrateWorkflowVideoTasks, persistWorkflowVideoTasks } from "./workflow-video-task-store.js";
import {
  countWorkflowsPg,
  deleteWorkflowPg,
  getWorkflowPg,
  getWorkflowRunPg,
  getWorkflowRunSummaryPg,
  listWorkflowChildRunsPg,
  listWorkflowChildRunSummariesPg,
  listWorkflowRunSummariesPg,
  listWorkflowRunsPg,
  listWorkflowRunsWithActiveAudioPg,
  listWorkflowRunsWithActiveImagesPg,
  listWorkflowsPg,
  markWorkflowAudioRunTimedOutPg,
  patchWorkflowRunBackendJobPg,
  patchWorkflowRunImageShotPg,
  upsertWorkflowPg,
  upsertWorkflowRunPg,
} from "../storage/postgres-repositories.js";

export async function listWorkflows(userId, config) {
  if (isPostgresStore(config)) {
    const workflows = await listWorkflowsPg(config, userId);
    const runs = await hydrateWorkflowVideoTasks(userId, await listWorkflowRunsPg(config, userId), config);
    return workflows.map((workflow) => withRuns(workflow, { workflowRuns: runs }));
  }
  const store = readStore(config);
  const runs = await hydrateWorkflowVideoTasks(userId, store.workflowRuns, config);
  return store.workflows
    .filter((workflow) => workflow.userId === userId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map((workflow) => withRuns(workflow, { workflowRuns: runs }));
}

export async function listWorkflowSummaries(userId, config) {
  if (isPostgresStore(config)) {
    const workflows = await listWorkflowsPg(config, userId);
    const runs = await hydrateWorkflowVideoTasks(userId, await listWorkflowRunSummariesPg(config, userId), config);
    const summaries = runs.map(workflowRunListSummary);
    return workflows.map((workflow) => withRuns(workflow, { workflowRuns: summaries }));
  }
  const store = readStore(config);
  const runs = await hydrateWorkflowVideoTasks(userId, store.workflowRuns, config);
  const summaries = runs.map(workflowRunListSummary);
  return store.workflows
    .filter((workflow) => workflow.userId === userId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map((workflow) => withRuns(workflow, { workflowRuns: summaries }));
}

export async function getWorkflow(userId, workflowId, config) {
  if (isPostgresStore(config)) return findWorkflowPg(config, userId, workflowId);
  return findWorkflow(readStore(config), userId, workflowId);
}

export async function listWorkflowRunsWithActiveImages(config, limit = 100) {
  if (isPostgresStore(config)) return listWorkflowRunsWithActiveImagesPg(config, limit);
  const store = readStore(config);
  return store.workflowRuns
    .filter((run) => run.status !== "deleted" && workflowRunHasActiveImages(run))
    .sort((left, right) => String(left.updatedAt || left.createdAt).localeCompare(String(right.updatedAt || right.createdAt)))
    .slice(0, Math.max(1, Number(limit || 100)))
    .map((run) => ({ ...run }));
}

export async function listWorkflowRunsWithActiveAudio(config, limit = 100) {
  if (isPostgresStore(config)) return listWorkflowRunsWithActiveAudioPg(config, limit);
  const store = readStore(config);
  return store.workflowRuns
    .filter((run) => run.status !== "deleted" && workflowRunHasActiveAudio(run))
    .sort((left, right) => String(left.updatedAt || left.createdAt).localeCompare(String(right.updatedAt || right.createdAt)))
    .slice(0, Math.max(1, Number(limit || 100)))
    .map((run) => ({ ...run }));
}

export async function markWorkflowAudioRunTimedOut(userId, runId, input, config) {
  const staleBefore = new Date(input?.staleBefore || 0);
  if (!Number.isFinite(staleBefore.getTime())) return null;
  const message = String(input?.message || "音频生成超时，已自动结束，请重试。");
  const timedOutAt = new Date(input?.timedOutAt || Date.now()).toISOString();
  if (isPostgresStore(config)) {
    return markWorkflowAudioRunTimedOutPg(config, userId, runId, {
      staleBefore: staleBefore.toISOString(),
      timedOutAt,
      message,
    });
  }

  const store = readStore(config);
  const run = store.workflowRuns.find((item) => item.id === runId && item.userId === userId);
  if (!run || run.status === "deleted" || !workflowRunHasActiveAudio(run)) return null;
  const updatedAt = new Date(run.updatedAt || run.createdAt || 0).getTime();
  if (!Number.isFinite(updatedAt) || updatedAt > staleBefore.getTime()) return null;
  run.status = "error";
  run.stages = {
    ...normalizeObject(run.stages),
    audio: "error",
  };
  run.result = {
    ...normalizeObject(run.result),
    audioStatus: "error",
    audioError: message,
    audioProgress: {
      ...normalizeObject(run.result?.audioProgress),
      status: "error",
      timedOutAt,
      message,
    },
  };
  run.error = message;
  run.completedAt = "";
  run.updatedAt = timedOutAt;
  writeStore(config, store);
  return withChildren(run, store);
}

export async function createWorkflow(user, input, config) {
  const inputId = normalizeId(input.id);
  if (isPostgresStore(config)) {
    const existing = inputId ? await getWorkflowPg(config, user.id, inputId) : null;
    if (!existing) await assertWorkflowQuotaPg(user, config);
    const now = new Date().toISOString();
    const workflowConfig = normalizeObject(input.config);
    const workflow = {
      id: inputId || crypto.randomUUID(),
      userId: user.id,
      name: requiredText(input.name, "请填写工作流名称。"),
      type: String(input.type || "explain").trim(),
      config: workflowConfig,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    if (!existing) assertEcommerceProductImagesReady(workflow);
    const saved = await upsertWorkflowPg(config, workflow);
    if (!saved) throw httpError(403, "无法保存工作流。");
    return withRuns(saved, { workflowRuns: [] });
  }
  const store = readStore(config);
  const existingIndex = store.workflows.findIndex((item) => item.id === inputId && item.userId === user.id);
  if (existingIndex < 0) assertWorkflowQuota(user, store);
  const now = new Date().toISOString();
  const workflowConfig = normalizeObject(input.config);
  const workflow = {
    id: inputId || crypto.randomUUID(),
    userId: user.id,
    name: requiredText(input.name, "请填写工作流名称。"),
    type: String(input.type || "explain").trim(),
    config: workflowConfig,
    createdAt: existingIndex >= 0 ? store.workflows[existingIndex].createdAt : now,
    updatedAt: now,
  };
  if (existingIndex < 0) assertEcommerceProductImagesReady(workflow);
  if (existingIndex >= 0) {
    store.workflows[existingIndex] = workflow;
  } else {
    store.workflows.unshift(workflow);
  }
  writeStore(config, store);
  return withRuns(workflow, store);
}

export async function updateWorkflow(userId, workflowId, input, config) {
  if (isPostgresStore(config)) {
    const workflow = await findWorkflowPg(config, userId, workflowId);
    const updated = {
      ...workflow,
      name: input.name ? String(input.name).trim() : workflow.name,
      type: input.type ? String(input.type).trim() : workflow.type,
      config: {
        ...(workflow.config || {}),
        ...normalizeObject(input.config),
      },
      updatedAt: new Date().toISOString(),
    };
    assertEcommerceProductImagesReady(updated);
    const saved = await upsertWorkflowPg(config, updated);
    if (!saved) throw httpError(403, "无法更新工作流。");
    const runs = await listWorkflowRunsPg(config, userId, saved.id);
    return withRuns(saved, { workflowRuns: runs });
  }
  const store = readStore(config);
  const workflow = findWorkflow(store, userId, workflowId);
  workflow.name = input.name ? String(input.name).trim() : workflow.name;
  workflow.type = input.type ? String(input.type).trim() : workflow.type;
  workflow.config = {
    ...(workflow.config || {}),
    ...normalizeObject(input.config),
  };
  workflow.updatedAt = new Date().toISOString();
  assertEcommerceProductImagesReady(workflow);
  writeStore(config, store);
  return withRuns(workflow, store);
}

export async function deleteWorkflow(userId, workflowId, config) {
  if (isPostgresStore(config)) {
    await findWorkflowPg(config, userId, workflowId);
    await deleteWorkflowPg(config, userId, workflowId);
    return { id: workflowId };
  }
  const store = readStore(config);
  findWorkflow(store, userId, workflowId);
  store.workflows = store.workflows.filter((workflow) => !(workflow.id === workflowId && workflow.userId === userId));
  store.workflowRuns = store.workflowRuns.filter((run) => !(run.workflowId === workflowId && run.userId === userId));
  store.workflowVideoTasks = (store.workflowVideoTasks || [])
    .filter((task) => !(task.workflowId === workflowId && task.userId === userId));
  writeStore(config, store);
  return { id: workflowId };
}

export async function createWorkflowRun(userId, workflowId, input, config) {
  if (isPostgresStore(config)) {
    const workflow = await findWorkflowPg(config, userId, workflowId);
    const run = buildRun({
      ...input,
      workflowId,
      userId,
      kind: "topic-seed",
      parentRunId: "",
      result: runResultWithWorkflowSnapshot(input.result, workflow),
    });
    const videos = Array.isArray(run.result?.videoResults) ? run.result.videoResults : [];
    const saved = await upsertWorkflowRunPg(config, workflowRunWithoutEmbeddedVideoResults(run));
    if (!saved) throw httpError(403, "无法创建工作流任务。");
    await persistWorkflowVideoTasks(userId, workflowId, saved.id, { videos }, config);
    return withChildren(await hydrateWorkflowVideoTasks(userId, saved, config), { workflowRuns: [] });
  }
  const store = readStore(config);
  const workflow = findWorkflow(store, userId, workflowId);
  const run = buildRun({
    ...input,
    workflowId,
    userId,
    kind: "topic-seed",
    parentRunId: "",
    result: runResultWithWorkflowSnapshot(input.result, workflow),
  });
  const existingIndex = store.workflowRuns.findIndex((item) => item.id === run.id && item.workflowId === workflowId && item.userId === userId);
  let savedRun = run;
  if (existingIndex >= 0) {
    savedRun = {
      ...store.workflowRuns[existingIndex],
      ...run,
      createdAt: store.workflowRuns[existingIndex].createdAt || run.createdAt,
    };
    store.workflowRuns[existingIndex] = savedRun;
  } else {
    store.workflowRuns.unshift(run);
  }
  await persistWorkflowVideoTasks(userId, workflowId, savedRun.id, {
    videos: Array.isArray(savedRun.result?.videoResults) ? savedRun.result.videoResults : [],
  }, config);
  writeStore(config, store);
  return withChildren(await hydrateWorkflowVideoTasks(userId, savedRun, config), store);
}

export async function confirmWorkflowTopics(userId, runId, input, config) {
  if (isPostgresStore(config)) return confirmWorkflowTopicsPg(userId, runId, input, config);
  const store = readStore(config);
  const run = findRun(store, userId, runId);
  const workflow = findWorkflow(store, userId, run.workflowId);
  if (!["main", "topic-seed"].includes(run.kind)) {
    throw httpError(400, "只有主任务可以确认选题。");
  }
  const topics = normalizeTopics(input.topics || input.confirmedTopics);
  if (!topics.length) throw httpError(400, "请选择至少一个选题。");
  const inputScriptMode = normalizeId(workflow.config?.topicMode) === "script";
  const topicAdaptations = normalizeTopicAdaptations(input.topicAdaptations || run.result?.topicAdaptations);
  const topicAdaptationBrief = String(input.topicAdaptationBrief || run.result?.topicAdaptationBrief || "").trim();
  const existingTopics = new Set(
    store.workflowRuns
      .filter((item) => item.parentRunId === run.id && item.userId === userId)
      .map((item) => normalizeTopicTitle(item.topic)),
  );
  const now = new Date().toISOString();
  run.confirmedTopics = uniqueTopics([...(run.confirmedTopics || []), ...topics]);
  run.status = "waiting";
  run.stages = {
    ...(run.stages || {}),
    topic: inputScriptMode ? "skipped" : "done",
  };
  run.completedAt = run.completedAt || now;
  const children = [];
  for (const topic of topics) {
    if (existingTopics.has(normalizeTopicTitle(topic))) continue;
    const topicAdaptation = topicAdaptationFor(topic, topicAdaptations) || topicAdaptationBrief;
    const child = buildRun({
      workflowId: run.workflowId,
      userId,
      parentRunId: run.id,
      kind: "topic-child",
      result: runResultWithWorkflowSnapshot({
        topicAdaptation,
        topicAdaptations: topicAdaptation ? { [topic]: topicAdaptation } : {},
        topicAdaptationBrief,
      }, workflow, run),
      topic,
      status: "waiting",
      stages: {
        topic: "skipped",
        outline: "skipped",
        script: "pending",
        optimize: "pending",
        audio: "pending",
        shot: "pending",
        image: "pending",
        videoPrompt: "pending",
        video: "pending",
        draft: "pending",
      },
    });
    store.workflowRuns.push(child);
    children.push(child);
  }
  writeStore(config, store);
  return {
    run: withChildren(run, store),
    children,
  };
}

export async function updateWorkflowRun(userId, runId, input, config) {
  if (isPostgresStore(config)) {
    const run = await findRunPg(config, userId, runId);
    const videoTaskInput = workflowVideoTaskChanges(run, input);
    const patch = normalizeRunPatch(input);
    const resultPatch = normalizeWorkflowRunResultPatch(run.result, input);
    if (Object.keys(resultPatch).length) patch.result = { ...normalizeObject(run.result), ...resultPatch };
    if (patch.result) patch.result = mergeRunResultPatch(run.result, patch.result, patch);
    normalizeImageRunPatch(patch);
    const updated = {
      ...run,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await persistWorkflowVideoTasks(userId, run.workflowId, runId, videoTaskInput, config);
    const saved = await upsertWorkflowRunPg(config, workflowRunWithoutEmbeddedVideoResults(updated));
    if (!saved) throw httpError(403, "无法更新任务。");
    const runs = await hydrateWorkflowVideoTasks(
      userId,
      await listWorkflowRunsPg(config, userId, saved.workflowId),
      config,
    );
    return withChildren(await hydrateWorkflowVideoTasks(userId, saved, config), { workflowRuns: runs });
  }
  const store = readStore(config);
  const run = findRun(store, userId, runId);
  const videoTaskInput = workflowVideoTaskChanges(run, input);
  const patch = normalizeRunPatch(input);
  const resultPatch = normalizeWorkflowRunResultPatch(run.result, input);
  if (Object.keys(resultPatch).length) patch.result = { ...normalizeObject(run.result), ...resultPatch };
  if (patch.result) patch.result = mergeRunResultPatch(run.result, patch.result, patch);
  normalizeImageRunPatch(patch);
  await persistWorkflowVideoTasks(userId, run.workflowId, runId, videoTaskInput, config);
  Object.assign(run, patch, { updatedAt: new Date().toISOString() });
  writeStore(config, store);
  return withChildren(await hydrateWorkflowVideoTasks(userId, run, config), store);
}

export async function getWorkflowRun(userId, runId, config) {
  if (isPostgresStore(config)) {
    const run = await getWorkflowRunPg(config, userId, runId);
    if (!run) throw httpError(404, "任务不存在。");
    const children = await listWorkflowChildRunsPg(config, userId, run.id);
    const hydrated = await hydrateWorkflowVideoTasks(userId, [run, ...children], config);
    return withChildren(hydrated[0], { workflowRuns: hydrated.slice(1) });
  }
  const store = readStore(config);
  const run = findRun(store, userId, runId);
  const children = store.workflowRuns.filter((item) => item.parentRunId === run.id && item.userId === userId);
  const hydrated = await hydrateWorkflowVideoTasks(userId, [run, ...children], config);
  return withChildren(hydrated[0], { workflowRuns: hydrated.slice(1) });
}

export async function getWorkflowTopicConfirmationStatus(userId, runId, config) {
  if (isPostgresStore(config)) {
    const run = await getWorkflowRunSummaryPg(config, userId, runId);
    if (!run) throw httpError(404, "任务不存在。");
    assertTopicConfirmationRun(run);
    const children = await listWorkflowChildRunSummariesPg(config, userId, run.id);
    return withChildren(run, { workflowRuns: children });
  }
  const store = readStore(config);
  const run = findRun(store, userId, runId);
  assertTopicConfirmationRun(run);
  const children = store.workflowRuns
    .filter((item) => item.parentRunId === run.id && item.userId === userId)
    .map(topicRunSummary);
  return withChildren(topicRunSummary(run), { workflowRuns: children });
}

export async function listWorkflowTopicExecutionChildren(userId, runId, input, config) {
  const run = isPostgresStore(config)
    ? await getWorkflowRunSummaryPg(config, userId, runId)
    : findRun(readStore(config), userId, runId);
  if (!run) throw httpError(404, "任务不存在。");
  assertTopicConfirmationRun(run);

  const children = isPostgresStore(config)
    ? await listWorkflowChildRunsPg(config, userId, run.id)
    : readStore(config).workflowRuns.filter((item) => item.parentRunId === run.id && item.userId === userId);
  const requestedChildIds = new Set(normalizeIds(input?.childIds));
  const requestedTopics = new Set(normalizeTopics(input?.topics).map(normalizeTopicTitle));
  const confirmedTopics = new Set(normalizeTopics(run.confirmedTopics).map(normalizeTopicTitle));
  return children.filter((child) => {
    if (!confirmedTopics.has(normalizeTopicTitle(child.topic))) return false;
    if (requestedChildIds.size && !requestedChildIds.has(child.id)) return false;
    if (requestedTopics.size && !requestedTopics.has(normalizeTopicTitle(child.topic))) return false;
    return workflowTopicChildCanStartScript(child);
  });
}

export async function patchWorkflowRunImageShot(userId, runId, input, config) {
  const shotId = normalizeId(input?.shotId);
  if (!shotId) throw httpError(400, "缺少分镜 ID。");
  if (isPostgresStore(config)) {
    return patchWorkflowRunImageShotPg(config, userId, runId, {
      ...(input || {}),
      shotId,
    });
  }

  const store = readStore(config);
  const run = findRun(store, userId, runId);
  const result = run.result && typeof run.result === "object" ? run.result : {};
  const shots = Array.isArray(result.shots) ? result.shots : [];
  const shot = shots.find((item) => workflowShotId(item) === shotId) || null;
  if (!shot || !workflowImageShotPatchMatches(shot, input)) {
    return { run: withChildren(run, store), shot, updated: false };
  }
  Object.assign(shot, normalizeObject(input.patch));
  run.result = {
    ...result,
    shots,
  };
  run.updatedAt = new Date().toISOString();
  writeStore(config, store);
  return { run: withChildren(run, store), shot, updated: true };
}

export async function patchWorkflowRunBackendJob(userId, runId, input, config) {
  const nodeId = normalizeId(input?.nodeId);
  if (!nodeId) throw httpError(400, "缺少工作流节点 ID。");
  if (isPostgresStore(config)) {
    const updated = await patchWorkflowRunBackendJobPg(config, userId, runId, {
      ...(input || {}),
      nodeId,
    });
    if (!updated) throw httpError(403, "无法更新工作流任务状态。");
    return updated;
  }

  const store = readStore(config);
  const run = findRun(store, userId, runId);
  const result = normalizeObject(run.result);
  const backendJobs = normalizeObject(result.backendJobs);
  const runPatch = normalizeRunPatch(input?.runPatch || {});
  delete runPatch.result;
  delete runPatch.stages;
  Object.assign(run, runPatch, {
    stages: {
      ...normalizeObject(run.stages),
      ...normalizeObject(input?.stages),
    },
    result: {
      ...result,
      backendJobs: {
        ...backendJobs,
        [nodeId]: normalizeObject(input?.job),
      },
    },
    updatedAt: new Date().toISOString(),
  });
  writeStore(config, store);
  return withChildren(run, store);
}

function isPostgresStore(config) {
  return getStoreDriver(config) === "postgres";
}

async function assertWorkflowQuotaPg(user, config) {
  if (user.role === "admin") return;
  const limit = Number(user.membership?.workflowLimit || 0);
  if (!limit) return;
  const count = await countWorkflowsPg(config, user.id);
  if (count >= limit) {
    throw httpError(403, `当前会员最多可保存 ${limit} 条工作流。`, {
      code: "WORKFLOW_LIMIT_REACHED",
      limit,
      count,
    });
  }
}

async function confirmWorkflowTopicsPg(userId, runId, input, config) {
  const run = await findRunPg(config, userId, runId);
  const workflow = await findWorkflowPg(config, userId, run.workflowId);
  if (!["main", "topic-seed"].includes(run.kind)) {
    throw httpError(400, "只有主任务可以确认选题。");
  }
  const topics = normalizeTopics(input.topics || input.confirmedTopics);
  if (!topics.length) throw httpError(400, "请选择至少一个选题。");
  const inputScriptMode = normalizeId(workflow.config?.topicMode) === "script";
  const topicAdaptations = normalizeTopicAdaptations(input.topicAdaptations || run.result?.topicAdaptations);
  const topicAdaptationBrief = String(input.topicAdaptationBrief || run.result?.topicAdaptationBrief || "").trim();
  const existingChildren = await listWorkflowChildRunSummariesPg(config, userId, run.id);
  const existingTopics = new Set(
    existingChildren.map((item) => normalizeTopicTitle(item.topic)),
  );
  const now = new Date().toISOString();
  const updatedRun = await upsertWorkflowRunPg(config, {
    ...run,
    confirmedTopics: uniqueTopics([...(run.confirmedTopics || []), ...topics]),
    status: "waiting",
    stages: {
      ...(run.stages || {}),
      topic: inputScriptMode ? "skipped" : "done",
    },
    completedAt: run.completedAt || now,
    updatedAt: now,
  });
  if (!updatedRun) throw httpError(403, "无法确认选题。");
  const pendingChildren = [];
  for (const topic of topics) {
    if (existingTopics.has(normalizeTopicTitle(topic))) continue;
    const topicAdaptation = topicAdaptationFor(topic, topicAdaptations) || topicAdaptationBrief;
    const child = buildRun({
      workflowId: run.workflowId,
      userId,
      parentRunId: run.id,
      kind: "topic-child",
      result: runResultWithWorkflowSnapshot({
        topicAdaptation,
        topicAdaptations: topicAdaptation ? { [topic]: topicAdaptation } : {},
        topicAdaptationBrief,
      }, workflow, run),
      topic,
      status: "waiting",
      stages: {
        topic: "skipped",
        outline: "skipped",
        script: "pending",
        optimize: "pending",
        audio: "pending",
        shot: "pending",
        image: "pending",
        videoPrompt: "pending",
        video: "pending",
        draft: "pending",
      },
    });
    pendingChildren.push(child);
  }
  const children = [];
  for (let index = 0; index < pendingChildren.length; index += 3) {
    const savedChildren = await Promise.all(
      pendingChildren.slice(index, index + 3).map((child) => upsertWorkflowRunPg(config, child)),
    );
    children.push(...savedChildren.filter(Boolean));
  }
  const nextChildren = [...existingChildren, ...children];
  return {
    run: withChildren(updatedRun, { workflowRuns: nextChildren }),
    children,
  };
}

async function findWorkflowPg(config, userId, workflowId) {
  const workflow = await getWorkflowPg(config, userId, workflowId);
  if (!workflow) throw httpError(404, "工作流不存在。");
  return workflow;
}

async function findRunPg(config, userId, runId) {
  const run = await getWorkflowRunPg(config, userId, runId);
  if (!run) throw httpError(404, "任务不存在。");
  return await hydrateWorkflowVideoTasks(userId, run, config);
}

function assertWorkflowQuota(user, store) {
  if (user.role === "admin") return;
  const limit = Number(user.membership?.workflowLimit || 0);
  if (!limit) return;
  const count = store.workflows.filter((workflow) => workflow.userId === user.id).length;
  if (count >= limit) {
    throw httpError(403, `当前会员最多可保存 ${limit} 条工作流。`, {
      code: "WORKFLOW_LIMIT_REACHED",
      limit,
      count,
    });
  }
}

function buildRun(input) {
  const now = new Date().toISOString();
  return {
    id: normalizeId(input.id) || crypto.randomUUID(),
    workflowId: input.workflowId,
    userId: input.userId,
    parentRunId: String(input.parentRunId || ""),
    kind: input.kind || "main",
    serial: String(input.serial || randomRunSerial()),
    topic: String(input.topic || "").trim(),
    status: String(input.status || "waiting").trim(),
    stages: normalizeObject(input.stages),
    generatedTopics: normalizeTopics(input.generatedTopics),
    confirmedTopics: normalizeTopics(input.confirmedTopics),
    confirmedTopicIndexes: Array.isArray(input.confirmedTopicIndexes) ? input.confirmedTopicIndexes : [],
    selectedTopics: normalizeTopics(input.selectedTopics),
    topicGenerationStatus: String(input.topicGenerationStatus || ""),
    topicGenerationError: String(input.topicGenerationError || ""),
    result: normalizeObject(input.result),
    error: String(input.error || ""),
    createdAt: input.createdAt || now,
    startedAt: input.startedAt || "",
    completedAt: input.completedAt || "",
    updatedAt: input.updatedAt || now,
  };
}

function normalizeRunPatch(input = {}) {
  const patch = {};
  if (input.topic !== undefined) patch.topic = String(input.topic || "").trim();
  if (input.status !== undefined) patch.status = String(input.status || "").trim();
  if (input.stages !== undefined) patch.stages = normalizeObject(input.stages);
  if (input.generatedTopics !== undefined) patch.generatedTopics = normalizeTopics(input.generatedTopics);
  if (input.confirmedTopics !== undefined) patch.confirmedTopics = normalizeTopics(input.confirmedTopics);
  if (input.confirmedTopicIndexes !== undefined) patch.confirmedTopicIndexes = Array.isArray(input.confirmedTopicIndexes) ? input.confirmedTopicIndexes : [];
  if (input.selectedTopics !== undefined) patch.selectedTopics = normalizeTopics(input.selectedTopics);
  if (input.topicGenerationStatus !== undefined) patch.topicGenerationStatus = String(input.topicGenerationStatus || "");
  if (input.topicGenerationError !== undefined) patch.topicGenerationError = String(input.topicGenerationError || "");
  if (input.serial !== undefined) patch.serial = String(input.serial || "");
  if (input.result !== undefined) patch.result = normalizeObject(input.result);
  if (input.error !== undefined) patch.error = String(input.error || "");
  if (input.startedAt !== undefined) patch.startedAt = String(input.startedAt || "");
  if (input.completedAt !== undefined) patch.completedAt = String(input.completedAt || "");
  return patch;
}

function workflowVideoTaskChanges(run, input = {}) {
  const resultInput = normalizeObject(input.resultPatch);
  const fullResultInput = normalizeObject(input.result);
  const incomingVideos = Array.isArray(resultInput.videoResults)
    ? resultInput.videoResults
    : (Array.isArray(fullResultInput.videoResults) ? fullResultInput.videoResults : []);
  const currentVideos = Array.isArray(run.result?.videoResults) ? run.result.videoResults : [];
  const currentByKey = new Map(currentVideos.map((video) => [workflowVideoResultStorageKey(video), video]));
  const videos = incomingVideos.filter((video) => {
    const key = workflowVideoResultStorageKey(video);
    if (!key) return false;
    const current = currentByKey.get(key);
    return !current || JSON.stringify(current) !== JSON.stringify(video);
  });
  return {
    videos,
    removals: Array.isArray(input.videoResultRemovals) ? input.videoResultRemovals : [],
  };
}

function workflowRunWithoutEmbeddedVideoResults(run) {
  const result = { ...normalizeObject(run.result) };
  delete result.videoResults;
  return { ...run, result };
}

function normalizeWorkflowRunResultPatch(existingResult = {}, input = {}) {
  const existing = normalizeObject(existingResult);
  const resultPatch = { ...normalizeObject(input.resultPatch) };
  const removals = Array.isArray(input.videoResultRemovals) ? input.videoResultRemovals : [];
  if (Array.isArray(resultPatch.videoResults) || removals.length) {
    const removedAt = new Date().toISOString();
    const tombstones = {
      ...normalizeObject(existing.videoResultTombstones),
      ...Object.fromEntries(removals
        .map((video) => workflowVideoResultStorageKey(video))
        .filter(Boolean)
        .map((key) => [key, removedAt])),
    };
    const isRemoved = (video) => Boolean(tombstones[workflowVideoResultStorageKey(video)]);
    const mergedResults = mergeWorkflowVideoResultLists(
      (Array.isArray(existing.videoResults) ? existing.videoResults : []).filter((video) => !isRemoved(video)),
      (Array.isArray(resultPatch.videoResults) ? resultPatch.videoResults : []).filter((video) => !isRemoved(video)),
    );
    resultPatch.videoResults = removeWorkflowVideoResultInstances(mergedResults, removals);
    resultPatch.videoResultTombstones = tombstones;
  }
  return resultPatch;
}

function mergeRunResultPatch(existingResult = {}, nextResult = {}, patch = {}) {
  const existing = normalizeObject(existingResult);
  const next = normalizeObject(nextResult);
  if (!Array.isArray(existing.shots) || !Array.isArray(next.shots)) return next;
  const shouldProtectImages = patch.status === "error" || ["error", "running"].includes(patch.stages?.image || "");
  if (!shouldProtectImages) return next;

  const existingById = new Map(existing.shots.map((shot) => [workflowShotId(shot), shot]));
  const currentImageJobId = normalizeId(existing.backendJobs?.image?.id);
  return {
    ...next,
    shots: next.shots.map((shot) => {
      const existingShot = existingById.get(workflowShotId(shot));
      const existingShotJobId = normalizeId(existingShot?.imageJobId);
      const incomingShotJobId = normalizeId(shot?.imageJobId);
      if (
        currentImageJobId
        && existingShotJobId === currentImageJobId
        && (
          incomingShotJobId !== currentImageJobId
          || workflowImageExecutionRegressed(shot, existingShot)
        )
      ) {
        return mergeCurrentImageExecution(shot, existingShot);
      }
      if (!existingShot?.imageUrl || shot.imageUrl || shot.imageRegenerateNonce) return shot;
      return {
        ...shot,
        imageUrl: existingShot.imageUrl,
        imageThumbnailUrl: existingShot.imageThumbnailUrl || "",
        imageStatus: "done",
        imageError: "",
        imagePauseReason: "",
      };
    }),
  };
}

function workflowImageExecutionRegressed(incomingShot = {}, existingShot = {}) {
  const incomingRequestId = normalizeId(incomingShot.imageRequestId);
  const existingRequestId = normalizeId(existingShot.imageRequestId);
  if (existingRequestId && incomingRequestId !== existingRequestId) return true;
  const statusRank = {
    pending: 0,
    queued: 1,
    running: 2,
    paused: 3,
    error: 3,
    done: 4,
  };
  const incomingRank = statusRank[normalizeId(incomingShot.imageStatus)] ?? 0;
  const existingRank = statusRank[normalizeId(existingShot.imageStatus)] ?? 0;
  if (incomingRank < existingRank) return true;
  if (normalizeId(existingShot.imageStartedAt) && !normalizeId(incomingShot.imageStartedAt)) return true;
  if (normalizeId(existingShot.imageSubmittedAt) && !normalizeId(incomingShot.imageSubmittedAt)) return true;
  return false;
}

function mergeCurrentImageExecution(incomingShot = {}, existingShot = {}) {
  return {
    ...incomingShot,
    imageUrl: existingShot.imageUrl || "",
    imageThumbnailUrl: existingShot.imageThumbnailUrl || "",
    imageStatus: existingShot.imageStatus || "",
    imageSource: existingShot.imageSource || "",
    imageError: existingShot.imageError || "",
    imagePauseReason: existingShot.imagePauseReason || "",
    imageJobId: existingShot.imageJobId || "",
    imageQueuedAt: existingShot.imageQueuedAt || "",
    imageStartedAt: existingShot.imageStartedAt || "",
    imageCompletedAt: existingShot.imageCompletedAt || "",
    imageRequestId: existingShot.imageRequestId || "",
    imageSubmittedAt: existingShot.imageSubmittedAt || "",
    imageResultUnknown: Boolean(existingShot.imageResultUnknown),
    imageProviderTaskId: existingShot.imageProviderTaskId || "",
    imageProviderChannel: existingShot.imageProviderChannel || "",
    imageProviderStatus: existingShot.imageProviderStatus || "",
    imageProviderLastSyncedAt: existingShot.imageProviderLastSyncedAt || "",
    imageRegenerateNonce: existingShot.imageRegenerateNonce || "",
  };
}

function normalizeImageRunPatch(patch = {}) {
  if (!patch.result?.shots || !Array.isArray(patch.result.shots)) return patch;
  const shots = patch.result.shots;
  if (!shots.length) return patch;
  const missingShots = shots.filter((shot) => !shot.imageUrl);
  const runningMissingShots = missingShots.filter((shot) => shot.imageStatus === "running");
  if (!missingShots.length) {
    const imageStageStatus = normalizeId(patch.stages?.image);
    const imageJobStatus = normalizeId(patch.result?.backendJobs?.image?.status);
    const imageWasActiveOrFailed = ["running", "error"].includes(imageStageStatus)
      || ["queued", "running", "error"].includes(imageJobStatus);
    const anotherNodeIsActiveOrFailed = Object.entries(patch.stages || {}).some(([stageId, status]) => (
      stageId !== "image" && ["queued", "running", "error"].includes(normalizeId(status))
    )) || Object.entries(patch.result?.backendJobs || {}).some(([nodeId, job]) => (
      nodeId !== "image" && ["queued", "running", "error"].includes(normalizeId(job?.status))
    ));
    patch.result = {
      ...patch.result,
      shots: shots.map((shot) => ({
        ...shot,
        imageStatus: "done",
        imageError: "",
        imagePauseReason: "",
      })),
    };
    patch.stages = {
      ...(patch.stages || {}),
      image: "done",
    };
    if (
      imageWasActiveOrFailed
      && !anotherNodeIsActiveOrFailed
      && (patch.status === "running" || patch.status === "error")
    ) patch.status = "waiting";
    return patch;
  }
  if (runningMissingShots.length) {
    patch.stages = {
      ...(patch.stages || {}),
      image: "running",
    };
    if (patch.status !== "deleted") patch.status = "running";
  }
  return patch;
}

function workflowRunHasActiveImages(run = {}) {
  const result = normalizeObject(run.result);
  const shots = Array.isArray(result.shots) ? result.shots : Array.isArray(run.shots) ? run.shots : [];
  const imageJobStatus = String(result.backendJobs?.image?.status || "").trim();
  return run.stages?.image === "running" || ["queued", "running"].includes(imageJobStatus) || shots.some((shot) => (
    !shot.imageUrl && ["queued", "running"].includes(String(shot.imageStatus || "").trim())
  ));
}

function workflowRunHasActiveAudio(run = {}) {
  const result = normalizeObject(run.result);
  return run.stages?.audio === "running" || String(result.audioStatus || "").trim() === "running";
}

function withRuns(workflow, store) {
  return {
    ...workflow,
    runs: store.workflowRuns
      .filter((run) => run.workflowId === workflow.id && run.userId === workflow.userId && !run.parentRunId && run.status !== "deleted")
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((run) => withChildren(run, store)),
  };
}

function withChildren(run, store) {
  normalizeImageRunPatch(run);
  return {
    ...run,
    children: store.workflowRuns
      .filter((item) => item.parentRunId === run.id && item.userId === run.userId && item.status !== "deleted")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((child) => normalizeImageRunPatch({ ...child })),
  };
}

function workflowRunListSummary(run = {}) {
  const result = normalizeObject(run.result);
  const shots = (Array.isArray(result.shots) ? result.shots : []).map((shot = {}) => ({
    id: shot.id || "",
    shotId: shot.shotId || "",
    title: shot.title || "",
    imageUrl: shot.imageUrl || "",
    fileUrl: shot.fileUrl || "",
    url: shot.url || "",
    imageStatus: shot.imageStatus || "",
    imageError: shot.imageError || "",
    videoPrompt: shot.videoPrompt || "",
  }));
  const videoTimeline = (Array.isArray(result.videoTimeline) ? result.videoTimeline : []).map((item = {}) => ({
    id: item.id || "",
    timelineItemId: item.timelineItemId || "",
    title: item.title || "",
    shotIds: Array.isArray(item.shotIds) ? item.shotIds : [],
    startIndex: item.startIndex || 0,
    endIndex: item.endIndex || 0,
    videoPrompt: item.videoPrompt || "",
  }));
  const videoResults = (Array.isArray(result.videoResults) ? result.videoResults : []).map((video = {}) => ({
    id: video.id || "",
    taskId: video.taskId || video.task_id || "",
    timelineItemId: video.timelineItemId || "",
    title: video.title || "",
    status: video.status || video.state || "",
    state: video.state || video.status || "",
  }));
  const script = String(result.scriptOutput || result.script || result.content || "");
  const shotOutput = String(result.shotOutput || "");
  const audioSegmentCount = Number(result.audioSegmentCount || (Array.isArray(result.audioSegments) ? result.audioSegments.length : result.audio?.segments?.length) || 0);
  const audioTrackCount = Number(result.audioTrackCount || (Array.isArray(result.audioTracks) ? result.audioTracks.length : 0));
  return {
    ...run,
    result: {
      scriptOutput: script.slice(0, 260),
      scriptCharCount: Number(result.scriptCharCount || script.length),
      shotOutput: shotOutput.slice(0, 180),
      shotCount: Number(result.shotCount || shots.length),
      shots,
      audioUrl: result.audioUrl || result.audio?.audio_url || result.audio?.audioUrl || result.audio?.url || "",
      audioSegmentCount,
      audioSegments: audioSegmentCount ? [{}] : [],
      audioTrackCount,
      audioTracks: audioTrackCount ? [{}] : [],
      videoTimeline,
      videoResults,
      videoStatus: result.videoStatus || "",
      videoPackageStatus: result.videoPackageStatus || result.videoPackage?.status || "",
      draftUrl: result.draftUrl || result.draft?.draft_url || result.draft?.url || "",
      draftStatus: result.draftStatus || result.draft?.status || "",
      backendJobs: summarizeWorkflowBackendJobs(result.backendJobs),
    },
  };
}

function summarizeWorkflowBackendJobs(value) {
  const jobs = normalizeObject(value);
  return Object.fromEntries(Object.entries(jobs).map(([key, job]) => [key, {
    status: normalizeObject(job).status || "",
  }]));
}

export function workflowSnapshotForRun(workflow = {}) {
  const config = normalizeObject(workflow.config);
  const snapshot = {
    ...config,
    id: normalizeId(workflow.id || config.id),
    name: normalizeId(workflow.name || config.name),
    type: normalizeId(workflow.type || config.type || "explain"),
    createdAt: workflow.createdAt || config.createdAt || "",
    updatedAt: workflow.updatedAt || config.updatedAt || "",
  };
  delete snapshot.runs;
  delete snapshot.children;
  delete snapshot.userId;
  delete snapshot.storedOnServer;
  return snapshot;
}

export function workflowSnapshotFromRun(run = {}) {
  const result = normalizeObject(run.result);
  return normalizeObject(result.workflowSnapshot || result.workflowConfig || run.workflowSnapshot || run.workflowConfig);
}

export function workflowConfigForRunSnapshot(workflow = {}, run = {}, overrides = {}) {
  const snapshot = workflowSnapshotFromRun(run);
  const base = Object.keys(snapshot).length ? snapshot : workflowSnapshotForRun(workflow);
  const cleanOverrides = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined && value !== null && String(value).trim())
  );
  const config = {
    ...base,
    ...cleanOverrides,
  };
  return {
    ...workflow,
    ...config,
    config,
  };
}

function runResultWithWorkflowSnapshot(result = {}, workflow = {}, parentRun = {}) {
  const nextResult = normalizeObject(result);
  const inputSnapshot = normalizeObject(nextResult.workflowSnapshot);
  const parentSnapshot = workflowSnapshotFromRun(parentRun);
  return {
    ...nextResult,
    workflowSnapshot: Object.keys(inputSnapshot).length
      ? inputSnapshot
      : Object.keys(parentSnapshot).length
        ? parentSnapshot
        : workflowSnapshotForRun(workflow),
  };
}

function findWorkflow(store, userId, workflowId) {
  const workflow = store.workflows.find((item) => item.id === workflowId && item.userId === userId);
  if (!workflow) throw httpError(404, "工作流不存在。");
  return workflow;
}

function findRun(store, userId, runId) {
  const run = store.workflowRuns.find((item) => item.id === runId && item.userId === userId);
  if (!run) throw httpError(404, "任务不存在。");
  return run;
}

function requiredText(value, message) {
  const text = String(value || "").trim();
  if (!text) throw httpError(400, message);
  return text;
}

function assertEcommerceProductImagesReady(workflow = {}) {
  const wf = workflow.config && typeof workflow.config === "object" ? workflow.config : workflow;
  const type = normalizeId(workflow.type || workflow.workflowType || wf.type || wf.workflowType);
  if (type !== "ecommerce") return;

  const ecommerceAssets = wf.ecommerceAssets && typeof wf.ecommerceAssets === "object" ? wf.ecommerceAssets : {};
  const products = normalizeList(ecommerceAssets.products)
    .filter((product) => product && typeof product === "object");
  const selectedProducts = products.filter((product) => normalizeId(product.id || product.assetId));
  if (normalizeId(wf.topicMode) === "script") {
    if (!normalizeId(wf.inputScript)) {
      throw httpError(400, "请粘贴完整故事剧本。", {
        code: "ECOMMERCE_INPUT_SCRIPT_REQUIRED",
      });
    }
    if (!selectedProducts.length) {
      throw httpError(400, "请选择商品库中的带货产品。", {
        code: "ECOMMERCE_PRODUCT_REQUIRED",
      });
    }
    const durationMode = normalizeId(wf.inputScriptDurationMode) === "custom" ? "custom" : "smart";
    const targetDurationSeconds = Math.round(Number(wf.inputScriptTargetDurationSeconds || 0));
    if (durationMode === "custom" && (!Number.isFinite(targetDurationSeconds) || targetDurationSeconds < 4)) {
      throw httpError(400, "指定时长模式需要填写不少于 4 秒的目标时长。", {
        code: "ECOMMERCE_INPUT_SCRIPT_TARGET_DURATION_REQUIRED",
      });
    }
  }
  const missingProducts = products.filter((product) => !ecommerceProductImageUrl(product));
  if (!missingProducts.length) return;

  throw httpError(400, "商品库缺少商品图，请先上传商品图后再新增工作流。", {
    code: "ECOMMERCE_PRODUCT_IMAGE_MISSING",
    products: missingProducts.slice(0, 10).map((product) => ({
      id: normalizeId(product.id || product.assetId),
      name: normalizeId(product.name || product.title || product.productName || product.productProfile?.productName),
    })),
  });
}

function ecommerceProductImageUrl(product = {}) {
  const profile = product.productProfile && typeof product.productProfile === "object" ? product.productProfile : {};
  return normalizeId(
    product.productImageUrl ||
    profile.productImageUrl ||
    product.imageUrl ||
    product.fileUrl ||
    product.url ||
    product.productImageThumbnailUrl ||
    profile.productImageThumbnailUrl ||
    product.imageThumbnailUrl ||
    product.thumbnailUrl ||
    product.thumbUrl
  );
}

function normalizeId(value) {
  return String(value || "").trim();
}

function normalizeIds(value) {
  return [...new Set(normalizeList(value).map(normalizeId).filter(Boolean))];
}

function assertTopicConfirmationRun(run = {}) {
  if (!["main", "topic-seed"].includes(run.kind)) {
    throw httpError(400, "只有主任务可以操作选题。");
  }
}

function workflowTopicChildCanStartScript(run = {}) {
  const scriptStatus = normalizeId(run.stages?.script);
  return !scriptStatus || ["pending", "waiting"].includes(scriptStatus);
}

function topicRunSummary(run = {}) {
  return {
    id: run.id || "",
    workflowId: run.workflowId || "",
    userId: run.userId || "",
    parentRunId: run.parentRunId || "",
    kind: run.kind || "",
    serial: run.serial || "",
    topic: run.topic || "",
    status: run.status || "",
    stages: normalizeObject(run.stages),
    generatedTopics: normalizeList(run.generatedTopics),
    confirmedTopics: normalizeList(run.confirmedTopics),
    confirmedTopicIndexes: normalizeList(run.confirmedTopicIndexes),
    selectedTopics: normalizeList(run.selectedTopics),
    topicGenerationStatus: run.topicGenerationStatus || "",
    topicGenerationError: run.topicGenerationError || "",
    result: {},
    error: run.error || "",
    createdAt: run.createdAt || "",
    startedAt: run.startedAt || "",
    completedAt: run.completedAt || "",
    updatedAt: run.updatedAt || "",
  };
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.flatMap(normalizeList);
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function workflowShotId(shot = {}) {
  return normalizeId(shot.id || shot.shotId || shot.uuid);
}

function workflowImageShotPatchMatches(shot = {}, input = {}) {
  if (input?.expectedJobId !== undefined && normalizeId(shot.imageJobId) !== normalizeId(input.expectedJobId)) return false;
  if (input?.expectedRequestId !== undefined && normalizeId(shot.imageRequestId) !== normalizeId(input.expectedRequestId)) return false;
  const expectedStatuses = Array.isArray(input?.expectedStatuses)
    ? input.expectedStatuses.map(normalizeId).filter(Boolean)
    : [];
  if (expectedStatuses.length && !expectedStatuses.includes(normalizeId(shot.imageStatus))) return false;
  if (input?.requireMissingImage && normalizeId(shot.imageUrl)) return false;
  return true;
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeTopics(value) {
  if (!Array.isArray(value)) return [];
  return uniqueTopics(value.map((item) => String(item || "").trim()).filter(Boolean));
}

function normalizeTopicAdaptations(value) {
  if (Array.isArray(value)) {
    return value.reduce((adaptations, item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return adaptations;
      const title = String(item.title || item.topic || item.name || "").trim();
      const adaptation = String(item.adaptation || item.adaptationIdea || item.rewriteIdea || item.direction || item.prompt || item.note || "").trim();
      if (title && adaptation) adaptations[title] = adaptation;
      return adaptations;
    }, {});
  }
  if (!value || typeof value !== "object") return {};
  return Object.entries(value).reduce((adaptations, [topic, adaptation]) => {
    const title = String(topic || "").trim();
    const text = String(adaptation || "").trim();
    if (title && text) adaptations[title] = text;
    return adaptations;
  }, {});
}

function topicAdaptationFor(topic, adaptations = {}) {
  const title = String(topic || "").trim();
  if (!title) return "";
  if (adaptations[title]) return adaptations[title];
  const key = normalizeTopicTitle(title);
  const matched = Object.entries(adaptations).find(([candidate]) => normalizeTopicTitle(candidate) === key);
  return matched ? matched[1] : "";
}

function uniqueTopics(topics) {
  const seen = new Set();
  return topics.filter((topic) => {
    const key = normalizeTopicTitle(topic);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeTopicTitle(topic) {
  return String(topic || "").trim().toLowerCase();
}

function randomRunSerial() {
  return Math.floor(7000 + Math.random() * 900).toString();
}
