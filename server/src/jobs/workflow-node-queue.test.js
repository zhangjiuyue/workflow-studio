import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJob, getJob } from "../services/job-store.js";
import { ensureUser } from "../services/user-store.js";
import { createWorkflow, createWorkflowRun, getWorkflowRun, updateWorkflowRun } from "../services/workflow-store.js";
import { readStore, writeStore } from "../storage/store.js";
import { touchWorkflowWorkerHeartbeat } from "../services/worker-heartbeat-store.js";
import { enqueueWorkflowNodeJob, expireStaleWorkflowNodeJobs, failWorkflowNodeJob, reconcileStaleWorkflowAudioRuns, reconcileWorkflowImageRun, startWorkflowImageJobHeartbeat, workflowNextAutomaticNode } from "./workflow-node-queue.js";
import { recoverInterruptedWorkflowNodeJobs } from "./workflow-node-worker.js";

test("talking-video automatic execution queues audio before storyboard", () => {
  const workflow = { type: "explain", executionStep: "all" };
  const run = { result: { scriptOutput: "口播文案" } };

  assert.equal(workflowNextAutomaticNode(workflow, run, "script"), "audio");
  assert.equal(workflowNextAutomaticNode(workflow, run, "audio"), "shot");
  assert.equal(workflowNextAutomaticNode(workflow, { result: { ...run.result, audioUrl: "/audio/voice.mp3" } }, "script"), "shot");
});

test("non-talking automatic execution retains the existing script-to-storyboard transition", () => {
  for (const type of ["ecommerce", "story", "free"]) {
    assert.equal(workflowNextAutomaticNode({ type, executionStep: "all" }, { result: {} }, "script"), "shot");
    assert.equal(workflowNextAutomaticNode({ type, executionStep: "all" }, { result: {} }, "audio"), "");
  }
});

test("script-only execution does not enqueue later talking-video nodes", () => {
  assert.equal(workflowNextAutomaticNode({ type: "explain", executionStep: "story" }, { result: {} }, "script"), "");
});

test("audio watchdog marks browser-owned runs as failed after 30 minutes without progress", async () => {
  const { config, user, run, cleanup } = await createWorkflowNodeQueueFixture({
    imageStage: "pending",
    audioStage: "running",
    audioStatus: "running",
  });
  try {
    const startedAt = Date.parse(run.updatedAt);
    const recent = await reconcileStaleWorkflowAudioRuns(config, {
      nowMs: startedAt + 30 * 60 * 1000 - 1,
    });
    assert.equal(recent.length, 0);

    const timedOut = await reconcileStaleWorkflowAudioRuns(config, {
      nowMs: startedAt + 30 * 60 * 1000,
    });
    assert.equal(timedOut.length, 1);
    const updatedRun = await getWorkflowRun(user.id, run.id, config);
    assert.equal(updatedRun.status, "error");
    assert.equal(updatedRun.stages.audio, "error");
    assert.equal(updatedRun.result.audioStatus, "error");
    assert.equal(updatedRun.result.audioProgress.status, "error");
    assert.match(updatedRun.result.audioError, /连续 30 分钟没有进度/);
    assert.match(updatedRun.error, /请重试/);
  } finally {
    await cleanup();
  }
});

test("worker startup recovery closes audio runs that were already stale before deployment", async () => {
  const { config, user, run, cleanup } = await createWorkflowNodeQueueFixture({
    imageStage: "pending",
    audioStage: "running",
    audioStatus: "running",
  });
  try {
    const store = readStore(config);
    const storedRun = store.workflowRuns.find((item) => item.id === run.id);
    storedRun.updatedAt = "2000-01-01T00:00:00.000Z";
    writeStore(config, store);

    const recovered = await recoverInterruptedWorkflowNodeJobs(config);
    assert.equal(recovered.audioReconciled.length, 1);
    const updatedRun = await getWorkflowRun(user.id, run.id, config);
    assert.equal(updatedRun.status, "error");
    assert.equal(updatedRun.stages.audio, "error");
    assert.equal(updatedRun.result.audioStatus, "error");
  } finally {
    await cleanup();
  }
});

