import { httpError } from "../http.js";
import { listAssets } from "./asset-store.js";
import { updateJobIfStatus } from "./job-store.js";
import { proxyImageGeneration } from "./model-proxy.js";
import { saveGeneratedImageObject } from "../storage/object-storage.js";
import { getWorkflowRun, listWorkflows, patchWorkflowRunImageShot, updateWorkflowRun, workflowConfigForRunSnapshot } from "./workflow-store.js";
import { assertWorkflowResourcesAccessible } from "./workflow-resource-guard.js";
import { randomUUID } from "node:crypto";
import { workflowRoleImageStylePrompt } from "../lib/workflow-role-image-style.mjs";

const missingProductImageError = "图片阶段异常：商品资产缺少商品图，请上传后重试。";
const pausedImageRequestMessage = "等待已暂停：图片渠道连续失败，本镜头尚未发起请求，未产生费用。";
const consecutiveImageFailureThreshold = 9;

export async function executeWorkflowImageNode(user, input, config) {
  const runId = normalizeId(input.runId);
  if (!runId) throw httpError(400, "缺少工作流任务 ID。");

  const context = await loadWorkflowContext(user.id, runId, config);
  const jobId = normalizeId(input.jobId);
  if (jobId && !await imageGenerationShouldContinue(input)) {
    return summarizeImageRun(context.run, context.store).publicResult;
  }

  try {
    const result = await generateMissingShotImages(user, context, config, input);
    if (jobId) {
      await updateJobIfStatus(jobId, ["running"], {
        status: result.missingCount ? "error" : "done",
        progress: result.missingCount ? Math.round((result.doneCount / Math.max(result.totalCount, 1)) * 100) : 100,
        result: {
          total: result.totalCount,
          done: result.doneCount,
          missing: result.missingCount,
          failed: result.failedCount,
          paused: result.pausedCount,
          unknown: result.unknownCount,
        },
        error: result.missingCount ? result.errorSummary || "部分分镜图片生成失败。" : "",
      }, config);
    }
    return result.publicResult;
  } catch (error) {
    if (jobId) {
      await updateJobIfStatus(jobId, ["running"], {
        status: "error",
        error: error.message || "图片节点执行失败。",
      }, config);
    }
    throw error;
  }
}

