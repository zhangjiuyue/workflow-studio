import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJob, getJob, updateJobInternal } from "../services/job-store.js";
import { ensureUser } from "../services/user-store.js";
import { createWorkflow, createWorkflowRun, getWorkflowRun, updateWorkflowRun } from "../services/workflow-store.js";
import {
  enqueueWorkflowVideoSubmissionJob,
  listQueuedWorkflowVideoSubmissionJobs,
  processWorkflowVideoSubmissionJobById,
  recoverInterruptedWorkflowVideoSubmissionJobs,
} from "./workflow-video-submit-queue.js";

test("video tasks are persisted before a submission job becomes runnable", async () => {
  const fixture = await createVideoQueueFixture();
  try {
    const tasks = [videoTask("video-persisted-first-1", 1), videoTask("video-persisted-first-2", 2)];
    let createJobCalled = false;
    const queued = await enqueueWorkflowVideoSubmissionJob(fixture.user, {
      runId: fixture.run.id,
      tasks,
    }, fixture.config, {
      createSubmissionJob: async (user, input, config) => {
        createJobCalled = true;
        const run = await getWorkflowRun(fixture.user.id, fixture.run.id, fixture.config);
        assert.deepEqual(
          run.result.videoResults.map((video) => video.id),
          ["video-persisted-first-1", "video-persisted-first-2"],
        );
        assert.ok(run.result.videoResults.every((video) => video.submissionJobId === input.id));
        assert.deepEqual(await listQueuedWorkflowVideoSubmissionJobs(fixture.config), []);
        return createJob(user, input, config);
      },
    });

    assert.equal(createJobCalled, true);
    assert.equal((await listQueuedWorkflowVideoSubmissionJobs(fixture.config))[0]?.id, queued.job.id);
  } finally {
    await fixture.cleanup();
  }
});

test("persistent video queue submits every item without a browser request loop", async () => {
  const fixture = await createVideoQueueFixture();
  try {
    const queued = await enqueueWorkflowVideoSubmissionJob(fixture.user, {
      runId: fixture.run.id,
      tasks: [videoTask("video-1", 1), videoTask("video-2", 2)],
    }, fixture.config);
    const submittedIds = [];

    await processWorkflowVideoSubmissionJobById(queued.job.id, fixture.config, {
      createVideoGeneration: async (request) => {
        submittedIds.push(request.prompt);
        return { taskId: `upstream-${submittedIds.length}` };
      },
    });

    const job = await getJob(fixture.user.id, queued.job.id, fixture.config);
    const run = await getWorkflowRun(fixture.user.id, fixture.run.id, fixture.config);
    assert.equal(job.status, "done");
    assert.deepEqual(submittedIds, ["视频提示词 1", "视频提示词 2"]);
    assert.deepEqual(run.result.videoResults.map((video) => video.taskId), ["upstream-1", "upstream-2"]);
    assert.ok(run.result.videoResults.every((video) => video.submissionState === "submitted"));
  } finally {
    await fixture.cleanup();
  }
});

test("a stale browser update cannot erase a task id committed by the worker", async () => {
  const fixture = await createVideoQueueFixture();
  try {
    const queued = await enqueueWorkflowVideoSubmissionJob(fixture.user, {
      runId: fixture.run.id,
      tasks: [videoTask("video-atomic-task-id", 1)],
    }, fixture.config);
    const staleVideo = { ...queued.run.result.videoResults[0] };

    await processWorkflowVideoSubmissionJobById(queued.job.id, fixture.config, {
      createVideoGeneration: async () => ({ taskId: "lucky-ai-task-15" }),
    });
    await updateWorkflowRun(fixture.user.id, fixture.run.id, {
      resultPatch: {
        videoResults: [{
          ...staleVideo,
          status: "queued",
          submissionState: "queued",
          updatedAt: new Date(Date.now() + 1_000).toISOString(),
        }],
      },
    }, fixture.config);

    const updated = await getWorkflowRun(fixture.user.id, fixture.run.id, fixture.config);
    assert.equal(updated.result.videoResults.length, 1);
    assert.equal(updated.result.videoResults[0].taskId, "lucky-ai-task-15");
    assert.equal(updated.result.videoResults[0].submissionState, "submitted");
    assert.equal(updated.result.videoResults[0].status, "running");
  } finally {
    await fixture.cleanup();
  }
});