test("shot failure blocks auto-queued image stage", async () => {
  const { config, user, workflow, run, cleanup } = await createWorkflowNodeQueueFixture({
    imageStage: "running",
  });
  try {
    const shotJob = await createJob(user, {
      id: "shot-job",
      kind: "workflow-node",
      scope: "llm",
      workflowId: workflow.id,
      runId: run.id,
      nodeId: "shot",
      title: "分镜和图片生成",
      status: "running",
      startedAt: "2000-01-01T00:00:00.000Z",
      payload: {
        autoImages: true,
      },
    }, config);

    const expired = await expireStaleWorkflowNodeJobs(config);
    assert.equal(expired.length, 1);
    assert.equal(expired[0].id, shotJob.id);

    const updatedRun = await getWorkflowRun(user.id, run.id, config);
    assert.equal(updatedRun.stages.shot, "error");
    assert.equal(updatedRun.stages.image, "error");
    assert.match(updatedRun.result.shotError, /分镜生成超时/);
    assert.match(updatedRun.result.imageError, /分镜节点失败，图片节点未执行/);
    assert.equal(updatedRun.result.backendJobs.shot.status, "error");
    assert.equal(updatedRun.result.backendJobs.image.status, "error");
    assert.equal(updatedRun.result.backendJobs.image.payload.sourceJobId, shotJob.id);

    const storedShotJob = await getJob(user.id, shotJob.id, config);
    assert.equal(storedShotJob.status, "error");
  } finally {
    await cleanup();
  }
});

test("shot failure without auto images leaves image stage pending", async () => {
  const { config, user, workflow, run, cleanup } = await createWorkflowNodeQueueFixture({
    imageStage: "pending",
  });
  try {
    await createJob(user, {
      id: "shot-only-job",
      kind: "workflow-node",
      scope: "llm",
      workflowId: workflow.id,
      runId: run.id,
      nodeId: "shot",
      title: "分镜生成",
      status: "running",
      startedAt: "2000-01-01T00:00:00.000Z",
      payload: {
        autoImages: false,
      },
    }, config);

    const expired = await expireStaleWorkflowNodeJobs(config);
    assert.equal(expired.length, 1);

    const updatedRun = await getWorkflowRun(user.id, run.id, config);
    assert.equal(updatedRun.stages.shot, "error");
    assert.equal(updatedRun.stages.image, "pending");
    assert.equal(updatedRun.result.imageError || "", "");
    assert.equal(updatedRun.result.backendJobs.image, undefined);
  } finally {
    await cleanup();
  }
});

test("AI director storyboard jobs use their extended timeout during stale recovery", async () => {
  const { config, user, workflow, run, cleanup } = await createWorkflowNodeQueueFixture({
    imageStage: "pending",
  });
  config.worker.llmNodeTimeoutMs = 1;
  config.worker.aiDirectorLlmNodeTimeoutMs = 60 * 1000;
  try {
    const aiDirectorJob = await createJob(user, {
      id: "ai-director-shot-job",
      kind: "workflow-node",
      scope: "llm",
      workflowId: workflow.id,
      runId: run.id,
      nodeId: "shot",
      title: "AI 导演分镜生成",
      status: "running",
      startedAt: new Date(Date.now() - 1000).toISOString(),
      payload: {
        storyboardMode: "ai-director",
      },
    }, config);

    const expired = await expireStaleWorkflowNodeJobs(config);
    assert.deepEqual(expired, []);

    const storedJob = await getJob(user.id, aiDirectorJob.id, config);
    assert.equal(storedJob.status, "running");
    const updatedRun = await getWorkflowRun(user.id, run.id, config);
    assert.equal(updatedRun.stages.shot, "running");
  } finally {
    await cleanup();
  }
});

test("image job does not complete early when ecommerce product image is missing", async () => {
  const { config, user, workflow, run, cleanup } = await createWorkflowNodeQueueFixture({
    imageStage: "pending",
    shots: [
      {
        id: "product-shot",
        index: 1,
        assetType: "product",
        title: "保温杯",
        imageStatus: "error",
        imageError: "产品库未上传商品图",
        imageUrl: "",
      },
    ],
  });
  try {
    const imageJob = await enqueueWorkflowNodeJob(user, {
      workflowId: workflow.id,
      runId: run.id,
      nodeId: "image",
      title: "分镜图片生成",
      payload: {
        shotIds: ["product-shot"],
      },
    }, config);

    assert.equal(imageJob.status, "queued");
    assert.deepEqual(imageJob.result, {});

    const updatedRun = await getWorkflowRun(user.id, run.id, config);
    assert.equal(updatedRun.stages.image, "pending");
    assert.equal(updatedRun.result.backendJobs.image, undefined);
  } finally {
    await cleanup();
  }
});

