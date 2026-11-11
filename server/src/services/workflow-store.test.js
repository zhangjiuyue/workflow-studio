import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { publicTopicConfirmationResult, queueConfirmedTopicScripts } from "../app.js";
import { getJob, listJobs } from "./job-store.js";
import { ensureUser } from "./user-store.js";
import { confirmWorkflowTopics, createWorkflow, createWorkflowRun, getWorkflow, getWorkflowRun, getWorkflowTopicConfirmationStatus, listWorkflowSummaries, listWorkflowTopicExecutionChildren, patchWorkflowRunBackendJob, patchWorkflowRunImageShot, updateWorkflow, updateWorkflowRun } from "./workflow-store.js";

test("creating ecommerce workflow rejects selected products without product image", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "flowstudio-workflow-store-"));
  const config = {
    env: "test",
    dataDir,
    store: {
      driver: "json",
    },
  };
  const user = ensureUser(config, {
    id: "dev-user",
    email: "dev@flowstudio.local",
    displayName: "Test User",
  });

  try {
    await assert.rejects(
      () => createWorkflow(user, {
        id: "workflow-missing-product-image",
        name: "缺商品图的带货视频",
        type: "ecommerce",
        config: {
          type: "ecommerce",
          ecommerceAssets: {
            products: {
              id: "product-1",
              name: "保温杯",
              productProfile: {
                productName: "保温杯",
              },
            },
          },
        },
      }, config),
      (error) => {
        assert.equal(error.status, 400);
        assert.equal(error.detail?.code, "ECOMMERCE_PRODUCT_IMAGE_MISSING");
        assert.match(error.message, /商品库缺少商品图/);
        return true;
      },
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("creating ecommerce workflow accepts selected products with product image", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "flowstudio-workflow-store-"));
  const config = {
    env: "test",
    dataDir,
    store: {
      driver: "json",
    },
  };
  const user = ensureUser(config, {
    id: "dev-user",
    email: "dev@flowstudio.local",
    displayName: "Test User",
  });

  try {
    const workflow = await createWorkflow(user, {
      id: "workflow-with-product-image",
      name: "有商品图的带货视频",
      type: "ecommerce",
      config: {
        type: "ecommerce",
        ecommerceAssets: {
          products: {
            id: "product-1",
            name: "保温杯",
            productImageUrl: "https://cdn.example.com/product.png",
            productProfile: {
              productName: "保温杯",
            },
          },
        },
      },
    }, config);

    assert.equal(workflow.id, "workflow-with-product-image");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("input-script ecommerce workflows require both a complete script and product asset", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "flowstudio-workflow-store-"));
  const config = {
    env: "test",
    dataDir,
    store: {
      driver: "json",
    },
  };
  const user = ensureUser(config, {
    id: "dev-user",
    email: "dev@flowstudio.local",
    displayName: "Test User",
  });

  try {
    await assert.rejects(
      () => createWorkflow(user, {
        id: "workflow-input-script-missing-script",
        name: "缺少完整剧本",
        type: "ecommerce",
        config: {
          type: "ecommerce",
          topicMode: "script",
          ecommerceAssets: {
            products: {
              id: "product-1",
              name: "保温杯",
              productImageUrl: "https://cdn.example.com/product.png",
            },
          },
        },
      }, config),
      (error) => error.status === 400 && error.detail?.code === "ECOMMERCE_INPUT_SCRIPT_REQUIRED",
    );

    await assert.rejects(
      () => createWorkflow(user, {
        id: "workflow-input-script-missing-product",
        name: "缺少商品库",
        type: "ecommerce",
        config: {
          type: "ecommerce",
          topicMode: "script",
          inputScript: "场景一：角色拿起商品并说出台词。",
          ecommerceAssets: {},
        },
      }, config),
      (error) => error.status === 400 && error.detail?.code === "ECOMMERCE_PRODUCT_REQUIRED",
    );

    await assert.rejects(
      () => createWorkflow(user, {
        id: "workflow-input-script-missing-duration",
        name: "缺少目标时长",
        type: "ecommerce",
        config: {
          type: "ecommerce",
          topicMode: "script",
          inputScript: "场景一：角色拿起商品并说出台词。",
          inputScriptDurationMode: "custom",
          inputScriptTargetDurationSeconds: 3,
          ecommerceAssets: {
            products: {
              id: "product-1",
              name: "保温杯",
              productImageUrl: "https://cdn.example.com/product.png",
            },
          },
        },
      }, config),
      (error) => error.status === 400 && error.detail?.code === "ECOMMERCE_INPUT_SCRIPT_TARGET_DURATION_REQUIRED",
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("confirming an input-script run skips topics and queues script conversion", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "flowstudio-workflow-store-"));
  const config = {
    env: "test",
    dataDir,
    store: {
      driver: "json",
    },
  };
  const user = ensureUser(config, {
    id: "dev-user",
    email: "dev@flowstudio.local",
    displayName: "Test User",
  });

  try {
    const workflow = await createWorkflow(user, {
      id: "workflow-input-script",
      name: "保温杯完整剧本",
      type: "ecommerce",
      config: {
        type: "ecommerce",
        topicMode: "script",
        inputScriptTitle: "保温杯里的心意",
        inputScript: "场景一：妈妈拿起保温杯。妈妈：水还是热的。",
        inputScriptDurationMode: "custom",
        inputScriptTargetDurationSeconds: 60,
        inputScriptShotDurationSeconds: 4.5,
        ecommerceAssets: {
          products: {
            id: "product-1",
            name: "保温杯",
            productImageUrl: "https://cdn.example.com/product.png",
          },
        },
      },
    }, config);
    const seedRun = await createWorkflowRun(user.id, workflow.id, {
      id: "run-input-script",
      topic: workflow.config.inputScriptTitle,
      status: "waiting",
      stages: {
        topic: "skipped",
        script: "pending",
      },
      topicGenerationStatus: "skipped",
    }, config);

    const result = await confirmWorkflowTopics(user.id, seedRun.id, {
      topics: [workflow.config.inputScriptTitle],
    }, config);
    assert.equal(result.run.stages.topic, "skipped");
    assert.equal(result.children.length, 1);
    assert.equal(result.children[0].stages.topic, "skipped");
    assert.equal(result.children[0].topic, "保温杯里的心意");
    assert.equal(result.children[0].result.workflowSnapshot.inputScriptTitle, "保温杯里的心意");
    assert.equal(result.children[0].result.workflowSnapshot.inputScriptDurationMode, "custom");
    assert.equal(result.children[0].result.workflowSnapshot.inputScriptTargetDurationSeconds, 60);
    assert.equal(result.children[0].result.workflowSnapshot.inputScriptShotDurationSeconds, 4.5);

    await queueConfirmedTopicScripts(user, result.children, config);
    const child = await getWorkflowRun(user.id, result.children[0].id, config);
    assert.equal(child.stages.script, "running");
    assert.equal(child.result.backendJobs.script.title, "完整剧本格式转换");
    assert.equal(child.result.backendJobs.script.payload.autoQueuedFrom, "script-input");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("confirming custom topics carries adaptation ideas into child runs", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "flowstudio-workflow-store-"));
  const config = {
    env: "test",
    dataDir,
    store: {
      driver: "json",
    },
  };
  const user = ensureUser(config, {
    id: "dev-user",
    email: "dev@flowstudio.local",
    displayName: "Test User",
  });

  try {
    const topic = "办公室误会反转：男女角色互换";
    const adaptation = "把对标视频里的男女角色互换，情侣关系改成同事关系。";
    const workflow = await createWorkflow(user, {
      id: "workflow-custom-topic",
      name: "带货视频自定义选题",
      type: "ecommerce",
      config: {
        type: "ecommerce",
        topicMode: "custom",
        customTopics: [
          {
            title: topic,
            adaptation,
          },
        ],
      },
    }, config);
    const run = await createWorkflowRun(user.id, workflow.id, {
      id: "run-custom-topic",
      kind: "topic-seed",
      topic: "自定义选题",
      status: "waiting",
      stages: {
        topic: "done",
      },
      generatedTopics: [topic],
      topicGenerationStatus: "done",
      result: {
        topicAdaptations: {
          [topic]: adaptation,
        },
      },
    }, config);

    const result = await confirmWorkflowTopics(user.id, run.id, {
      topics: [topic],
    }, config);

    assert.equal(result.children.length, 1);
    assert.equal(result.children[0].topic, topic);
    assert.equal(result.children[0].result.topicAdaptation, adaptation);
    assert.deepEqual(result.children[0].result.topicAdaptations, {
      [topic]: adaptation,
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("confirmed topic script queue uses child workflow snapshot", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "flowstudio-workflow-store-"));
  const config = {
    env: "test",
    dataDir,
    store: {
      driver: "json",
    },
  };
  const user = ensureUser(config, {
    id: "dev-user",
    email: "dev@flowstudio.local",
    displayName: "Test User",
  });

  try {
    const topic = "半夜醒来后的古人";
    const workflow = await createWorkflow(user, {
      id: "workflow-snapshot-topic",
      name: "口播视频选题",
      type: "explain",
      config: {
        type: "explain",
        executionStep: "shot",
      },
    }, config);
    const run = await createWorkflowRun(user.id, workflow.id, {
      id: "run-snapshot-topic",
      kind: "topic-seed",
      topic: "历史冷知识",
      status: "waiting",
      stages: {
        topic: "done",
      },
      generatedTopics: [topic],
      topicGenerationStatus: "done",
    }, config);
    const result = await confirmWorkflowTopics(user.id, run.id, {
      topics: [topic],
    }, config);
    await updateWorkflow(user.id, workflow.id, {
      config: {
        executionStep: "story",
      },
    }, config);

    const queuedChildren = await queueConfirmedTopicScripts(user, result.children, config);

    assert.equal(queuedChildren.length, 1);
    const updatedChild = await getWorkflowRun(user.id, result.children[0].id, config);
    const scriptJob = updatedChild.result.backendJobs.script;
    const storedJob = await getJob(user.id, scriptJob.id, config);
    assert.equal(updatedChild.stages.script, "running");
    assert.equal(scriptJob.payload.executionStep, "shot");
    assert.equal(storedJob.payload.executionStep, "shot");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("topic confirmation response omits heavy workflow run results", async () => {
  const heavyMarker = `data:image/png;base64,${"a".repeat(200_000)}`;
  const result = {
    run: {
      id: "parent-run",
      workflowId: "workflow-heavy-snapshot",
      kind: "topic-seed",
      status: "waiting",
      confirmedTopics: ["选题一"],
      result: {
        workflowSnapshot: {
          productImageUrl: heavyMarker,
        },
      },
      children: [{
        id: "existing-child",
        workflowId: "workflow-heavy-snapshot",
        parentRunId: "parent-run",
        kind: "topic-child",
        topic: "已有选题",
        result: {
          shots: [{ imageUrl: heavyMarker }],
        },
      }],
    },
    children: [{
      id: "new-child",
      workflowId: "workflow-heavy-snapshot",
      parentRunId: "parent-run",
      kind: "topic-child",
      topic: "选题一",
      status: "waiting",
      stages: { script: "pending" },
      result: {
        workflowSnapshot: {
          productImageUrl: heavyMarker,
        },
      },
    }],
  };

  const response = publicTopicConfirmationResult(result);
  const serialized = JSON.stringify(response);

  assert.equal(response.run.id, "parent-run");
  assert.deepEqual(response.run.confirmedTopics, ["选题一"]);
  assert.equal(response.run.children[0].id, "existing-child");
  assert.equal(response.children[0].id, "new-child");
  assert.equal(response.children[0].topic, "选题一");
  assert.equal(response.children[0].stages.script, "pending");
  assert.equal("result" in response.run, false);
  assert.equal("result" in response.run.children[0], false);
  assert.equal("result" in response.children[0], false);
  assert.equal(serialized.includes(heavyMarker), false);
  assert.ok(serialized.length < 10_000);
});

test("topic confirmation and script execution are separate and idempotent", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "flowstudio-workflow-store-"));
  const config = {
    env: "test",
    dataDir,
    store: {
      driver: "json",
    },
  };
  const user = ensureUser(config, {
    id: "dev-user",
    email: "dev@flowstudio.local",
    displayName: "Test User",
  });

  try {
    const topic = "食盐如何改变帝国";
    const workflow = await createWorkflow(user, {
      id: "workflow-two-phase-topic",
      name: "口播视频两阶段选题",
      type: "explain",
      config: { type: "explain", executionStep: "story" },
    }, config);
    const run = await createWorkflowRun(user.id, workflow.id, {
      id: "run-two-phase-topic",
      kind: "topic-seed",
      topic: "历史冷知识",
      status: "waiting",
      stages: { topic: "done" },
      generatedTopics: [topic],
      topicGenerationStatus: "done",
      result: {
        largeSnapshot: `data:image/png;base64,${"b".repeat(50_000)}`,
      },
    }, config);
    const confirmed = await confirmWorkflowTopics(user.id, run.id, { topics: [topic] }, config);

    const statusBeforeExecution = await getWorkflowTopicConfirmationStatus(user.id, run.id, config);
    assert.deepEqual(statusBeforeExecution.result, {});
    assert.deepEqual(statusBeforeExecution.children[0].result, {});
    assert.equal(statusBeforeExecution.children[0].stages.script, "pending");
    assert.equal((await listJobs(user.id, config, { runId: confirmed.children[0].id })).length, 0);

    const executionChildren = await listWorkflowTopicExecutionChildren(user.id, run.id, {
      childIds: [confirmed.children[0].id],
    }, config);
    assert.equal(executionChildren.length, 1);
    await Promise.all([
      queueConfirmedTopicScripts(user, executionChildren, config),
      queueConfirmedTopicScripts(user, executionChildren, config),
    ]);

    const scriptJobs = await listJobs(user.id, config, { runId: confirmed.children[0].id });
    const statusAfterExecution = await getWorkflowTopicConfirmationStatus(user.id, run.id, config);
    assert.equal(scriptJobs.length, 1);
    assert.equal(scriptJobs[0].nodeId, "script");
    assert.equal(statusAfterExecution.children[0].stages.script, "running");
    assert.deepEqual(
      await listWorkflowTopicExecutionChildren(user.id, run.id, { childIds: [confirmed.children[0].id] }, config),
      [],
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("completed images do not overwrite an active draft run status", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "flowstudio-workflow-store-"));
  const config = {
    env: "test",
    dataDir,
    store: {
      driver: "json",
    },
  };
  const user = ensureUser(config, {
    id: "dev-user",
    email: "dev@flowstudio.local",
    displayName: "Test User",
  });

  try {
    const workflow = await createWorkflow(user, {
      id: "workflow-active-draft",
      name: "口播视频草稿",
      type: "explain",
      config: { type: "explain" },
    }, config);
    const run = await createWorkflowRun(user.id, workflow.id, {
      id: "run-active-draft",
      topic: "测试草稿重新生成",
      status: "waiting",
      stages: {
        audio: "done",
        shot: "done",
        image: "done",
        draft: "pending",
      },
      result: {
        shots: [{
          id: "shot-1",
          index: 1,
          imageUrl: "https://media.example.com/shot-1.png",
          imageStatus: "done",
        }],
      },
    }, config);
    const draftJob = {
      id: "draft-job-1",
      nodeId: "draft",
      status: "queued",
      progress: 0,
    };

    const updated = await updateWorkflowRun(user.id, run.id, {
      status: "running",
      stages: {
        ...run.stages,
        draft: "running",
      },
      result: {
        ...run.result,
        draftStatus: "running",
        draftUrl: "",
        backendJobs: { draft: draftJob },
      },
    }, config);

    assert.equal(updated.status, "running");
    assert.equal(updated.stages.image, "done");
    assert.equal(updated.stages.draft, "running");
    assert.equal(updated.result.backendJobs.draft.status, "queued");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a stale client update cannot erase the current image job ownership", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "flowstudio-workflow-store-"));
  const config = {
    env: "test",
    dataDir,
    store: {
      driver: "json",
    },
  };
  const user = ensureUser(config, {
    id: "dev-user",
    email: "dev@flowstudio.local",
    displayName: "Test User",
  });

  try {
    const workflow = await createWorkflow(user, {
      id: "workflow-active-image-job",
      name: "口播视频分镜图",
      type: "explain",
      config: { type: "explain" },
    }, config);
    const imageJob = {
      id: "image-job-current",
      nodeId: "image",
      status: "queued",
    };
    const run = await createWorkflowRun(user.id, workflow.id, {
      id: "run-active-image-job",
      status: "running",
      stages: { shot: "done", image: "running" },
      result: {
        backendJobs: { image: imageJob },
        shots: [{
          id: "shot-1",
          imageStatus: "running",
          imageJobId: imageJob.id,
          imageRequestId: "request-current",
          imageSubmittedAt: "2026-07-19T08:00:00.000Z",
        }],
      },
    }, config);

    const updated = await updateWorkflowRun(user.id, run.id, {
      status: "running",
      stages: { ...run.stages, image: "running" },
      result: {
        ...run.result,
        backendJobs: { image: imageJob },
        shots: [{ id: "shot-1", imageStatus: "pending" }],
      },
    }, config);

    assert.equal(updated.result.shots[0].imageStatus, "running");
    assert.equal(updated.result.shots[0].imageJobId, imageJob.id);
    assert.equal(updated.result.shots[0].imageRequestId, "request-current");
    assert.equal(updated.result.shots[0].imageSubmittedAt, "2026-07-19T08:00:00.000Z");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a stale same-job snapshot cannot move a submitted image back to queued", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "flowstudio-workflow-store-"));
  const config = {
    env: "test",
    dataDir,
    store: { driver: "json" },
  };
  const user = ensureUser(config, {
    id: "dev-user",
    email: "dev@flowstudio.local",
    displayName: "Test User",
  });

  try {
    const workflow = await createWorkflow(user, {
      id: "workflow-same-image-job",
      name: "同任务分镜图",
      type: "explain",
      config: { type: "explain" },
    }, config);
    const imageJob = { id: "image-job-same", nodeId: "image", status: "running" };
    const run = await createWorkflowRun(user.id, workflow.id, {
      id: "run-same-image-job",
      status: "running",
      stages: { shot: "done", image: "running" },
      result: {
        backendJobs: { image: imageJob },
        shots: [{
          id: "shot-same",
          imageStatus: "running",
          imageJobId: imageJob.id,
          imageRequestId: "request-same",
          imageStartedAt: "2026-07-19T12:55:47.000Z",
          imageSubmittedAt: "2026-07-19T12:56:01.000Z",
          imageUrl: "",
        }],
      },
    }, config);

    const updated = await updateWorkflowRun(user.id, run.id, {
      status: "running",
      stages: { ...run.stages, image: "running" },
      result: {
        ...run.result,
        backendJobs: { image: imageJob },
        shots: [{
          id: "shot-same",
          imageStatus: "queued",
          imageJobId: imageJob.id,
          imageRequestId: "request-same",
          imageStartedAt: "",
          imageSubmittedAt: "",
          imageUrl: "",
        }],
      },
    }, config);

    assert.equal(updated.result.shots[0].imageStatus, "running");
    assert.equal(updated.result.shots[0].imageStartedAt, "2026-07-19T12:55:47.000Z");
    assert.equal(updated.result.shots[0].imageSubmittedAt, "2026-07-19T12:56:01.000Z");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("attaching an image job cannot overwrite a newer shot execution state", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "flowstudio-workflow-store-"));
  const config = {
    env: "test",
    dataDir,
    store: { driver: "json" },
  };
  const user = ensureUser(config, {
    id: "dev-user",
    email: "dev@flowstudio.local",
    displayName: "Test User",
  });

  try {
    const workflow = await createWorkflow(user, {
      id: "workflow-atomic-image-job",
      name: "并发分镜图",
      type: "explain",
      config: { type: "explain" },
    }, config);
    const imageJob = { id: "image-job-atomic", nodeId: "image", status: "queued" };
    const run = await createWorkflowRun(user.id, workflow.id, {
      id: "run-atomic-image-job",
      status: "waiting",
      stages: { shot: "done", image: "pending" },
      result: {
        shots: [{
          id: "shot-atomic",
          imageStatus: "queued",
          imageJobId: imageJob.id,
          imageRequestId: "request-atomic",
          imageUrl: "",
        }],
      },
    }, config);

    await patchWorkflowRunImageShot(user.id, run.id, {
      shotId: "shot-atomic",
      expectedJobId: imageJob.id,
      expectedRequestId: "request-atomic",
      expectedStatuses: ["queued"],
      requireMissingImage: true,
      patch: {
        imageStatus: "running",
        imageStartedAt: "2026-07-19T12:55:47.000Z",
        imageSubmittedAt: "2026-07-19T12:56:01.000Z",
      },
    }, config);

    const updated = await patchWorkflowRunBackendJob(user.id, run.id, {
      nodeId: "image",
      job: imageJob,
      stages: { image: "running" },
      runPatch: { status: "running", completedAt: "" },
    }, config);

    assert.equal(updated.status, "running");
    assert.equal(updated.stages.image, "running");
    assert.equal(updated.result.backendJobs.image.id, imageJob.id);
    assert.equal(updated.result.shots[0].imageStatus, "running");
    assert.equal(updated.result.shots[0].imageRequestId, "request-atomic");
    assert.equal(updated.result.shots[0].imageSubmittedAt, "2026-07-19T12:56:01.000Z");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("workflow run resultPatch preserves unrelated generated results", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "flowstudio-workflow-store-"));
  const config = {
    env: "test",
    dataDir,
    store: {
      driver: "json",
    },
  };
  const user = ensureUser(config, {
    id: "dev-user",
    email: "dev@flowstudio.local",
    displayName: "Test User",
  });

  try {
    const workflow = await createWorkflow(user, {
      id: "workflow-cover-result-patch",
      name: "封面局部更新测试",
      type: "explain",
      config: { type: "explain" },
    }, config);
    const run = await createWorkflowRun(user.id, workflow.id, {
      id: "run-cover-result-patch",
      topic: "测试选题",
      result: {
        scriptOutput: "已生成的文案",
        shots: [{ id: "shot-1", imageUrl: "https://cdn.example.com/shot.png" }],
      },
    }, config);

    await updateWorkflowRun(user.id, run.id, {
      resultPatch: {
        coverImages: [{ id: "cover-1", url: "https://cdn.example.com/cover.png" }],
      },
    }, config);

    const updated = await getWorkflowRun(user.id, run.id, config);
    assert.equal(updated.result.scriptOutput, "已生成的文案");
    assert.equal(updated.result.shots[0].imageUrl, "https://cdn.example.com/shot.png");
    assert.equal(updated.result.coverImages[0].id, "cover-1");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("workflow video result patches preserve independent tasks for the same storyboard", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "flowstudio-workflow-store-"));
  const config = {
    env: "test",
    dataDir,
    store: {
      driver: "json",
    },
  };
  const user = ensureUser(config, {
    id: "dev-user",
    email: "dev@flowstudio.local",
    displayName: "Test User",
  });

  try {
    const workflow = await createWorkflow(user, {
      id: "workflow-video-result-patch",
      name: "视频任务局部更新测试",
      type: "explain",
      config: { type: "explain" },
    }, config);
    const first = {
      id: "local-1",
      timelineItemId: "segment-1",
      taskId: "task-1",
      status: "running",
      updatedAt: "2026-07-20T08:00:00.000Z",
    };
    const second = {
      id: "local-2",
      timelineItemId: "segment-1",
      taskId: "task-2",
      status: "running",
      updatedAt: "2026-07-20T08:00:01.000Z",
    };
    const run = await createWorkflowRun(user.id, workflow.id, {
      id: "run-video-result-patch",
      topic: "测试选题",
      result: { videoResults: [first] },
    }, config);

    await updateWorkflowRun(user.id, run.id, {
      resultPatch: { videoResults: [first, second] },
    }, config);
    await updateWorkflowRun(user.id, run.id, {
      resultPatch: {
        videoResults: [{
          ...first,
          status: "done",
          updatedAt: "2026-07-20T08:00:02.000Z",
        }],
      },
    }, config);

    const preserved = await getWorkflowRun(user.id, run.id, config);
    assert.deepEqual(preserved.result.videoResults.map((video) => video.taskId), ["task-1", "task-2"]);
    assert.equal(preserved.result.videoResults[0].status, "done");

    await updateWorkflowRun(user.id, run.id, {
      status: "running",
      stages: { image: "running", video: "pending" },
      result: {
        ...preserved.result,
        videoTimeline: [],
        videoResults: [],
      },
    }, config);

    const afterImageReset = await getWorkflowRun(user.id, run.id, config);
    assert.deepEqual(afterImageReset.result.videoResults.map((video) => video.taskId), ["task-1", "task-2"]);

    await updateWorkflowRun(user.id, run.id, {
      resultPatch: { videoResults: [first] },
      videoResultRemovals: [second],
    }, config);

    const removed = await getWorkflowRun(user.id, run.id, config);
    assert.deepEqual(removed.result.videoResults.map((video) => video.taskId), ["task-1"]);

    await updateWorkflowRun(user.id, run.id, {
      resultPatch: {
        videoResults: [{
          ...second,
          status: "done",
          updatedAt: "2026-07-20T08:00:03.000Z",
        }],
      },
    }, config);

    const afterStalePoll = await getWorkflowRun(user.id, run.id, config);
    assert.deepEqual(afterStalePoll.result.videoResults.map((video) => video.taskId), ["task-1"]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("workflow summaries stay lightweight while run details only include direct children", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "flowstudio-workflow-store-"));
  const config = {
    env: "test",
    dataDir,
    store: {
      driver: "json",
    },
  };
  const user = ensureUser(config, {
    id: "dev-user",
    email: "dev@flowstudio.local",
    displayName: "Test User",
  });

  try {
    const workflow = await createWorkflow(user, {
      id: "workflow-summary",
      name: "摘要测试工作流",
      type: "explain",
      config: { type: "explain", language: "zh" },
    }, config);
    const firstParent = await createWorkflowRun(user.id, workflow.id, {
      id: "summary-parent-1",
      topic: "第一个主任务",
      status: "waiting",
      stages: { topic: "done" },
      generatedTopics: ["子任务选题"],
    }, config);
    const confirmation = await confirmWorkflowTopics(user.id, firstParent.id, {
      topics: ["子任务选题"],
    }, config);
    const child = confirmation.children[0];
    await createWorkflowRun(user.id, workflow.id, {
      id: "summary-parent-2",
      topic: "第二个主任务",
      status: "waiting",
    }, config);

    const heavyMarker = `data:image/png;base64,${"x".repeat(200_000)}`;
    const script = "这是一段很长的文案。".repeat(200);
    await updateWorkflowRun(user.id, child.id, {
      status: "error",
      stages: { script: "done", shot: "done", image: "error" },
      result: {
        scriptOutput: script,
        shots: [{
          id: "shot-1",
          imageStatus: "error",
          imageError: "图片生成失败",
          imagePrompt: heavyMarker,
          nestedPayload: heavyMarker,
        }],
        audioSegments: Array.from({ length: 12 }, (_, index) => ({ text: `句子 ${index + 1}`, detail: heavyMarker })),
        unrelatedLargePayload: heavyMarker,
      },
    }, config);

    const summaries = await listWorkflowSummaries(user.id, config);
    const serialized = JSON.stringify(summaries);
    const summarizedParent = summaries[0].runs.find((item) => item.id === firstParent.id);
    const summarizedChild = summarizedParent.children[0];
    assert.equal(serialized.includes(heavyMarker), false);
    assert.equal(summarizedChild.result.scriptOutput.length, 260);
    assert.equal(summarizedChild.result.scriptCharCount, script.length);
    assert.equal(summarizedChild.result.audioSegmentCount, 12);
    assert.equal(summarizedChild.result.shots[0].imageStatus, "error");
    assert.equal("imagePrompt" in summarizedChild.result.shots[0], false);

    const parentDetail = await getWorkflowRun(user.id, firstParent.id, config);
    assert.deepEqual(parentDetail.children.map((item) => item.id), [child.id]);
    const childDetail = await getWorkflowRun(user.id, child.id, config);
    assert.deepEqual(childDetail.children, []);
    assert.equal(childDetail.result.unrelatedLargePayload, heavyMarker);

    const workflowDetail = await getWorkflow(user.id, workflow.id, config);
    assert.equal(workflowDetail.id, workflow.id);
    assert.equal("runs" in workflowDetail, false);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
