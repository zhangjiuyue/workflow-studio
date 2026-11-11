import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
const providerFixtureDir = mkdtempSync(path.join(tmpdir(), "workflow-image-provider-"));
const providerFixturePath = path.join(providerFixtureDir, "providers.json");
writeFileSync(providerFixturePath, JSON.stringify([
  ["Synthetic Image", "https://image.example.com"], ["Synthetic Async", "https://async.example.com"]
].map(([channel, endpoint]) => ({ channel, services: { image: { endpoint, adapter: "module",
  module: new URL('./test-support/media-adapter.mjs', import.meta.url).pathname, models: ["test-image"] } } }))));
process.env.WORKFLOW_PROVIDER_CONFIG = providerFixturePath;
process.on("exit", () => rmSync(providerFixtureDir, {recursive:true, force:true}));
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { saveApiKey } from "./api-key-store.js";
import { executeWorkflowImageNode } from "./workflow-image-runner.js";
import { ensureUser } from "./user-store.js";
import { createWorkflow, createWorkflowRun, getWorkflowRun, patchWorkflowRunImageShot } from "./workflow-store.js";

test("image node targets shots by shotId when id is absent", async () => {
  const { config, user, run, cleanup } = await createWorkflowImageFixture({
    shots: [
      {
        shotId: "scene-shot-1",
        index: 1,
        assetType: "scene",
        title: "寒冬烤摊",
        prompt: "寒冬街边烤摊，空无一人，暖色灯光",
        imageStatus: "pending",
        imageUrl: "",
      },
    ],
  });
  const fetchCalls = mockImageFetch();
  try {
    const result = await executeWorkflowImageNode(user, {
      runId: run.id,
      shotIds: ["scene-shot-1"],
      imageKeyId: "image-key",
      imageModelId: "test-image",
    }, config);

    assert.equal(fetchCalls.length, 1);
    assert.equal(result.totalCount, 1);
    assert.equal(result.doneCount, 1);
    assert.equal(result.missingCount, 0);

    const updatedRun = await getWorkflowRun(user.id, run.id, config);
    const shot = updatedRun.result.shots[0];
    assert.equal(shot.imageStatus, "done");
    assert.equal(shot.imageError, "");
    assert.equal(shot.imageUrl, "https://cdn.example.com/generated-scene.png");
    assert.equal(updatedRun.stages.image, "done");
    assert.equal(updatedRun.status, "waiting");
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("atomic image shot updates reject stale workers without overwriting a saved image", async () => {
  const { config, user, run, cleanup } = await createWorkflowImageFixture({
    shots: [{
      id: "owned-shot",
      index: 1,
      assetType: "scene",
      title: "并发归属测试",
      prompt: "夜晚车站",
      imageStatus: "queued",
      imageJobId: "image-job",
      imageRequestId: "request-current",
      imageUrl: "",
    }],
  });
  try {
    const running = await patchWorkflowRunImageShot(user.id, run.id, {
      shotId: "owned-shot",
      expectedJobId: "image-job",
      expectedRequestId: "request-current",
      expectedStatuses: ["queued"],
      requireMissingImage: true,
      patch: { imageStatus: "running" },
    }, config);
    assert.equal(running.updated, true);

    const completed = await patchWorkflowRunImageShot(user.id, run.id, {
      shotId: "owned-shot",
      expectedJobId: "image-job",
      expectedRequestId: "request-current",
      expectedStatuses: ["running"],
      requireMissingImage: true,
      patch: {
        imageStatus: "done",
        imageUrl: "https://cdn.example.com/current.png",
        imageError: "",
      },
    }, config);
    assert.equal(completed.updated, true);

    const stale = await patchWorkflowRunImageShot(user.id, run.id, {
      shotId: "owned-shot",
      expectedJobId: "image-job",
      expectedRequestId: "request-stale",
      expectedStatuses: ["running"],
      requireMissingImage: true,
      patch: {
        imageStatus: "error",
        imageUrl: "",
        imageError: "stale failure",
      },
    }, config);
    assert.equal(stale.updated, false);

    const updatedRun = await getWorkflowRun(user.id, run.id, config);
    assert.equal(updatedRun.result.shots[0].imageStatus, "done");
    assert.equal(updatedRun.result.shots[0].imageUrl, "https://cdn.example.com/current.png");
    assert.equal(updatedRun.result.shots[0].imageError, "");
  } finally {
    await cleanup();
  }
});

test("image node reports missing ecommerce product images as image stage error", async () => {
  const { config, user, run, cleanup } = await createWorkflowImageFixture({
    shots: [
      {
        id: "scene-shot",
        index: 1,
        assetType: "scene",
        title: "寒冬烤摊",
        prompt: "寒冬街边烤摊，空无一人，暖色灯光",
        imageStatus: "pending",
        imageUrl: "",
      },
      {
        id: "product-shot",
        index: 2,
        assetType: "product",
        title: "保温杯",
        prompt: "保温杯",
        imageStatus: "error",
        imageError: "产品库未上传商品图",
        imageUrl: "",
      },
    ],
  });
  const fetchCalls = mockImageFetch();
  try {
    const result = await executeWorkflowImageNode(user, {
      runId: run.id,
      imageKeyId: "image-key",
      imageModelId: "test-image",
    }, config);

    assert.equal(fetchCalls.length, 1);
    assert.equal(result.totalCount, 2);
    assert.equal(result.doneCount, 1);
    assert.equal(result.missingCount, 1);
    assert.equal(result.errorSummary, "图片阶段异常：商品资产缺少商品图，请上传后重试。");

    const updatedRun = await getWorkflowRun(user.id, run.id, config);
    const [scene, product] = updatedRun.result.shots;
    assert.equal(scene.imageStatus, "done");
    assert.equal(scene.imageUrl, "https://cdn.example.com/generated-scene.png");
    assert.equal(product.imageStatus, "error");
    assert.equal(product.imageError, "图片阶段异常：商品资产缺少商品图，请上传后重试。");
    assert.equal(product.imageUrl, "");
    assert.equal(updatedRun.stages.image, "error");
    assert.equal(updatedRun.status, "waiting");
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("image node fails fast when only ecommerce product image is missing", async () => {
  const { config, user, run, cleanup } = await createWorkflowImageFixture({
    shots: [
      {
        id: "product-shot",
        index: 1,
        assetType: "product",
        title: "保温杯",
        prompt: "保温杯",
        imageStatus: "error",
        imageError: "产品库未上传商品图",
        imageUrl: "",
      },
    ],
  });
  const fetchCalls = mockImageFetch();
  try {
    const result = await executeWorkflowImageNode(user, {
      runId: run.id,
      imageKeyId: "image-key",
      imageModelId: "test-image",
    }, config);

    assert.equal(fetchCalls.length, 0);
    assert.equal(result.totalCount, 1);
    assert.equal(result.doneCount, 0);
    assert.equal(result.missingCount, 1);
    assert.equal(result.errorSummary, "图片阶段异常：商品资产缺少商品图，请上传后重试。");

    const updatedRun = await getWorkflowRun(user.id, run.id, config);
    const [product] = updatedRun.result.shots;
    assert.equal(product.imageStatus, "error");
    assert.equal(product.imageError, "图片阶段异常：商品资产缺少商品图，请上传后重试。");
    assert.equal(updatedRun.stages.image, "error");
    assert.equal(updatedRun.status, "waiting");
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("image node skips ecommerce product closeup scenes without calling image model", async () => {
  const { config, user, run, cleanup } = await createWorkflowImageFixture({
    shots: [
      {
        id: "product-closeup-scene",
        index: 1,
        assetType: "scene",
        title: "产品特写",
        prompt: "保温杯包装盒特写，品牌 Logo 清晰，空无一人",
        imageStatus: "pending",
        imageUrl: "",
      },
      {
        id: "scene-shot",
        index: 2,
        assetType: "scene",
        title: "厨房餐桌",
        prompt: "清晨厨房餐桌，空无一人，自然光，不出现产品特写或包装盒",
        imageStatus: "pending",
        imageUrl: "",
      },
    ],
  });
  const fetchCalls = mockImageFetch();
  try {
    const result = await executeWorkflowImageNode(user, {
      runId: run.id,
      imageKeyId: "image-key",
      imageModelId: "test-image",
    }, config);

    assert.equal(fetchCalls.length, 1);
    assert.equal(result.totalCount, 1);
    assert.equal(result.doneCount, 1);
    assert.equal(result.missingCount, 0);

    const updatedRun = await getWorkflowRun(user.id, run.id, config);
    const [closeup, scene] = updatedRun.result.shots;
    assert.equal(closeup.imageStatus, "pending");
    assert.equal(closeup.imageUrl, "");
    assert.equal(scene.imageStatus, "done");
    assert.equal(scene.imageUrl, "https://cdn.example.com/generated-scene.png");
    assert.equal(updatedRun.stages.image, "done");
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("Async adapter image task id is persisted before polling and the completed image is attached", async () => {
  const { config, user, run, cleanup } = await createWorkflowImageFixture({
    imageChannel: "Synthetic Async",
    imageEndpoint: "https://async.example.com",
    workflowConfig: {
      imageModelId: "Synthetic Async::test-image",
    },
    shots: [{
      id: "laqi-shot",
      index: 1,
      assetType: "scene",
      title: "拉奇异步图片",
      prompt: "盐矿中的工人",
      imageStatus: "pending",
      imageUrl: "",
    }],
  });
  config.modelProxy = { laqiImagePollMs: 1, adapterTimeoutMs: 1000 };
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET" });
    if ((options.method || "GET") === "POST") {
      return jsonResponse({ task_id: "laqi-image-task-1", status: "queued" });
    }
    const linkedRun = await getWorkflowRun(user.id, run.id, config);
    assert.equal(linkedRun.result.shots[0].imageProviderTaskId, "laqi-image-task-1");
    assert.equal(linkedRun.result.shots[0].imageProviderChannel, "Synthetic Async");
    return jsonResponse({
      task_id: "laqi-image-task-1",
      status: "success",
      data: [{ url: "https://cdn.example.com/laqi-image.png" }],
    });
  };
  try {
    const result = await executeWorkflowImageNode(user, {
      runId: run.id,
      imageKeyId: "image-key",
      imageModelId: "test-image",
    }, config);

    assert.equal(result.doneCount, 1);
    assert.deepEqual(calls.map((call) => call.method), ["POST", "GET"]);
    const updatedRun = await getWorkflowRun(user.id, run.id, config);
    const shot = updatedRun.result.shots[0];
    assert.equal(shot.imageUrl, "https://cdn.example.com/laqi-image.png");
    assert.equal(shot.imageProviderTaskId, "laqi-image-task-1");
    assert.equal(shot.imageProviderStatus, "done");
  } finally {
    globalThis.fetch = originalFetch;
    await cleanup();
  }
});

test("Synthetic Image workflow image option id resolves to the trusted provider model id", async () => {
  const { config, user, run, cleanup } = await createWorkflowImageFixture({
    imageChannel: "Synthetic Image",
    imageEndpoint: "https://image.example.com",
    workflowConfig: {
      imageModelId: "Synthetic Image::test-image",
    },
    shots: [{
      id: "synthetic-shot",
      index: 1,
      assetType: "role",
      title: "Synthetic Image 角色图",
      prompt: "中国现代女性在唱歌",
      imageStatus: "pending",
      imageUrl: "",
    }],
  });
  const fetchCalls = mockImageFetch();
  try {
    const result = await executeWorkflowImageNode(user, {
      runId: run.id,
      imageKeyId: "image-key",
      imageModelId: "Synthetic Image::test-image",
    }, config);

    assert.equal(result.doneCount, 1);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, "https://image.example.com/images/generations");
    assert.equal(JSON.parse(fetchCalls[0].options.body).model, "test-image");
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("Async adapter image retry resumes the saved upstream task and uses provider-specific recovery text", async () => {
  const { config, user, run, cleanup } = await createWorkflowImageFixture({
    imageChannel: "Synthetic Async",
    imageEndpoint: "https://async.example.com",
    workflowConfig: {
      imageModelId: "Synthetic Async::test-image",
    },
    shots: [{
      id: "laqi-resume-shot",
      index: 1,
      assetType: "scene",
      title: "恢复拉奇图片",
      prompt: "古代盐场",
      imageStatus: "paused",
      imagePauseReason: "等待上游结果",
      imageProviderTaskId: "laqi-existing-task",
      imageProviderChannel: "Synthetic Async",
      imageProviderStatus: "processing",
      imageUrl: "",
    }],
  });
  config.modelProxy = { laqiImagePollMs: 1, adapterTimeoutMs: 1000 };
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET" });
    return jsonResponse({ message: "gateway timeout" }, 504);
  };
  try {
    const result = await executeWorkflowImageNode(user, {
      runId: run.id,
      imageKeyId: "image-key",
      imageModelId: "test-image",
    }, config);

    assert.equal(result.pausedCount, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "GET");
    assert.match(calls[0].url, /laqi-existing-task/);
    const updatedRun = await getWorkflowRun(user.id, run.id, config);
    const shot = updatedRun.result.shots[0];
    assert.equal(shot.imageStatus, "paused");
    assert.equal(shot.imageError, "");
    assert.match(shot.imagePauseReason, /Synthetic Async任务仍在上游处理中/);
    assert.match(shot.imagePauseReason, /laqi-existing-task/);
    assert.doesNotMatch(shot.imagePauseReason, /unconfigured-provider/);
  } finally {
    globalThis.fetch = originalFetch;
    await cleanup();
  }
});

test("image node allows built-in workflow visual styles", async () => {
  const { config, user, run, cleanup } = await createWorkflowImageFixture({
    workflowConfig: {
      visualStyleId: "system-real-photo",
      visualStyleName: "真实摄影风",
      visualStylePrompt: "realistic photography, natural lighting",
    },
    shots: [
      {
        id: "scene-shot",
        index: 1,
        assetType: "scene",
        title: "酒店门外",
        prompt: "高端酒店门外，空无一人，夜晚灯光",
        imageStatus: "pending",
        imageUrl: "",
      },
    ],
  });
  const fetchCalls = mockImageFetch();
  try {
    const result = await executeWorkflowImageNode(user, {
      runId: run.id,
      imageKeyId: "image-key",
      imageModelId: "test-image",
    }, config);

    assert.equal(fetchCalls.length, 1);
    assert.equal(result.doneCount, 1);
    assert.equal(result.missingCount, 0);

    const requestBody = JSON.parse(fetchCalls[0].options.body);
    const promptText = requestBody.prompt;
    assert.match(promptText, /酒店门外/);
    assert.match(promptText, /场景图约束/);
    assert.match(promptText, /不要出现产品特写/);
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("role image style is appended only for role generation requests", async () => {
  const { config, user, run, cleanup } = await createWorkflowImageFixture({
    shots: [
      {
        id: "role-shot",
        index: 1,
        assetType: "role",
        title: "酒店经理",
        prompt: "中国男性，中年，偏瘦体形，黑色短发，穿深灰色西装",
        imageStatus: "pending",
        imageUrl: "",
      },
    ],
  });
  const fetchCalls = mockImageFetch();
  try {
    await executeWorkflowImageNode(user, {
      runId: run.id,
      shotIds: ["role-shot"],
      imageKeyId: "image-key",
      imageModelId: "test-image",
      roleImageStyleId: "sketch-three",
    }, config);

    const requestBody = JSON.parse(fetchCalls[0].options.body);
    const promptText = requestBody.prompt;
    assert.match(promptText, /中国男性，中年，偏瘦体形/);
    assert.match(promptText, /角色图片风格（仅用于本次生成）/);
    assert.match(promptText, /左侧人物脸部大特写肖像/);
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("a timed out Synthetic Image image fails without locking the workflow", async () => {
  const { config, user, run, cleanup } = await createWorkflowImageFixture({
    shots: [
      {
        id: "timeout-scene-shot",
        index: 1,
        assetType: "scene",
        title: "超时场景",
        prompt: "夜晚街道",
        imageStatus: "pending",
        imageUrl: "",
      },
    ],
  });
  config.modelProxy = { adapterTimeoutMs: 10 };
  const fetchCalls = mockHangingImageFetch();
  try {
    const result = await executeWorkflowImageNode(user, {
      runId: run.id,
      imageKeyId: "image-key",
      imageModelId: "test-image",
    }, config);

    assert.equal(fetchCalls.length, 1);
    assert.equal(result.missingCount, 1);
    const updatedRun = await getWorkflowRun(user.id, run.id, config);
    assert.equal(updatedRun.status, "waiting");
    assert.equal(updatedRun.stages.image, "error");
    assert.equal(updatedRun.result.shots[0].imageStatus, "error");
    assert.match(updatedRun.result.shots[0].imageError, /仍在上游处理中|超时/);
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("an Synthetic Image image network error is not automatically resubmitted", async () => {
  const { config, user, run, cleanup } = await createWorkflowImageFixture({
    shots: [
      {
        id: "retry-scene-shot",
        index: 1,
        assetType: "scene",
        title: "重试场景",
        prompt: "清晨车站",
        imageStatus: "pending",
        imageUrl: "",
      },
    ],
  });
  config.modelProxy = { adapterTimeoutMs: 1000 };
  const fetchCalls = mockTransientImageFetch();
  try {
    const result = await executeWorkflowImageNode(user, {
      runId: run.id,
      imageKeyId: "image-key",
      imageModelId: "test-image",
    }, config);

    assert.equal(fetchCalls.length, 1);
    assert.equal(result.missingCount, 1);
    const updatedRun = await getWorkflowRun(user.id, run.id, config);
    assert.equal(updatedRun.result.shots[0].imageStatus, "error");
    assert.equal(updatedRun.status, "waiting");
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("Configured image model keeps saved images and atomically commits 30 concurrent results with three workers", async () => {
  const shots = Array.from({ length: 200 }, (_, index) => ({
    id: `batch-shot-${index + 1}`,
    index: index + 1,
    assetType: "scene",
    title: `批量场景 ${index + 1}`,
    prompt: `批量场景 ${index + 1}`,
    imageStatus: index < 170 ? "done" : "pending",
    imageUrl: index < 170 ? `https://cdn.example.com/saved-${index + 1}.png` : "",
  }));
  const { config, user, run, cleanup } = await createWorkflowImageFixture({
    shots,
    workflowConfig: { imageModelId: "test-image", imageConcurrency: 3 },
  });
  user.membership.concurrentJobs = 3;
  config.worker = { imageConcurrency: 3 };
  config.modelProxy = { gptImageConcurrency: 3, adapterTimeoutMs: 1000, imageMaxAttempts: 1 };
  const fetchCalls = mockConcurrentImageFetch();
  try {
    const result = await executeWorkflowImageNode(user, {
      runId: run.id,
      imageKeyId: "image-key",
      imageModelId: "test-image",
    }, config);

    assert.equal(fetchCalls.length, 30);
    assert.equal(fetchCalls.maxActive(), 3);
    assert.equal(result.totalCount, 200);
    assert.equal(result.doneCount, 200);
    assert.equal(result.missingCount, 0);
    const updatedRun = await getWorkflowRun(user.id, run.id, config);
    assert.equal(updatedRun.result.shots[0].imageUrl, "https://cdn.example.com/saved-1.png");
    assert.equal(updatedRun.result.shots[169].imageUrl, "https://cdn.example.com/saved-170.png");
    const generatedShots = updatedRun.result.shots.slice(170);
    assert.ok(generatedShots.every((shot) => shot.imageStatus === "done" && shot.imageUrl));
    assert.equal(new Set(generatedShots.map((shot) => shot.imageUrl)).size, 30);
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("Configured image model does not automatically resubmit an ambiguous network failure", async () => {
  const { config, user, run, cleanup } = await createWorkflowImageFixture({
    shots: [{
      id: "unknown-result-shot",
      index: 1,
      assetType: "scene",
      title: "结果未知场景",
      prompt: "夜晚街道",
      imageStatus: "pending",
      imageUrl: "",
    }],
    workflowConfig: { imageModelId: "test-image" },
  });
  config.modelProxy = { gptImageConcurrency: 2, adapterTimeoutMs: 1000, imageMaxAttempts: 2 };
  const fetchCalls = mockTransientImageFetch();
  try {
    const result = await executeWorkflowImageNode(user, {
      runId: run.id,
      imageKeyId: "image-key",
      imageModelId: "test-image",
    }, config);

    assert.equal(fetchCalls.length, 1);
    assert.equal(result.missingCount, 1);
    const updatedRun = await getWorkflowRun(user.id, run.id, config);
    assert.equal(updatedRun.result.shots[0].imageStatus, "error");
    assert.equal(updatedRun.result.shots[0].imageResultUnknown, true);
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("Configured image model returns the HTTP 429 upstream saturation reason to its shot", async () => {
  const { config, user, run, cleanup } = await createWorkflowImageFixture({
    shots: [{
      id: "rate-limited-shot",
      index: 1,
      assetType: "scene",
      title: "限流场景",
      prompt: "繁忙车站",
      imageStatus: "pending",
      imageUrl: "",
    }],
    workflowConfig: { imageModelId: "test-image" },
  });
  config.modelProxy = { gptImageConcurrency: 3, adapterTimeoutMs: 1000, imageMaxAttempts: 1 };
  const fetchCalls = mockRateLimitedImageFetch();
  try {
    const result = await executeWorkflowImageNode(user, {
      runId: run.id,
      imageKeyId: "image-key",
      imageModelId: "test-image",
    }, config);

    assert.equal(fetchCalls.length, 1);
    assert.equal(result.failedCount, 1);
    assert.equal(result.pausedCount, 0);
    const updatedRun = await getWorkflowRun(user.id, run.id, config);
    assert.equal(updatedRun.result.shots[0].imageStatus, "error");
    assert.match(updatedRun.result.shots[0].imageError, /^HTTP 429：/);
    assert.match(updatedRun.result.shots[0].imageError, /模型服务繁忙/);
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("same-job reconciliation cannot replace a real provider failure with a generic error", async () => {
  const { config, user, run, cleanup } = await createWorkflowImageFixture({
    shots: [{
      id: "reconciled-rate-limited-shot",
      index: 1,
      assetType: "scene",
      title: "竞态限流场景",
      prompt: "繁忙站台",
      imageStatus: "pending",
      imageUrl: "",
    }],
    workflowConfig: { imageModelId: "test-image" },
  });
  config.modelProxy = { gptImageConcurrency: 3, adapterTimeoutMs: 1000, imageMaxAttempts: 1 };
  const fetchCalls = [];
  fetchCalls.originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls.push({});
    const activeRun = await getWorkflowRun(user.id, run.id, config);
    const activeShot = activeRun.result.shots[0];
    const reconciled = await patchWorkflowRunImageShot(user.id, run.id, {
      shotId: activeShot.id,
      expectedJobId: "image-job-reconciled",
      expectedRequestId: activeShot.imageRequestId,
      expectedStatuses: ["running"],
      requireMissingImage: true,
      patch: {
        imageStatus: "error",
        imageError: "图片生成任务已经结束，但该镜头没有正确收口。",
      },
    }, config);
    assert.equal(reconciled.updated, true);
    return rateLimitedImageResponse();
  };
  try {
    await executeWorkflowImageNode(user, {
      runId: run.id,
      jobId: "image-job-reconciled",
      imageKeyId: "image-key",
      imageModelId: "test-image",
    }, config);

    const updatedRun = await getWorkflowRun(user.id, run.id, config);
    assert.equal(updatedRun.result.shots[0].imageStatus, "error");
    assert.match(updatedRun.result.shots[0].imageError, /^HTTP 429：/);
    assert.doesNotMatch(updatedRun.result.shots[0].imageError, /没有正确收口/);
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("same-job reconciliation still attaches a successful provider result", async () => {
  const { config, user, run, cleanup } = await createWorkflowImageFixture({
    shots: [{
      id: "reconciled-success-shot",
      index: 1,
      assetType: "scene",
      title: "竞态成功场景",
      prompt: "清晨站台",
      imageStatus: "pending",
      imageUrl: "",
    }],
    workflowConfig: { imageModelId: "test-image" },
  });
  config.modelProxy = { gptImageConcurrency: 3, adapterTimeoutMs: 1000, imageMaxAttempts: 1 };
  const fetchCalls = [];
  fetchCalls.originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls.push({});
    const activeRun = await getWorkflowRun(user.id, run.id, config);
    const activeShot = activeRun.result.shots[0];
    const reconciled = await patchWorkflowRunImageShot(user.id, run.id, {
      shotId: activeShot.id,
      expectedJobId: "image-job-success-reconciled",
      expectedRequestId: activeShot.imageRequestId,
      expectedStatuses: ["running"],
      requireMissingImage: true,
      patch: {
        imageStatus: "error",
        imageError: "图片生成任务已经结束，但该镜头没有正确收口。",
      },
    }, config);
    assert.equal(reconciled.updated, true);
    return generatedImageResponse("https://cdn.example.com/reconciled-success.png");
  };
  try {
    await executeWorkflowImageNode(user, {
      runId: run.id,
      jobId: "image-job-success-reconciled",
      imageKeyId: "image-key",
      imageModelId: "test-image",
    }, config);

    const updatedRun = await getWorkflowRun(user.id, run.id, config);
    assert.equal(updatedRun.result.shots[0].imageStatus, "done");
    assert.equal(updatedRun.result.shots[0].imageError, "");
    assert.equal(updatedRun.result.shots[0].imageUrl, "https://cdn.example.com/reconciled-success.png");
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("nine consecutive channel failures stop remaining image requests", async () => {
  const shots = Array.from({ length: 12 }, (_, index) => ({
    id: `failed-scene-${index + 1}`,
    index: index + 1,
    assetType: "scene",
    title: `失败场景 ${index + 1}`,
    prompt: `场景 ${index + 1}`,
    imageStatus: "pending",
    imageUrl: "",
  }));
  const { config, user, run, cleanup } = await createWorkflowImageFixture({ shots });
  config.modelProxy = { bananaImageTimeoutMs: 1000, imageMaxAttempts: 1 };
  const fetchCalls = mockFailedImageFetch();
  try {
    const result = await executeWorkflowImageNode(user, {
      runId: run.id,
      imageKeyId: "image-key",
      imageModelId: "test-image",
    }, config);

    assert.ok(fetchCalls.length >= 9);
    assert.ok(fetchCalls.length < shots.length);
    assert.equal(result.missingCount, shots.length);
    const updatedRun = await getWorkflowRun(user.id, run.id, config);
    assert.equal(updatedRun.status, "waiting");
    assert.equal(updatedRun.stages.image, "error");
    const failedShots = updatedRun.result.shots.filter((shot) => shot.imageStatus === "error");
    const pausedShots = updatedRun.result.shots.filter((shot) => shot.imageStatus === "paused");
    assert.equal(failedShots.length, fetchCalls.length);
    assert.equal(pausedShots.length, shots.length - fetchCalls.length);
    assert.ok(failedShots.every((shot) => /HTTP 503/.test(shot.imageError)));
    assert.ok(pausedShots.every((shot) => !shot.imageError && /等待已暂停/.test(shot.imagePauseReason)));
    assert.equal(result.failedCount, failedShots.length);
    assert.equal(result.pausedCount, pausedShots.length);
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("eight consecutive channel failures do not stop the image batch", async () => {
  const shots = Array.from({ length: 8 }, (_, index) => ({
    id: `failure-below-threshold-${index + 1}`,
    index: index + 1,
    assetType: "scene",
    title: `阈值内失败场景 ${index + 1}`,
    prompt: `场景 ${index + 1}`,
    imageStatus: "pending",
    imageUrl: "",
  }));
  const { config, user, run, cleanup } = await createWorkflowImageFixture({ shots });
  config.modelProxy = { bananaImageTimeoutMs: 1000, imageMaxAttempts: 1 };
  const fetchCalls = mockFailedImageFetch();
  try {
    const result = await executeWorkflowImageNode(user, {
      runId: run.id,
      imageKeyId: "image-key",
      imageModelId: "test-image",
    }, config);

    assert.equal(fetchCalls.length, shots.length);
    assert.equal(result.failedCount, shots.length);
    assert.equal(result.pausedCount, 0);
    const updatedRun = await getWorkflowRun(user.id, run.id, config);
    assert.ok(updatedRun.result.shots.every((shot) => shot.imageStatus === "error"));
    assert.ok(updatedRun.result.shots.every((shot) => !shot.imagePauseReason));
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("content safety rejections fail only their shots without stopping the batch", async () => {
  const shots = Array.from({ length: 6 }, (_, index) => ({
    id: `safety-rejected-scene-${index + 1}`,
    index: index + 1,
    assetType: "scene",
    title: `安全审核场景 ${index + 1}`,
    prompt: `包含真实历史人物的场景 ${index + 1}`,
    imageStatus: "pending",
    imageUrl: "",
  }));
  const { config, user, run, cleanup } = await createWorkflowImageFixture({
    shots,
    workflowConfig: { imageModelId: "test-image", imageConcurrency: 3 },
  });
  config.worker = { imageConcurrency: 3 };
  config.modelProxy = { gptImageConcurrency: 3, adapterTimeoutMs: 1000, imageMaxAttempts: 2 };
  const fetchCalls = mockSafetyRejectedImageFetch();
  try {
    const result = await executeWorkflowImageNode(user, {
      runId: run.id,
      imageKeyId: "image-key",
      imageModelId: "test-image",
    }, config);

    assert.equal(fetchCalls.length, shots.length);
    assert.equal(result.missingCount, shots.length);
    const updatedRun = await getWorkflowRun(user.id, run.id, config);
    assert.ok(updatedRun.result.shots.every((shot) => shot.imageStatus === "error"));
    assert.ok(updatedRun.result.shots.every((shot) => /内容审核未通过/.test(shot.imageError)));
    assert.ok(updatedRun.result.shots.every((shot) => !/连续失败/.test(shot.imageError)));
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

async function createWorkflowImageFixture({ shots, workflowConfig = {}, imageChannel = "Synthetic Image", imageEndpoint = "https://image.example.com" }) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "flowstudio-workflow-image-"));
  const config = {
    env: "test",
    dataDir,
    apiKeyEncryptionKey: Buffer.from("flowstudio-local-dev-key-0000010").toString("base64"),
    store: {
      driver: "json",
    },
    storage: {
      provider: "local",
    },
  };
  const user = ensureUser(config, {
    id: "dev-user",
    email: "dev@flowstudio.local",
    displayName: "Test User",
  });
  await saveApiKey(user, {
    id: "image-key",
    serviceType: "image",
    channel: imageChannel,
    apiKey: "test-image-key",
    endpoint: imageEndpoint,
  }, config);
  const workflow = await createWorkflow(user, {
    id: "workflow-image",
    name: "带货视频测试",
    type: "ecommerce",
    config: {
      type: "ecommerce",
      imageKeyId: "image-key",
      imageModelId: "test-image",
      ...workflowConfig,
    },
  }, config);
  const run = await createWorkflowRun(user.id, workflow.id, {
    id: "run-image",
    kind: "topic-child",
    topic: "测试选题",
    status: "waiting",
    stages: {
      topic: "skipped",
      outline: "skipped",
      script: "done",
      optimize: "skipped",
      shot: "done",
      image: "pending",
      audio: "pending",
      videoPrompt: "pending",
      video: "pending",
      draft: "pending",
    },
    result: {
      scriptOutput: "这是一段带货文案。",
      shots,
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

function mockImageFetch() {
  const calls = [];
  calls.originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({
      data: [
        {
          url: "https://cdn.example.com/generated-scene.png",
        },
      ],
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  };
  return calls;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockHangingImageFetch() {
  const calls = [];
  calls.originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options = {}) => {
    calls.push({ url: String(url), options });
    return new Promise((_, reject) => {
      options.signal?.addEventListener?.("abort", () => reject(options.signal.reason || new Error("aborted")), { once: true });
    });
  };
  return calls;
}

function mockTransientImageFetch() {
  const calls = [];
  calls.originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1) throw new TypeError("temporary network failure");
    return generatedImageResponse();
  };
  return calls;
}

function mockFailedImageFetch() {
  const calls = [];
  calls.originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ error: { message: "upstream unavailable" } }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  };
  return calls;
}

function mockSafetyRejectedImageFetch() {
  const calls = [];
  calls.originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({
      error: { message: "Your request was rejected by the safety system." },
    }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  };
  return calls;
}

function mockRateLimitedImageFetch() {
  const calls = [];
  calls.originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return rateLimitedImageResponse();
  };
  return calls;
}

function rateLimitedImageResponse() {
  return new Response(JSON.stringify({
    error: { message: "模型服务繁忙，请稍后再试" },
  }), {
    status: 429,
    headers: { "Content-Type": "application/json" },
  });
}

function mockConcurrentImageFetch() {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  calls.originalFetch = globalThis.fetch;
  calls.maxActive = () => maxActive;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const callNumber = calls.length;
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, (callNumber % 3) * 2));
    active -= 1;
    return generatedImageResponse(`https://cdn.example.com/generated-${callNumber}.png`);
  };
  return calls;
}

function generatedImageResponse(imageUrl = "https://cdn.example.com/generated-scene.png") {
  return new Response(JSON.stringify({
    data: [{ url: imageUrl }],
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function restoreFetch(calls) {
  globalThis.fetch = calls.originalFetch;
}