test("queue assigns a stable instance id before an upstream task id exists", async () => {
  const fixture = await createVideoQueueFixture();
  try {
    const task = videoTask("", 1);
    delete task.video.id;
    const queued = await enqueueWorkflowVideoSubmissionJob(fixture.user, {
      runId: fixture.run.id,
      tasks: [task],
    }, fixture.config);
    const instanceId = queued.run.result.videoResults[0].id;

    await processWorkflowVideoSubmissionJobById(queued.job.id, fixture.config, {
      createVideoGeneration: async () => ({ taskId: "lucky-ai-stable-key" }),
    });

    const updated = await getWorkflowRun(fixture.user.id, fixture.run.id, fixture.config);
    assert.equal(updated.result.videoResults.length, 1);
    assert.equal(updated.result.videoResults[0].id, instanceId);
    assert.equal(updated.result.videoResults[0].taskId, "lucky-ai-stable-key");
  } finally {
    await fixture.cleanup();
  }
});

test("worker restart resumes untouched items without resubmitting an uncertain request", async () => {
  const fixture = await createVideoQueueFixture();
  try {
    const queued = await enqueueWorkflowVideoSubmissionJob(fixture.user, {
      runId: fixture.run.id,
      tasks: [videoTask("video-1", 1), videoTask("video-2", 2)],
    }, fixture.config);
    const run = await getWorkflowRun(fixture.user.id, fixture.run.id, fixture.config);
    await updateWorkflowRun(fixture.user.id, fixture.run.id, {
      resultPatch: {
        videoResults: [{
          ...run.result.videoResults[0],
          status: "running",
          submissionState: "submitting",
          updatedAt: new Date().toISOString(),
        }],
      },
    }, fixture.config);
    await updateJobInternal(queued.job.id, { status: "running" }, fixture.config);

    const recovered = await recoverInterruptedWorkflowVideoSubmissionJobs(fixture.config);
    assert.equal(recovered.length, 1);
    const submittedPrompts = [];
    await processWorkflowVideoSubmissionJobById(queued.job.id, fixture.config, {
      createVideoGeneration: async (request) => {
        submittedPrompts.push(request.prompt);
        return { taskId: "upstream-video-2" };
      },
    });

    const updated = await getWorkflowRun(fixture.user.id, fixture.run.id, fixture.config);
    const first = updated.result.videoResults.find((video) => video.id === "video-1");
    const second = updated.result.videoResults.find((video) => video.id === "video-2");
    assert.deepEqual(submittedPrompts, ["视频提示词 2"]);
    assert.equal(first.submissionState, "unknown");
    assert.equal(first.submissionErrorKind, "submission-unknown");
    assert.match(first.error, /避免重复扣费/);
    assert.equal(second.taskId, "upstream-video-2");
  } finally {
    await fixture.cleanup();
  }
});

test("an HTTP 504 is kept as submission unknown while later videos continue", async () => {
  const fixture = await createVideoQueueFixture();
  try {
    const queued = await enqueueWorkflowVideoSubmissionJob(fixture.user, {
      runId: fixture.run.id,
      tasks: [videoTask("video-timeout", 1), videoTask("video-after-timeout", 2)],
    }, fixture.config);

    await processWorkflowVideoSubmissionJobById(queued.job.id, fixture.config, {
      createVideoGeneration: async (request) => {
        if (request.prompt === "视频提示词 1") {
          const error = new Error("拉奇AI视频任务创建失败：HTTP 504");
          error.status = 504;
          throw error;
        }
        return { taskId: "upstream-after-timeout" };
      },
    });

    const updated = await getWorkflowRun(fixture.user.id, fixture.run.id, fixture.config);
    const timedOut = updated.result.videoResults.find((video) => video.id === "video-timeout");
    const submitted = updated.result.videoResults.find((video) => video.id === "video-after-timeout");
    assert.equal(timedOut.submissionState, "unknown");
    assert.equal(timedOut.submissionErrorKind, "submission-unknown");
    assert.match(timedOut.error, /请勿直接重复提交/);
    assert.equal(submitted.taskId, "upstream-after-timeout");
  } finally {
    await fixture.cleanup();
  }
});