test("concurrent image submissions reuse the active job for the same workflow run", async () => {
  const { config, user, workflow, run, cleanup } = await createWorkflowNodeQueueFixture({
    imageStage: "pending",
    shots: [
      { id: "scene-shot", imageStatus: "pending", imageUrl: "" },
      { id: "other-shot", imageStatus: "pending", imageUrl: "" },
    ],
  });
  try {
    const first = await enqueueWorkflowNodeJob(user, {
      workflowId: workflow.id,
      runId: run.id,
      nodeId: "image",
      title: "分镜图片生成",
      payload: { shotIds: ["scene-shot"], source: "auto" },
    }, config);
    const second = await enqueueWorkflowNodeJob(user, {
      workflowId: workflow.id,
      runId: run.id,
      nodeId: "image",
      title: "生成缺失图片",
      payload: { shotIds: ["scene-shot"], source: "manual" },
    }, config);

    assert.equal(second.id, first.id);
    assert.equal(second.payload.source, "auto");
    await assert.rejects(() => enqueueWorkflowNodeJob(user, {
      workflowId: workflow.id,
      runId: run.id,
      nodeId: "image",
      payload: { shotIds: ["other-shot"], source: "other-tab" },
    }, config), (error) => error.status === 409);
  } finally {
    await cleanup();
  }
});

test("stale image job marks running shot images as failed", async () => {
  const { config, user, workflow, run, cleanup } = await createWorkflowNodeQueueFixture({
    imageStage: "running",
    shots: [
      {
        id: "scene-shot",
        index: 1,
        assetType: "scene",
        title: "寒冬烤摊",
        imageStatus: "running",
        imageSubmittedAt: "2000-01-01T00:00:00.000Z",
        imageUrl: "",
        imageError: "",
      },
    ],
  });
  config.worker.imageHeartbeatTimeoutMs = 1;
  try {
    const imageJob = await createJob(user, {
      id: "image-job",
      kind: "workflow-node",
      scope: "image",
      workflowId: workflow.id,
      runId: run.id,
      nodeId: "image",
      title: "分镜图片生成",
      status: "running",
      startedAt: "2000-01-01T00:00:00.000Z",
      payload: {},
    }, config);

    const expired = await expireStaleWorkflowNodeJobs(config);
    assert.equal(expired.length, 1);
    assert.equal(expired[0].id, imageJob.id);

    const updatedRun = await getWorkflowRun(user.id, run.id, config);
    assert.equal(updatedRun.stages.image, "error");
    assert.match(updatedRun.result.imageError, /分镜图片生成超时/);
    assert.equal(updatedRun.result.backendJobs.image.status, "error");
    assert.equal(updatedRun.result.shots[0].imageStatus, "error");
    assert.match(updatedRun.result.shots[0].imageError, /分镜图片生成超时/);
  } finally {
    await cleanup();
  }
});

test("worker recovery expires stale image jobs before requeueing recent interrupted jobs", async () => {
  const { config, user, workflow, run, cleanup } = await createWorkflowNodeQueueFixture({
    imageStage: "running",
    shots: [
      {
        id: "stale-scene-shot",
        index: 1,
        assetType: "scene",
        title: "旧分镜",
        imageStatus: "running",
        imageSubmittedAt: "2000-01-01T00:00:00.000Z",
        imageUrl: "",
        imageError: "",
      },
    ],
  });
  config.worker.llmNodeTimeoutMs = 60 * 1000;
  config.worker.imageHeartbeatTimeoutMs = 60 * 1000;
  try {
    const staleImageJob = await createJob(user, {
      id: "stale-image-job",
      kind: "workflow-node",
      scope: "image",
      workflowId: workflow.id,
      runId: run.id,
      nodeId: "image",
      title: "分镜图片生成",
      status: "running",
      startedAt: "2000-01-01T00:00:00.000Z",
      payload: {},
    }, config);
    const recentScriptJob = await createJob(user, {
      id: "recent-script-job",
      kind: "workflow-node",
      scope: "llm",
      workflowId: workflow.id,
      runId: run.id,
      nodeId: "script",
      title: "文案创作",
      status: "running",
      startedAt: new Date().toISOString(),
      payload: {},
    }, config);

    const recovery = await recoverInterruptedWorkflowNodeJobs(config);

    assert.deepEqual(recovery.expired.map((job) => job.id), [staleImageJob.id]);
    assert.deepEqual(recovery.requeued.map((job) => job.id), [recentScriptJob.id]);

    const storedStaleJob = await getJob(user.id, staleImageJob.id, config);
    assert.equal(storedStaleJob.status, "error");
    const storedRecentJob = await getJob(user.id, recentScriptJob.id, config);
    assert.equal(storedRecentJob.status, "queued");
    assert.equal(storedRecentJob.startedAt, "");

    const updatedRun = await getWorkflowRun(user.id, run.id, config);
    assert.equal(updatedRun.stages.image, "error");
    assert.equal(updatedRun.result.shots[0].imageStatus, "error");
    assert.match(updatedRun.result.shots[0].imageError, /分镜图片生成超时/);
  } finally {
    await cleanup();
  }
});