async function generateMissingShotImages(user, context, config, input = {}) {
  const { workflow, run, store } = context;
  const jobId = normalizeId(input.jobId);
  const workflowForPrompt = workflowWithConfig(workflow, {
    imageKeyId: normalizeId(input.imageKeyId || input.apiKeyId),
    imageModelId: normalizeId(input.imageModelId || input.modelId),
    visualStyleId: normalizeId(input.visualStyleId),
    visualStyleName: normalizeId(input.visualStyleName),
    visualStylePrompt: normalizeId(input.visualStylePrompt),
    promptMode: normalizeId(input.promptMode),
    imageResolution: normalizeId(input.imageResolution),
    ratio: normalizeId(input.ratio),
    imageSize: normalizeId(input.imageSize),
    customSize: normalizeId(input.customSize),
    roleImageStyleId: normalizeId(input.roleImageStyleId),
    roleImageCustomStylePrompt: normalizeId(input.roleImageCustomStylePrompt),
  });
  const wf = workflowForPrompt.config || {};
  const imagePromptOverrides = input.imagePromptOverrides && typeof input.imagePromptOverrides === "object" ? input.imagePromptOverrides : {};
  const imageKeyId = normalizeId(input.imageKeyId || input.apiKeyId || wf.imageKeyId);
  const imageModelId = resolveImageModelId(input.imageModelId || input.modelId || wf.imageModelId);
  if (!imageKeyId) throw httpError(400, "请先在工作流配置中选择图片生成渠道。");
  let shots = currentShots(run);
  const requestedShotIds = new Set((Array.isArray(input.shotIds) ? input.shotIds : []).map(normalizeId).filter(Boolean));
  const forceRegenerate = Boolean(input.forceRegenerate || input.force || input.regenerate);
  const targetShots = requestedShotIds.size ? shots.filter((shot) => requestedShotIds.has(workflowShotId(shot))) : shots;
  if (requestedShotIds.size && !targetShots.length) throw httpError(404, "没有找到要生成的分镜图片。");
  if (forceRegenerate) {
    targetShots.forEach((shot) => {
      if (isEcommerceProductShot(shot)) return;
      patchShot(run, workflowShotId(shot), {
        imageUrl: "",
        imageThumbnailUrl: "",
        imageStatus: "pending",
        imageSource: "",
        imageError: "",
        imagePauseReason: "",
        imageJobId: "",
        imageSubmittedAt: "",
        imageResultUnknown: false,
        imageProviderTaskId: "",
        imageProviderChannel: "",
        imageProviderStatus: "",
        imageProviderLastSyncedAt: "",
      });
    });
    await saveWorkflowRun(user.id, run, config, store, { preserveExistingImages: false });
  }
  shots = currentShots(run);
  markMissingProductImageErrors(run, requestedShotIds);
  let missingShots = filterTargetShots(shots, requestedShotIds).filter(shouldGenerateShotImage);
  if (!missingShots.length) {
    const result = summarizeImageRun(run, store);
    run.stages = {
      ...(run.stages || {}),
      image: result.missingCount ? "error" : "done",
    };
    run.status = "waiting";
    run.error = result.missingCount ? result.errorSummary || "图片阶段异常。" : "";
    run.updatedAt = new Date().toISOString();
    await saveWorkflowRun(user.id, run, config, store);
    return summarizeImageRun(run, store);
  }

  const configuredConcurrency = clampImageConcurrency(config.worker?.imageConcurrency || 3);
  const membershipConcurrency = user.membership?.imageConcurrency
    ? clampImageConcurrency(user.membership.imageConcurrency)
    : configuredConcurrency;
  const requestedConcurrency = Math.max(1, Math.min(
    configuredConcurrency,
    membershipConcurrency,
    clampImageConcurrency(wf.imageConcurrency || configuredConcurrency),
    missingShots.length,
  ));
  const concurrency = requestedConcurrency;
  run.status = "running";
  run.stages = {
    ...(run.stages || {}),
    image: "running",
  };
  const queuedAt = new Date().toISOString();
  missingShots.forEach((shot) => {
    const shotId = workflowShotId(shot);
    patchShot(run, workflowShotId(shot), {
      imageStatus: "queued",
      imageError: "",
      imagePauseReason: "",
      imageQueuedAt: queuedAt,
      imageStartedAt: "",
      imageCompletedAt: "",
      imageJobId: jobId,
      imageRequestId: `${Date.now()}-${shotId}-${randomUUID()}`,
      imageSubmittedAt: "",
      imageResultUnknown: false,
    });
  });
  await saveWorkflowRun(user.id, run, config, store, { preserveExistingImages: false });
  shots = currentShots(run);
  missingShots = filterTargetShots(shots, requestedShotIds).filter(shouldGenerateShotImage);
  let consecutiveFailureCategory = "";
  let consecutiveFailureCount = 0;
  let circuitError = "";

  await runPool(missingShots.map((shot) => ({ ...shot })), concurrency, async (shot) => {
    if (!await imageGenerationShouldContinue(input)) return;
    const shotId = workflowShotId(shot);
    const generationNonce = normalizeId(shot.imageRequestId) || `${Date.now()}-${shotId}-${randomUUID()}`;
    const started = await commitWorkflowImageShot(user.id, run.id, shotId, {
      expectedJobId: jobId,
      expectedRequestId: generationNonce,
      expectedStatuses: ["queued"],
      requireMissingImage: true,
      patch: {
        imageStatus: "running",
        imageError: "",
        imagePauseReason: "",
        imageStartedAt: new Date().toISOString(),
        imageCompletedAt: "",
        imageJobId: jobId,
        imageRequestId: generationNonce,
        imageSubmittedAt: "",
        imageResultUnknown: false,
      },
    }, config);
    if (!started?.updated) {
      console.info("[workflow-image] shot skipped after ownership changed", {
        runId: run.id,
        shotId,
        jobId,
        requestId: generationNonce,
      });
      return;
    }
    const currentShot = {
      ...shot,
      ...(started.shot || {}),
    };
    let linkedProviderTaskId = normalizeId(currentShot.imageProviderTaskId);
    let linkedProviderChannel = normalizeId(currentShot.imageProviderChannel);
    const resumeProviderTaskId = linkedProviderTaskId && ["queued", "submitted", "processing", "running", "in_progress"].includes(normalizeId(currentShot.imageProviderStatus).toLowerCase())
      ? linkedProviderTaskId
      : "";
    let settledRun = null;
    try {
      const prompt = buildWorkflowShotImagePrompt(store, workflowForPrompt, currentShot, {
        forceRegenerate,
        generationNonce,
        imagePromptOverrides,
      });
      console.info("[workflow-image] prompt resolved", {
        runId: run.id,
        shotId,
        promptMode: wf.promptMode || "",
        visualStyleId: wf.visualStyleId || "",
        visualStyleName: wf.visualStyleName || "",
        ratio: wf.ratio || "",
        imageSize: wf.imageSize || "",
        hasVisualStylePrompt: Boolean(wf.visualStylePrompt),
        usedPromptOverride: Boolean(workflowImagePromptOverride(imagePromptOverrides, shotId)),
        promptHasStyleReference: prompt.includes("风格参考"),
        promptLength: prompt.length,
      });
      const submitted = await commitWorkflowImageShot(user.id, run.id, shotId, {
        expectedJobId: jobId,
        expectedRequestId: generationNonce,
        expectedStatuses: ["running"],
        requireMissingImage: true,
        patch: {
          imageSubmittedAt: new Date().toISOString(),
          imageResultUnknown: false,
        },
      }, config);
      if (!submitted?.updated) {
        console.info("[workflow-image] shot submission canceled after ownership changed", {
          runId: run.id,
          shotId,
          jobId,
          requestId: generationNonce,
        });
        return;
      }
      const result = await proxyImageGeneration({
        apiKeyId: imageKeyId,
        modelId: imageModelId,
        prompt,
        references: [],
        ratio: wf.ratio || wf.imageSize || "16:9",
        imageSize: wf.imageSize || wf.ratio || "",
        customSize: wf.customSize || "",
        resolution: wf.imageResolution || "1k",
        count: 1,
        taskType: "workflow-image",
        signal: input.signal,
        providerTaskId: resumeProviderTaskId,
        onTaskCreated: async ({ taskId, status, channel }) => {
          linkedProviderTaskId = normalizeId(taskId);
          linkedProviderChannel = normalizeId(channel) || "图片渠道";
          const linked = await commitWorkflowImageShot(user.id, run.id, shotId, {
            expectedJobId: jobId,
            expectedRequestId: generationNonce,
            expectedStatuses: ["running"],
            requireMissingImage: true,
            patch: {
              imageProviderTaskId: linkedProviderTaskId,
              imageProviderChannel: linkedProviderChannel,
              imageProviderStatus: normalizeId(status) || "queued",
              imageProviderLastSyncedAt: new Date().toISOString(),
              imageSubmittedAt: new Date().toISOString(),
              imageResultUnknown: false,
            },
          }, config);
          if (!linked?.updated) {
            throw httpError(409, "图片任务已在上游创建，但当前分镜执行权已变化。", {
              taskId: linkedProviderTaskId,
              providerChannel: linkedProviderChannel,
              submissionUnknown: true,
            });
          }
        },
      }, config, user);
      const rawImageUrl = Array.isArray(result.images) ? result.images[0] : "";
      const rawImageObject = Array.isArray(result.imageObjects) ? result.imageObjects[0] : null;
      const persistedImage = await persistGeneratedWorkflowImage(config, user, currentShot, rawImageUrl, rawImageObject);
      const imageUrl = persistedImage.url;
      if (!imageUrl) throw httpError(502, "接口已返回，但没有解析到图片数据。");
      const completed = await commitWorkflowImageShot(user.id, run.id, shotId, {
        expectedJobId: jobId,
        expectedRequestId: generationNonce,
        expectedStatuses: ["running"],
        requireMissingImage: true,
        patch: {
          imageUrl,
          imageThumbnailUrl: persistedImage.thumbnailUrl || "",
          imageStatus: "done",
          imageSource: "ai-generated",
          imageError: "",
          imagePauseReason: "",
          imageRegenerateNonce: "",
          imageRequestId: generationNonce,
          imageCompletedAt: new Date().toISOString(),
          imageResultUnknown: false,
          imageProviderTaskId: linkedProviderTaskId,
          imageProviderChannel: linkedProviderChannel,
          imageProviderStatus: linkedProviderTaskId ? "done" : "",
          imageProviderLastSyncedAt: linkedProviderTaskId ? new Date().toISOString() : "",
        },
      }, config);
      const recoveredCompletion = completed?.updated ? completed : await recoverWorkflowImageShotResult(user.id, run.id, shotId, {
        jobId,
        requestId: generationNonce,
        patch: {
          imageUrl,
          imageThumbnailUrl: persistedImage.thumbnailUrl || "",
          imageStatus: "done",
          imageSource: "ai-generated",
          imageError: "",
          imagePauseReason: "",
          imageRegenerateNonce: "",
          imageRequestId: generationNonce,
          imageCompletedAt: new Date().toISOString(),
          imageResultUnknown: false,
          imageProviderTaskId: linkedProviderTaskId,
          imageProviderChannel: linkedProviderChannel,
          imageProviderStatus: linkedProviderTaskId ? "done" : "",
          imageProviderLastSyncedAt: linkedProviderTaskId ? new Date().toISOString() : "",
        },
      }, config);
      if (!recoveredCompletion?.updated) {
        console.warn("[workflow-image] completed result preserved but not attached after ownership changed", {
          runId: run.id,
          shotId,
          jobId,
          requestId: generationNonce,
          imageUrl,
        });
        return;
      }
      if (!completed?.updated) {
        console.info("[workflow-image] completed result recovered after same-job reconciliation", {
          runId: run.id,
          shotId,
          jobId,
          requestId: generationNonce,
        });
      }
      settledRun = recoveredCompletion.run;
      consecutiveFailureCategory = "";
      consecutiveFailureCount = 0;
      console.info("[workflow-image] shot saved", {
        runId: run.id,
        shotId,
        model: imageModelId,
        imageLength: imageUrl.length,
        hasThumbnail: Boolean(persistedImage.thumbnailUrl),
      });
    } catch (error) {
      const failureCategory = workflowImageFailureCategory(error);
      const resultUnknown = workflowImageResultIsUnknown(error);
      linkedProviderTaskId = normalizeId(error?.detail?.taskId) || linkedProviderTaskId;
      linkedProviderChannel = normalizeId(error?.detail?.providerChannel) || linkedProviderChannel;
      const providerFailureMessage = workflowImageFailureMessage(error);
      const failureMessage = resultUnknown
        ? linkedProviderTaskId
          ? `${linkedProviderChannel || "图片渠道"}任务仍在上游处理中，已保存任务编号 ${linkedProviderTaskId}，请稍后继续查询，暂勿重复提交。`
          : `图片请求结果未知，${linkedProviderChannel || "图片渠道"}可能已经接收并计费：${providerFailureMessage}`
        : providerFailureMessage;
      const recoverableProviderTask = resultUnknown && Boolean(linkedProviderTaskId);
      let failed = await commitWorkflowImageShot(user.id, run.id, shotId, {
        expectedJobId: jobId,
        expectedRequestId: generationNonce,
        expectedStatuses: ["running"],
        requireMissingImage: true,
        patch: {
          imageStatus: recoverableProviderTask ? "paused" : "error",
          imageError: recoverableProviderTask ? "" : failureMessage,
          imagePauseReason: recoverableProviderTask ? failureMessage : "",
          imageRequestId: generationNonce,
          imageCompletedAt: new Date().toISOString(),
          imageResultUnknown: resultUnknown,
          imageProviderTaskId: linkedProviderTaskId,
          imageProviderChannel: linkedProviderChannel,
          imageProviderStatus: linkedProviderTaskId ? (recoverableProviderTask ? "processing" : "failed") : "",
          imageProviderLastSyncedAt: linkedProviderTaskId ? new Date().toISOString() : "",
        },
      }, config);
      if (!failed?.updated) {
        failed = await recoverWorkflowImageShotResult(user.id, run.id, shotId, {
          jobId,
          requestId: generationNonce,
          patch: {
            imageStatus: recoverableProviderTask ? "paused" : "error",
            imageError: recoverableProviderTask ? "" : failureMessage,
            imagePauseReason: recoverableProviderTask ? failureMessage : "",
            imageRequestId: generationNonce,
            imageCompletedAt: new Date().toISOString(),
            imageResultUnknown: resultUnknown,
            imageProviderTaskId: linkedProviderTaskId,
            imageProviderChannel: linkedProviderChannel,
            imageProviderStatus: linkedProviderTaskId ? (recoverableProviderTask ? "processing" : "failed") : "",
            imageProviderLastSyncedAt: linkedProviderTaskId ? new Date().toISOString() : "",
          },
        }, config);
      }
      if (!failed?.updated) {
        console.warn("[workflow-image] shot failure ignored after ownership changed", {
          runId: run.id,
          shotId,
          jobId,
          requestId: generationNonce,
          error: failureMessage,
        });
        return;
      }
      if (failed.recovered) {
        console.info("[workflow-image] shot failure recovered after same-job reconciliation", {
          runId: run.id,
          shotId,
          jobId,
          requestId: generationNonce,
          error: failureMessage,
        });
      }
      settledRun = failed.run;
      if (failureCategory === "content-safety") {
        consecutiveFailureCategory = "";
        consecutiveFailureCount = 0;
      } else {
        if (failureCategory === consecutiveFailureCategory) consecutiveFailureCount += 1;
        else {
          consecutiveFailureCategory = failureCategory;
          consecutiveFailureCount = 1;
        }
        if (consecutiveFailureCount >= consecutiveImageFailureThreshold) {
          circuitError = `图片渠道连续失败，已停止剩余图片生成：${failureMessage}`;
        }
      }
      console.warn("[workflow-image] shot failed", {
        runId: run.id,
        shotId,
        model: imageModelId,
        error: failed.shot?.imageError || failureMessage,
      });
    }
    if (jobId && settledRun) {
      const progress = summarizeImageRun(settledRun, store);
      const now = new Date().toISOString();
      await updateJobIfStatus(jobId, ["running"], {
        progress: Math.round((progress.doneCount / Math.max(progress.totalCount, 1)) * 100),
        result: {
          heartbeatAt: now,
          lastProgressAt: now,
        },
      }, config).catch((error) => {
        console.warn("[workflow-image] job progress update failed", {
          runId: run.id,
          jobId,
          error: error.message || String(error),
        });
      });
    }
  }, async () => !circuitError && await imageGenerationShouldContinue(input));

  if (!await imageGenerationShouldContinue(input)) {
    const latest = await getWorkflowRun(user.id, run.id, config).catch(() => run);
    return summarizeImageRun(latest, store);
  }

  if (circuitError) {
    const latest = await getWorkflowRun(user.id, run.id, config);
    const unfinishedShots = currentShots(latest).filter((shot) => (
      !shot.imageUrl
      && ["pending", "queued", "running"].includes(normalizeId(shot.imageStatus))
      && normalizeId(shot.imageJobId) === jobId
    ));
    for (const shot of unfinishedShots) {
      await commitWorkflowImageShot(user.id, run.id, workflowShotId(shot), {
        expectedJobId: jobId,
        expectedRequestId: normalizeId(shot.imageRequestId),
        expectedStatuses: ["pending", "queued", "running"],
        requireMissingImage: true,
        patch: {
          imageStatus: "paused",
          imageError: "",
          imagePauseReason: workflowImageCircuitPauseMessage(circuitError),
          imageCompletedAt: new Date().toISOString(),
        },
      }, config);
    }
  }

  const finalRun = await getWorkflowRun(user.id, run.id, config);
  const finalShots = currentShots(finalRun);
  markMissingProductImageErrors(finalRun);
  const missingCount = finalShots.filter(shouldHaveMissingImageForStage).length;
  const errorSummary = workflowImageErrorSummary(finalShots);
  finalRun.stages = {
    ...(finalRun.stages || {}),
    image: missingCount ? "error" : "done",
  };
  finalRun.status = "waiting";
  finalRun.error = missingCount ? errorSummary || "图片阶段异常。" : "";
  finalRun.updatedAt = new Date().toISOString();
  const updatedRun = await updateWorkflowRun(user.id, finalRun.id, finalRun, config);
  syncWorkflowRunSnapshot(run, updatedRun, store);
  return summarizeImageRun(run, store);
}