test("a task id in an ambiguous error response is persisted immediately", async () => {
  const fixture = await createVideoQueueFixture();
  try {
    const queued = await enqueueWorkflowVideoSubmissionJob(fixture.user, {
      runId: fixture.run.id,
      tasks: [videoTask("video-task-id-in-error", 1)],
    }, fixture.config);

    await processWorkflowVideoSubmissionJobById(queued.job.id, fixture.config, {
      createVideoGeneration: async () => {
        const error = new Error("拉奇AI视频任务创建失败：HTTP 504");
        error.status = 504;
        error.detail = { task_id: "upstream-recovered-from-error" };
        throw error;
      },
    });

    const updated = await getWorkflowRun(fixture.user.id, fixture.run.id, fixture.config);
    const recovered = updated.result.videoResults[0];
    assert.equal(recovered.taskId, "upstream-recovered-from-error");
    assert.equal(recovered.submissionState, "submitted");
    assert.equal(recovered.status, "running");
  } finally {
    await fixture.cleanup();
  }
});

test("a queued video deleted before submission is skipped", async () => {
  const fixture = await createVideoQueueFixture();
  try {
    const queued = await enqueueWorkflowVideoSubmissionJob(fixture.user, {
      runId: fixture.run.id,
      tasks: [videoTask("video-deleted", 1)],
    }, fixture.config);
    const run = await getWorkflowRun(fixture.user.id, fixture.run.id, fixture.config);
    await updateWorkflowRun(fixture.user.id, fixture.run.id, {
      videoResultRemovals: [run.result.videoResults[0]],
    }, fixture.config);
    let submissions = 0;

    await processWorkflowVideoSubmissionJobById(queued.job.id, fixture.config, {
      createVideoGeneration: async () => {
        submissions += 1;
        return { taskId: "should-not-exist" };
      },
    });

    const job = await getJob(fixture.user.id, queued.job.id, fixture.config);
    const updated = await getWorkflowRun(fixture.user.id, fixture.run.id, fixture.config);
    assert.equal(submissions, 0);
    assert.equal(job.status, "done");
    assert.equal(job.result.skipped, 1);
    assert.deepEqual(updated.result.videoResults, []);
  } finally {
    await fixture.cleanup();
  }
});

function videoTask(id, index) {
  const now = new Date(2026, 6, 20, 12, index).toISOString();
  return {
    video: {
      id,
      timelineItemId: `shot-${index}`,
      title: `分镜 ${String(index).padStart(2, "0")}`,
      createdAt: now,
      updatedAt: now,
      apiKeyId: "video-key",
      channel: "lucky-ai",
      modelId: "veo-3.1-lite",
      provider: "lucky-ai",
      prompt: `视频提示词 ${index}`,
      ratio: "16:9",
      duration: "8",
    },
    request: {
      apiKeyId: "video-key",
      channel: "lucky-ai",
      modelId: "veo-3.1-lite",
      modelProvider: "lucky-ai",
      prompt: `视频提示词 ${index}`,
      ratio: "16:9",
      duration: "8",
      frames: [`https://example.com/shot-${index}.png`],
    },
  };
}

async function createVideoQueueFixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "flowstudio-video-queue-"));
  const config = {
    env: "test",
    dataDir,
    store: { driver: "json" },
    worker: { pollMs: 10, videoSubmissionBatchSize: 1 },
  };
  const user = ensureUser(config, {
    id: "dev-user",
    email: "dev@flowstudio.local",
    displayName: "Video Queue Test User",
  });
  const workflow = await createWorkflow(user, {
    id: "workflow-video-queue",
    name: "后台视频队列测试",
    type: "explain",
    config: { type: "explain", executionStep: "all" },
  }, config);
  const run = await createWorkflowRun(user.id, workflow.id, {
    id: "run-video-queue",
    topic: "后台提交测试",
    status: "waiting",
    stages: {
      script: "done",
      audio: "done",
      shot: "done",
      image: "done",
      videoPrompt: "done",
      video: "pending",
      draft: "pending",
    },
    result: { videoResults: [], backendJobs: {} },
  }, config);
  return {
    config,
    user,
    workflow,
    run,
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  };
}