test("orphaned unsubmitted image state is paused and releases the workflow", async () => {
  const { config, user, run, cleanup } = await createWorkflowNodeQueueFixture({
    imageStage: "running",
    shots: [
      {
        id: "orphan-scene-shot",
        index: 1,
        assetType: "scene",
        imageStatus: "running",
        imageUrl: "",
        imageError: "",
      },
    ],
  });
  try {
    const updated = await reconcileWorkflowImageRun(user.id, run.id, config, {
      nowMs: new Date(run.updatedAt).getTime() + 10 * 60 * 1000,
    });

    assert.equal(updated.status, "waiting");
    assert.equal(updated.stages.image, "error");
    assert.equal(updated.result.shots[0].imageStatus, "paused");
    assert.equal(updated.result.shots[0].imageError, "");
    assert.match(updated.result.shots[0].imagePauseReason, /尚未发起请求/);
    assert.match(updated.result.shots[0].imagePauseReason, /任务记录不存在/);
  } finally {
    await cleanup();
  }
});

test("an intentionally pending image is not failed by a previous completed image job", async () => {
  const { config, user, workflow, run, cleanup } = await createWorkflowNodeQueueFixture({
    imageStage: "pending",
    shots: [
      {
        id: "manually-deleted-role-image",
        index: 1,
        assetType: "role",
        imageStatus: "pending",
        imageUrl: "",
        imageError: "",
      },
    ],
  });
  try {
    const previousImageJob = await createJob(user, {
      id: "previous-completed-image-job",
      kind: "workflow-node",
      scope: "image",
      workflowId: workflow.id,
      runId: run.id,
      nodeId: "image",
      title: "分镜图片生成",
      status: "done",
      payload: {},
    }, config);
    await updateWorkflowRun(user.id, run.id, {
      result: {
        ...run.result,
        backendJobs: { image: previousImageJob },
      },
    }, config);

    const updated = await reconcileWorkflowImageRun(user.id, run.id, config, {
      nowMs: new Date(run.updatedAt).getTime() + 60 * 60 * 1000,
    });

    assert.equal(updated.stages.image, "pending");
    assert.equal(updated.result.shots[0].imageStatus, "pending");
    assert.equal(updated.result.shots[0].imageError, "");
  } finally {
    await cleanup();
  }
});

test("terminal image job reconciles a leftover running shot immediately", async () => {
  const { config, user, workflow, run, cleanup } = await createWorkflowNodeQueueFixture({
    imageStage: "running",
    shots: [
      {
        id: "leftover-scene-shot",
        index: 1,
        assetType: "scene",
        imageStatus: "running",
        imageSubmittedAt: "2026-01-01T00:00:00.000Z",
        imageUrl: "",
      },
    ],
  });
  try {
    const imageJob = await createJob(user, {
      id: "terminal-image-job",
      kind: "workflow-node",
      scope: "image",
      workflowId: workflow.id,
      runId: run.id,
      nodeId: "image",
      title: "分镜图片生成",
      status: "error",
      error: "模型服务连接失败",
      payload: {},
    }, config);
    await updateWorkflowRun(user.id, run.id, {
      result: {
        ...run.result,
        backendJobs: { image: imageJob },
      },
    }, config);
    const updated = await reconcileWorkflowImageRun(user.id, run.id, config);
    assert.equal(updated.status, "waiting");
    assert.equal(updated.result.shots[0].imageStatus, "error");
    assert.match(updated.result.shots[0].imageError, /模型服务连接失败/);
  } finally {
    await cleanup();
  }
});