function summarizeImageRun(run, store) {
  const shots = currentShots(run);
  const targetShots = shots.filter(shouldCountAsGeneratedImageTarget);
  const doneCount = targetShots.filter((shot) => shot.imageUrl).length;
  const missingCount = targetShots.filter(shouldHaveMissingImageForStage).length;
  const failedCount = targetShots.filter((shot) => !shot.imageUrl && normalizeId(shot.imageStatus) === "error").length;
  const pausedCount = targetShots.filter((shot) => !shot.imageUrl && normalizeId(shot.imageStatus) === "paused").length;
  const unknownCount = targetShots.filter((shot) => !shot.imageUrl && Boolean(shot.imageResultUnknown)).length;
  const errorSummary = workflowImageErrorSummary(shots);
  return {
    totalCount: targetShots.length,
    doneCount,
    missingCount,
    failedCount,
    pausedCount,
    unknownCount,
    errorSummary,
    publicResult: {
      run: withChildren(run, store),
      shots,
      totalCount: targetShots.length,
      doneCount,
      missingCount,
      failedCount,
      pausedCount,
      unknownCount,
      errorSummary,
    },
  };
}

function currentShots(run) {
  if (Array.isArray(run.result?.shots)) {
    run.shots = run.result.shots;
    return run.result.shots;
  }
  if (Array.isArray(run.shots)) {
    run.result = {
      ...(run.result || {}),
      shots: run.shots,
    };
    return run.result.shots;
  }
  run.result = {
    ...(run.result || {}),
    shots: [],
  };
  run.shots = run.result.shots;
  return run.result.shots;
}

async function persistGeneratedWorkflowImage(config, user, shot, imageUrl, imageObject = null) {
  const value = String(imageUrl || "");
  if (!value.startsWith("data:image/")) {
    return {
      url: value,
      thumbnailUrl: imageObject?.thumbnailUrl || imageObject?.thumbnail_url || "",
    };
  }
  const match = value.match(/^data:(image\/[^;,]+);base64,(.+)$/i);
  if (!match) return { url: value, thumbnailUrl: "" };
  const extension = imageExtensionFromMime(match[1]);
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length) return { url: value, thumbnailUrl: "" };
  try {
    const saved = await saveGeneratedImageObject(config, user.id, {
      buffer,
      filename: `workflow-shot-${String(shot.index || "image").padStart(2, "0")}.${extension}`,
      mimeType: match[1],
    });
    return {
      url: saved.url || value,
      thumbnailUrl: saved.thumbnailUrl || "",
    };
  } catch (error) {
    console.warn("[workflow-image] generated image storage failed, keeping inline image", {
      userId: user.id,
      shotId: shot.id,
      message: error.message || String(error),
    });
    return { url: value, thumbnailUrl: "" };
  }
}

function imageExtensionFromMime(mime = "") {
  const normalized = String(mime).split(";")[0].trim().toLowerCase();
  return {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
  }[normalized] || "png";
}