test("terminal image job clears a stale running stage after a failed shot was already closed", async () => {
  const { config, user, workflow, run, cleanup } = await createWorkflowNodeQueueFixture({
    imageStage: "running",
    shots: [{
      id: "closed-failed-shot",
      index: 1,
      assetType: "scene",
      imageStatus: "error",
      imageError: "图片生成失败",
      imageUrl: "",
    }],
  });
  try {
    const imageJob = await createJob(user, {
      id: "completed-image-job-with-stale-stage",
      kind: "workflow-node",
      scope: "image",
      workflowId: workflow.id,
      runId: run.id,
      nodeId: "image",
      title: "分镜图片生成",
      status: "done",
      payload: {},
    }, config);
    await updateWorkflowRun(user.id, run.id, {
      result: {
        ...run.result,
        backendJobs: { image: { ...imageJob, status: "running" } },
      },
    }, config);

    const updated = await reconcileWorkflowImageRun(user.id, run.id, config);
    assert.equal(updated.stages.image, "error");
    assert.equal(updated.result.backendJobs.image.status, "done");
    assert.equal(updated.result.shots[0].imageStatus, "error");
  } finally {
    await cleanup();
  }
});

test("a queued image job is released when the workflow worker is offline", async () => {
  const { config, user, workflow, run, cleanup } = await createWorkflowNodeQueueFixture({
    imageStage: "running",
    shots: [{
      id: "offline-worker-shot",
      imageStatus: "pending",
      imageUrl: "",
    }],
  });
  try {
    const imageJob = await createJob(user, {
      id: "offline-worker-image-job",
      kind: "workflow-node",
      scope: "image",
      workflowId: workflow.id,
      runId: run.id,
      nodeId: "image",
      status: "queued",
      queuedAt: "2000-01-01T00:00:00.000Z",
      payload: { shotIds: ["offline-worker-shot"] },
    }, config);
    await updateWorkflowRun(user.id, run.id, {
      result: {
        ...run.result,
        backendJobs: { image: imageJob },
      },
    }, config);
    const updated = await reconcileWorkflowImageRun(user.id, run.id, config);
    const stored = await getJob(user.id, imageJob.id, config);
    assert.equal(stored.status, "error");
    assert.equal(updated.status, "waiting");
    assert.equal(updated.result.shots[0].imageStatus, "paused");
    assert.equal(updated.result.shots[0].imageError, "");
    assert.match(updated.result.shots[0].imagePauseReason, /Worker 已离线/);
  } finally {
    await cleanup();
  }
});

test("a queued image job is kept pending while the worker is busy", async () => {
  const { config, user, workflow, run, cleanup } = await createWorkflowNodeQueueFixture({
    imageStage: "running",
    shots: [
      {
        id: "queued-too-long-shot",
        index: 1,
        assetType: "scene",
        imageStatus: "pending",
        imageUrl: "",
      },
    ],
  });
  config.worker.imageQueuedTimeoutMs = 5 * 60 * 1000;
  try {
    const imageJob = await createJob(user, {
      id: "queued-too-long-image-job",
      kind: "workflow-node",
      scope: "image",
      workflowId: workflow.id,
      runId: run.id,
      nodeId: "image",
      title: "分镜图片生成",
      status: "queued",
      queuedAt: "2000-01-01T00:00:00.000Z",
      payload: {},
    }, config);
    await updateWorkflowRun(user.id, run.id, {
      result: {
        ...run.result,
        backendJobs: { image: imageJob },
      },
    }, config);
    await touchWorkflowWorkerHeartbeat(config, { activeCount: 8 });

    const updated = await reconcileWorkflowImageRun(user.id, run.id, config);
    const stored = await getJob(user.id, imageJob.id, config);
    assert.equal(stored.status, "queued");
    assert.equal(updated.status, "running");
    assert.equal(updated.result.shots[0].imageStatus, "pending");
    assert.equal(updated.result.shots[0].imageError || "", "");
  } finally {
    await cleanup();
  }
});