function filterTargetShots(shots, requestedShotIds) {
  return requestedShotIds.size ? shots.filter((shot) => requestedShotIds.has(workflowShotId(shot))) : shots;
}

function findShot(run, shotId) {
  const id = normalizeId(shotId);
  return currentShots(run).find((shot) => workflowShotId(shot) === id) || null;
}

function patchShot(run, shotId, patch) {
  const shot = findShot(run, shotId);
  if (!shot) return null;
  Object.assign(shot, patch);
  return shot;
}

async function runPool(items, concurrency, worker, shouldContinue = () => true) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length && await shouldContinue()) {
      const item = queue.shift();
      if (item) await worker(item);
    }
  });
  await Promise.all(workers);
}

async function imageGenerationShouldContinue(input = {}) {
  if (typeof input.shouldContinue !== "function") return true;
  return Boolean(await input.shouldContinue());
}

function clampImageConcurrency(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return 1;
  return Math.max(1, Math.min(3, Math.floor(number)));
}

function workflowImageFailureCategory(error) {
  const status = Number(error?.status || 0);
  const message = normalizeId(error?.message).toLowerCase();
  if (/safety\s*(?:system|policy|filter|check)|(?:rejected|blocked).{0,40}safety|content\s*(?:policy|moderation)|policy\s*violation|安全(?:审核|系统|策略|检查)|内容(?:审核|政策)|违规内容/.test(message)) {
    return "content-safety";
  }
  if (status === 401 || status === 403 || /api\s*key|密钥|权限/.test(message)) return "auth";
  if (status === 402 || /余额|额度|quota|insufficient/.test(message)) return "quota";
  if (status === 429 || /限流|rate\s*limit|too\s*many/.test(message)) return "rate-limit";
  if (status === 504 || /超时|timeout|timed out/.test(message)) return "timeout";
  if (status >= 500 || status === 502 || /连接失败|network|fetch/.test(message)) return "network";
  if (status === 400 || /参数|提示词|违规|model/.test(message)) return `request:${status || "invalid"}`;
  return `other:${status || message.slice(0, 80)}`;
}

function workflowImageResultIsUnknown(error) {
  return Number(error?.status || 0) === 504 || Boolean(error?.detail?.network);
}

function workflowImageFailureMessage(error) {
  const status = Number(error?.status || 0);
  const message = normalizeId(error?.message) || "图片生成失败";
  if (status >= 400 && !new RegExp(`(?:HTTP\\s*)?${status}(?:\\b|：|:)`, "i").test(message)) {
    return `HTTP ${status}：${message}`;
  }
  return message;
}

function workflowImageCircuitPauseMessage(circuitError = "") {
  const recentFailure = normalizeId(circuitError).replace(/^图片渠道连续失败，已停止剩余图片生成：/, "");
  return recentFailure ? `${pausedImageRequestMessage}最近失败原因：${recentFailure}` : pausedImageRequestMessage;
}

function workflowImageErrorSummary(shots = []) {
  const missingShots = shots.filter(shouldHaveMissingImageForStage);
  return missingShots.find((shot) => normalizeId(shot.imageStatus) === "error" && normalizeId(shot.imageError))?.imageError
    || missingShots.find((shot) => normalizeId(shot.imagePauseReason))?.imagePauseReason
    || missingShots.find((shot) => normalizeId(shot.imageError))?.imageError
    || "";
}

function buildWorkflowShotImagePrompt(store, workflow, shot, options = {}) {
  const wf = workflow.config || {};
  const shotId = normalizeId(shot.id || shot.shotId || shot.uuid);
  const assetType = normalizeId(shot.assetType);
  const overridePrompt = workflowImagePromptOverride(options.imagePromptOverrides, shotId);
  if (overridePrompt) {
    const guardedOverride = assetType === "scene" && isEcommerceWorkflow(workflow)
      ? appendEcommerceSceneImageGuard(overridePrompt)
      : overridePrompt;
    const roleStylePrompt = assetType === "role"
      ? workflowRoleImageStylePrompt(wf.roleImageStyleId, wf.roleImageCustomStylePrompt)
      : "";
    return appendWorkflowImagePromptMeta(
      [guardedOverride, roleStylePrompt ? `角色图片风格（仅用于本次生成）：${roleStylePrompt}` : ""].filter(Boolean).join("\n\n"),
      wf,
      shot,
      { ...options, createCompatible: true },
    );
  }
  const visualStyleId = normalizeId(wf.visualStyleId);
  const style = store.assets.find((item) =>
    item.type === "visual-style"
    && (normalizeId(item.id) === visualStyleId || normalizeId(item.name) === visualStyleId)
  );
  const styleName = String(wf.visualStyleName || style?.name || visualStyleId || "").trim();
  const stylePrompt = String(wf.visualStylePrompt || style?.payload?.prompt || style?.payload?.content || style?.payload?.text || style?.payload?.desc || style?.prompt || style?.desc || "").trim();
  const shotPrompt = String(shot.prompt || shot.imagePrompt || shot.description || shot.text || "").trim();
  if (assetType === "role" || assetType === "scene") {
    const basePrompt = assetType === "scene" && isEcommerceWorkflow(workflow)
      ? appendEcommerceSceneImageGuard(shotPrompt)
      : shotPrompt;
    const roleStylePrompt = assetType === "role"
      ? workflowRoleImageStylePrompt(wf.roleImageStyleId, wf.roleImageCustomStylePrompt)
      : "";
    return appendWorkflowImagePromptMeta(
      [basePrompt, roleStylePrompt ? `角色图片风格（仅用于本次生成）：${roleStylePrompt}` : ""].filter(Boolean).join("\n\n"),
      wf,
      shot,
      { ...options, createCompatible: true },
    );
  }
  if (wf.promptMode === "create-compatible") {
    return appendWorkflowImagePromptMeta(
      [shotPrompt, stylePrompt ? `风格参考：${stylePrompt}` : ""].filter(Boolean).join("\n\n"),
      wf,
      shot,
      { ...options, createCompatible: true },
    );
  }
  return appendWorkflowImagePromptMeta([
    stylePrompt
      ? `图风预设（最高优先级）：${styleName || "工作流图风"}\n${stylePrompt}\n必须严格按以上图风生成，保持该视觉风格，不要被镜头描述中的写实、摄影、电影感等词汇覆盖。`
      : "",
    shotPrompt ? `镜头画面提示词：\n${shotPrompt}` : "",
  ].filter(Boolean).join("\n"), wf, shot, options);
}