test("an obsolete image job cannot mark shots owned by the current job as failed", async () => {
  const { config, user, workflow, run, cleanup } = await createWorkflowNodeQueueFixture({
    imageStage: "running",
    shots: [{
      id: "owned-shot",
      imageStatus: "running",
      imageUrl: "",
      imageJobId: "current-image-job",
      imageRequestId: "current-request",
    }],
  });
  try {
    const obsolete = await createJob(user, {
      id: "obsolete-image-job",
      kind: "workflow-node",
      scope: "image",
      workflowId: workflow.id,
      runId: run.id,
      nodeId: "image",
      status: "running",
      payload: { shotIds: ["owned-shot"] },
    }, config);
    const current = await createJob(user, {
      id: "current-image-job",
      kind: "workflow-node",
      scope: "image",
      workflowId: workflow.id,
      runId: run.id,
      nodeId: "image",
      status: "running",
      payload: { shotIds: ["owned-shot"] },
    }, config);
    await updateWorkflowRun(user.id, run.id, {
      result: {
        ...run.result,
        backendJobs: { image: current },
      },
    }, config);

    await failWorkflowNodeJob(obsolete, config, "旧任务已超时。", { expectedStatuses: ["running"] });

    const updated = await getWorkflowRun(user.id, run.id, config);
    assert.equal(updated.stages.image, "running");
    assert.equal(updated.result.backendJobs.image.id, current.id);
    assert.equal(updated.result.shots[0].imageStatus, "running");
    assert.equal(updated.result.shots[0].imageRequestId, "current-request");
  } finally {
    await cleanup();
  }
});

test("image heartbeat keeps a running job fresh", async () => {
  const { config, user, workflow, run, cleanup } = await createWorkflowNodeQueueFixture({
    imageStage: "running",
  });
  try {
    const imageJob = await createJob(user, {
      id: "heartbeat-image-job",
      kind: "workflow-node",
      scope: "image",
      workflowId: workflow.id,
      runId: run.id,
      nodeId: "image",
      title: "分镜图片生成",
      status: "running",
      payload: {},
    }, config);
    const heartbeat = startWorkflowImageJobHeartbeat(imageJob, config);
    await heartbeat.touch();
    heartbeat.stop();

    const stored = await getJob(user.id, imageJob.id, config);
    assert.ok(stored.result.heartbeatAt);
    assert.ok(new Date(stored.result.heartbeatAt).getTime() >= new Date(imageJob.startedAt).getTime());
  } finally {
    await cleanup();
  }
});

test("reconciliation does not copy one provider request error to every unfinished shot", async () => {
  const shots = ["unfinished-1", "unfinished-2"].map((id) => ({
    id,
    index: 1,
    assetType: "scene",
    imageStatus: "running",
    imageUrl: "",
    imageJobId: "partial-image-job",
    imageRequestId: `${id}-request`,
    imageSubmittedAt: "2026-01-01T00:00:00.000Z",
  }));
  const { config, user, workflow, run, cleanup } = await createWorkflowNodeQueueFixture({
    imageStage: "running",
    shots,
  });
  try {
    const imageJob = await createJob(user, {
      id: "partial-image-job",
      kind: "workflow-node",
      scope: "image",
      workflowId: workflow.id,
      runId: run.id,
      nodeId: "image",
      title: "分镜图片生成",
      status: "error",
      error: "unexpected end of JSON input (request id: upstream-one)",
      payload: {},
    }, config);
    await updateWorkflowRun(user.id, run.id, {
      result: {
        ...run.result,
        shots,
        backendJobs: { image: imageJob },
      },
    }, config);

    const updated = await reconcileWorkflowImageRun(user.id, run.id, config);
    assert.ok(updated.result.shots.every((shot) => shot.imageStatus === "error"));
    assert.ok(updated.result.shots.every((shot) => /没有正确收口/.test(shot.imageError)));
    assert.ok(updated.result.shots.every((shot) => !/upstream-one/.test(shot.imageError)));
  } finally {
    await cleanup();
  }
});

test("a live image job with no completed image progress is failed", async () => {
  const { config, user, workflow, run, cleanup } = await createWorkflowNodeQueueFixture({
    imageStage: "running",
    shots: [
      {
        id: "no-progress-shot",
        index: 1,
        assetType: "scene",
        imageStatus: "running",
        imageSubmittedAt: "2026-01-01T00:00:00.000Z",
        imageUrl: "",
      },
    ],
  });
  config.worker.imageHeartbeatTimeoutMs = 3 * 60 * 1000;
  config.worker.imageNoProgressTimeoutMs = 45 * 60 * 1000;
  try {
    const now = Date.now();
    const imageJob = await createJob(user, {
      id: "no-progress-image-job",
      kind: "workflow-node",
      scope: "image",
      workflowId: workflow.id,
      runId: run.id,
      nodeId: "image",
      title: "分镜图片生成",
      status: "running",
      startedAt: new Date(now - 60 * 60 * 1000).toISOString(),
      result: {
        heartbeatAt: new Date(now).toISOString(),
        lastProgressAt: new Date(now - 46 * 60 * 1000).toISOString(),
      },
      payload: {},
    }, config);
    await updateWorkflowRun(user.id, run.id, {
      result: {
        ...run.result,
        backendJobs: { image: imageJob },
      },
    }, config);

    const updated = await reconcileWorkflowImageRun(user.id, run.id, config, { nowMs: now });
    const stored = await getJob(user.id, imageJob.id, config);
    assert.equal(stored.status, "error");
    assert.equal(updated.status, "waiting");
    assert.equal(updated.result.shots[0].imageStatus, "error");
    assert.match(updated.result.shots[0].imageError, /长时间没有任何图片完成/);
  } finally {
    await cleanup();
  }
});

test("worker recovery does not automatically resubmit an in-flight image job", async () => {
  const { config, user, workflow, run, cleanup } = await createWorkflowNodeQueueFixture({
    imageStage: "running",
    shots: [
      {
        id: "twice-interrupted-shot",
        index: 1,
        assetType: "scene",
        imageStatus: "running",
        imageUrl: "",
      },
    ],
  });
  config.worker.imageHeartbeatTimeoutMs = 60 * 1000;
  try {
    const imageJob = await createJob(user, {
      id: "twice-interrupted-image-job",
      kind: "workflow-node",
      scope: "image",
      workflowId: workflow.id,
      runId: run.id,
      nodeId: "image",
      title: "分镜图片生成",
      status: "running",
      attempts: 1,
      startedAt: new Date().toISOString(),
      payload: {},
    }, config);
    await updateWorkflowRun(user.id, run.id, {
      result: {
        ...run.result,
        backendJobs: { image: imageJob },
      },
    }, config);

    const recovery = await recoverInterruptedWorkflowNodeJobs(config);
    assert.deepEqual(recovery.exhausted, []);
    const stored = await getJob(user.id, imageJob.id, config);
    assert.equal(stored.status, "running");
    const updated = await getWorkflowRun(user.id, run.id, config);
    assert.equal(updated.status, "running");
    assert.equal(updated.result.shots[0].imageStatus, "running");
  } finally {
    await cleanup();
  }
});

async function createWorkflowNodeQueueFixture({ imageStage, audioStage = "pending", audioStatus = "", shots = [] }) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "flowstudio-workflow-node-"));
  const config = {
    env: "test",
    dataDir,
    store: {
      driver: "json",
    },
    worker: {
      llmNodeTimeoutMs: 1,
      imageNodeTimeoutMs: 0,
      imageHeartbeatMs: 30 * 1000,
      imageHeartbeatTimeoutMs: 1,
      imageNoProgressTimeoutMs: 45 * 60 * 1000,
      imageQueuedTimeoutMs: 5 * 60 * 1000,
      imageWatchdogPollMs: 60 * 1000,
      audioNodeTimeoutMs: 0,
      audioRunStaleTimeoutMs: 30 * 60 * 1000,
      audioWatchdogPollMs: 60 * 1000,
      draftNodeTimeoutMs: 0,
    },
  };
  const user = ensureUser(config, {
    id: "dev-user",
    email: "dev@flowstudio.local",
    displayName: "Test User",
  });
  const workflow = await createWorkflow(user, {
    id: `workflow-${imageStage}`,
    name: "带货视频测试",
    type: "ecommerce",
    config: {
      type: "ecommerce",
      executionStep: "all",
    },
  }, config);
  const run = await createWorkflowRun(user.id, workflow.id, {
    id: `run-${imageStage}`,
    kind: "topic-child",
    topic: "测试选题",
    status: "running",
    stages: {
      topic: "skipped",
      outline: "skipped",
      script: "done",
      optimize: "skipped",
      audio: audioStage,
      shot: "running",
      image: imageStage,
      videoPrompt: "pending",
      video: "pending",
      draft: "pending",
    },
    result: {
      scriptOutput: "这是一段带货文案。",
      audioStatus,
      shots,
      backendJobs: {},
    },
  }, config);

  return {
    config,
    user,
    workflow,
    run,
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  };
}