function appendWorkflowImagePromptMeta(basePrompt, wf, shot, options = {}) {
  if (options.createCompatible) {
    return [
      basePrompt,
      options.forceRegenerate || shot.imageRegenerateNonce
        ? "重新生成要求：在不改变镜头含义的前提下，使用新的构图、光影和细节，不要复用之前生成过的图片。"
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    basePrompt,
    options.forceRegenerate || shot.imageRegenerateNonce
      ? "重新生成要求：在不改变镜头含义的前提下，使用新的构图、光影和细节，不要复用之前生成过的图片。"
      : "",
    options.generationNonce ? `生成请求标记：${options.generationNonce}` : "",
    wf.imageResolution ? `图片分辨率：${wf.imageResolution}` : "",
    wf.ratio ? `图片比例：${wf.ratio}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function workflowImagePromptOverride(overrides, shotId) {
  if (!overrides || typeof overrides !== "object") return "";
  return String(overrides[shotId] || "").trim();
}

const ecommerceSceneImageGuard = "场景图约束：只生成剧情环境，不生成任何商品或广告画面；不要出现产品特写、包装盒、瓶罐、Logo、商标、品牌名、广告摆拍、货架商品陈列、商品展示台或手持展示商品。产品素材只使用工作流里的产品图，不要在场景图中自行创造产品。";

function appendEcommerceSceneImageGuard(prompt = "") {
  const text = String(prompt || "").trim();
  if (!text) return ecommerceSceneImageGuard;
  return text.includes("场景图约束") ? text : `${text}\n${ecommerceSceneImageGuard}`;
}

function isEcommerceWorkflow(workflow = {}) {
  const wf = workflow.config && typeof workflow.config === "object" ? workflow.config : {};
  return normalizeId(workflow.type || workflow.workflowType || wf.type || wf.workflowType) === "ecommerce";
}

function resolveImageModelId(value = "") {
  return String(value || "").trim();
}

function workflowWithConfig(workflow, overrides = {}) {
  const config = workflow.config && typeof workflow.config === "object" ? workflow.config : {};
  const cleanOverrides = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined && value !== null && String(value).trim())
  );
  return {
    ...workflow,
    config: {
      ...config,
      ...cleanOverrides,
    },
  };
}

async function loadWorkflowContext(userId, runId, config) {
  const run = await getWorkflowRun(userId, runId, config);
  const workflows = await listWorkflows(userId, config);
  const workflow = workflows.find((item) => item.id === run.workflowId && item.userId === userId);
  if (!workflow) throw httpError(404, "工作流不存在。");
  const workflowForRun = workflowConfigForRunSnapshot(workflow, run);
  await assertWorkflowResourcesAccessible(userId, workflowForRun.config || {}, config, ["visual-style"]);
  const visualStyles = await listAssets(userId, "visual-style", config);
  const workflowRuns = workflow.runs.flatMap((item) => [item, ...(item.children || [])]);
  const store = {
    assets: visualStyles.assets || [],
    workflowRuns,
  };
  return { store, workflow: workflowForRun, run };
}

async function saveWorkflowRun(userId, run, config, store, options = {}) {
  currentShots(run);
  const latest = await getWorkflowRun(userId, run.id, config).catch(() => null);
  const mergedRun = latest && options.preserveExistingImages !== false ? mergeImageRunSnapshot(latest, run) : run;
  const updated = await updateWorkflowRun(userId, run.id, mergedRun, config);
  syncWorkflowRunSnapshot(run, updated, store);
  return updated;
}

async function commitWorkflowImageShot(userId, runId, shotId, input, config) {
  return patchWorkflowRunImageShot(userId, runId, {
    ...(input || {}),
    shotId,
  }, config);
}

async function recoverWorkflowImageShotResult(userId, runId, shotId, input = {}, config) {
  const jobId = normalizeId(input.jobId);
  const requestId = normalizeId(input.requestId);
  if (!jobId || !requestId) return null;
  const latest = await getWorkflowRun(userId, runId, config).catch(() => null);
  const shot = latest ? findShot(latest, shotId) : null;
  if (!shot || shot.imageUrl) return { run: latest, shot, updated: false };
  if (normalizeId(shot.imageJobId) !== jobId) return { run: latest, shot, updated: false };
  const latestRequestId = normalizeId(shot.imageRequestId);
  if (latestRequestId && latestRequestId !== requestId) return { run: latest, shot, updated: false };
  const status = normalizeId(shot.imageStatus);
  if (!["error", "paused"].includes(status)) return { run: latest, shot, updated: false };
  const recovered = await commitWorkflowImageShot(userId, runId, shotId, {
    expectedJobId: jobId,
    expectedStatuses: [status],
    requireMissingImage: true,
    patch: input.patch || {},
  }, config);
  return recovered?.updated ? { ...recovered, recovered: true } : recovered;
}

function syncWorkflowRunSnapshot(run, updated, store) {
  if (!updated) return run;
  currentShots(updated);
  Object.assign(run, updated);
  const index = store.workflowRuns.findIndex((item) => item.id === updated.id);
  if (index >= 0) store.workflowRuns[index] = updated;
  return run;
}

function mergeImageRunSnapshot(latest, incoming) {
  const latestShots = currentShots(latest);
  const incomingShots = currentShots(incoming);
  if (!latestShots.length || !incomingShots.length) return incoming;

  const incomingById = new Map(incomingShots.map((shot) => [workflowShotId(shot), shot]));
  const mergedShots = latestShots.map((latestShot) => {
    const incomingShot = incomingById.get(workflowShotId(latestShot));
    if (!incomingShot) return latestShot;
    if (
      ["error", "paused"].includes(normalizeId(latestShot.imageStatus)) &&
      normalizeId(latestShot.imageRequestId) !== normalizeId(incomingShot.imageRequestId)
    ) {
      return latestShot;
    }
    if (
      normalizeId(latestShot.imageRequestId) &&
      normalizeId(incomingShot.imageRequestId) &&
      normalizeId(latestShot.imageRequestId) !== normalizeId(incomingShot.imageRequestId)
    ) {
      return latestShot;
    }
    if (latestShot.imageUrl && !incomingShot.imageUrl) {
      return {
        ...incomingShot,
        imageUrl: latestShot.imageUrl,
        imageThumbnailUrl: latestShot.imageThumbnailUrl || incomingShot.imageThumbnailUrl || "",
        imageStatus: "done",
        imageError: "",
        imagePauseReason: "",
        imageRegenerateNonce: incomingShot.imageRegenerateNonce || latestShot.imageRegenerateNonce || "",
      };
    }
    return {
      ...latestShot,
      ...incomingShot,
    };
  });

  const latestIds = new Set(latestShots.map(workflowShotId));
  incomingShots.forEach((incomingShot) => {
    if (!latestIds.has(workflowShotId(incomingShot))) mergedShots.push(incomingShot);
  });

  const result = incoming.result && typeof incoming.result === "object" ? incoming.result : {};
  const latestResult = latest.result && typeof latest.result === "object" ? latest.result : {};
  const latestImageJob = latestResult.backendJobs?.image && typeof latestResult.backendJobs.image === "object"
    ? latestResult.backendJobs.image
    : null;
  const incomingImageJobId = normalizeId(
    result.backendJobs?.image?.id
    || incomingShots.find((shot) => normalizeId(shot.imageJobId))?.imageJobId,
  );
  const latestImageJobId = normalizeId(latestImageJob?.id);
  const preserveLatestImageExecutionState = Boolean(
    latestImageJobId
    && (
      (incomingImageJobId && incomingImageJobId !== latestImageJobId)
      || ["done", "error", "canceled"].includes(normalizeId(latestImageJob?.status))
    )
  );
  const merged = {
    ...latest,
    ...incoming,
    ...(preserveLatestImageExecutionState ? {
      status: latest.status,
      completedAt: latest.completedAt,
      error: latest.error,
    } : {}),
    stages: {
      ...(latest.stages || {}),
      ...(incoming.stages || {}),
      ...(preserveLatestImageExecutionState ? { image: latest.stages?.image || "error" } : {}),
    },
    result: {
      ...latestResult,
      ...result,
      backendJobs: latestResult.backendJobs || result.backendJobs || {},
      shots: mergedShots,
    },
    shots: mergedShots,
  };
  normalizeMergedImageStage(merged);
  return merged;
}

function normalizeMergedImageStage(run) {
  const shots = currentShots(run);
  if (!shots.length) return run;
  const missingCount = shots.filter(shouldHaveMissingImageForStage).length;
  if (!missingCount) {
    run.stages = {
      ...(run.stages || {}),
      image: "done",
    };
    if (run.status === "running" || run.status === "error") run.status = "waiting";
  }
  return run;
}

function withChildren(run, store) {
  return {
    ...run,
    children: store.workflowRuns
      .filter((item) => item.parentRunId === run.id && item.userId === run.userId && item.status !== "deleted")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
  };
}

function normalizeId(value) {
  return String(value || "").trim();
}

function workflowShotId(shot = {}) {
  return normalizeId(shot.id || shot.shotId || shot.uuid);
}

function shouldGenerateShotImage(shot = {}) {
  if (shot.imageUrl) return false;
  if (isEcommerceProductShot(shot)) return false;
  return shouldCountAsGeneratedImageTarget(shot);
}

function shouldHaveMissingImageForStage(shot = {}) {
  if (shot.imageUrl) return false;
  return shouldCountAsGeneratedImageTarget(shot);
}

function shouldCountAsGeneratedImageTarget(shot = {}) {
  const assetType = normalizeId(shot.assetType);
  if (assetType === "product") return true;
  if (assetType === "scene" && isEcommerceProductCloseupSceneShot(shot)) return false;
  return true;
}

function isEcommerceProductShot(shot = {}) {
  return normalizeId(shot.assetType) === "product";
}

function markMissingProductImageErrors(run, requestedShotIds = new Set()) {
  const requestedIds = requestedShotIds instanceof Set ? requestedShotIds : new Set();
  currentShots(run).forEach((shot) => {
    if (!isEcommerceProductShot(shot)) return;
    const shotId = workflowShotId(shot);
    if (requestedIds.size && !requestedIds.has(shotId)) return;
    if (shot.imageUrl) return;
    patchShot(run, shotId, {
      imageStatus: "error",
      imageError: missingProductImageError,
      imagePauseReason: "",
      imageSource: shot.imageSource || "product-library",
    });
  });
}

function isEcommerceProductCloseupSceneShot(shot = {}) {
  const text = removeEcommerceNegativeProductClauses([
    shot.title,
    shot.prompt,
    shot.imagePrompt,
    shot.description,
    shot.text,
    shot.script,
  ].map(normalizeId).filter(Boolean).join(" "));
  if (!text) return false;
  return /(?:产品|商品|包装|包装盒|瓶身|瓶罐|品牌|Logo|logo|LOGO|商标|卖点卡片)\s*(?:特写|近景|展示|摆拍|陈列|露出|镜头|画面|图)/.test(text)
    || /(?:特写|近景|推近|怼近|展示|摆拍|陈列|露出)\s*(?:产品|商品|包装|包装盒|瓶身|瓶罐|品牌|Logo|logo|LOGO|商标)/.test(text)
    || /(?:产品图|商品图|带货产品|货架摆拍|商品展示台|手持展示商品|手持商品|产品卖点卡|卖点卡片)/.test(text);
}

function removeEcommerceNegativeProductClauses(text = "") {
  return normalizeId(text).replace(/(?:不出现|不要出现|不得出现|禁止出现|避免出现|不要生成|不生成|不包含|无|没有)[^，,。；;]*?(?:产品|商品|包装|包装盒|瓶身|瓶罐|品牌|Logo|logo|LOGO|商标|货架|陈列|展示|特写|摆拍)[^，,。；;]*/g, "");
}
