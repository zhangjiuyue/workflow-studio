import crypto from "node:crypto";
import { httpError } from "../http.js";
import { normalizeYoutubeVideoUrl } from "../lib/youtube-video-url.mjs";
import { saveAsset } from "./asset-store.js";
import {
  analyzeScriptVideoSource,
  scriptAssetPayloadFromVideoAnalysis,
} from "./script-asset-video-analysis-runner.js";
import {
  getWorkflowRun,
  listWorkflows,
  updateWorkflow,
  updateWorkflowRun,
  workflowConfigForRunSnapshot,
} from "./workflow-store.js";

export async function executeWorkflowVideoAnalysisNode(user, input = {}, config = {}) {
  const runId = normalizeId(input.runId);
  if (!runId) throw httpError(400, "缺少工作流任务 ID。");

  const run = await getWorkflowRun(user.id, runId, config);
  const workflows = await listWorkflows(user.id, config);
  const workflow = workflows.find((item) => item.id === run.workflowId && item.userId === user.id);
  if (!workflow) throw httpError(404, "工作流不存在。");

  const workflowForRun = workflowConfigForRunSnapshot(workflow, run);
  const workflowSnapshot = workflowVideoAnalysisRetrySnapshot(workflowForRun.config, input);
  const workflowType = normalizeId(workflowSnapshot.type || workflow.type);
  if (!["story", "ecommerce"].includes(workflowType)) {
    throw httpError(400, "视频快捷导入仅支持故事视频或带货视频工作流。");
  }

  const source = normalizeWorkflowStoryVideoSource(workflowSnapshot.storyVideoSource);
  if (!source.sourceFile.fileUrl) throw httpError(400, "请先上传本地视频或填写 YouTube 视频链接。");
  if (source.sourceType === "youtube" && !normalizeYoutubeVideoUrl(source.sourceFile.sourceUrl || source.sourceFile.fileUrl)) {
    throw httpError(400, "请输入有效的公开 YouTube 视频链接。");
  }

  const analysis = await analyzeScriptVideoSource(user, {
    name: source.name || workflowSnapshot.name || workflow.name || source.sourceFile.name,
    sourceFile: source.sourceFile,
    llmKeyId: source.analysisLlmKeyId || workflowSnapshot.llmKeyId,
    modelId: source.analysisModelId || workflowSnapshot.storyModelId,
    roleCountMode: "auto",
    targetDurationMode: "source",
    createdAt: source.createdAt || run.createdAt,
    analysisStartedAt: new Date().toISOString(),
    publicApiBaseUrl: input.publicApiBaseUrl || config.publicApiBaseUrl || "",
  }, config);

  const libraryAssetId = source.saveToScriptLibrary
    ? normalizeId(source.scriptAssetId) || crypto.randomUUID()
    : "";
  const snapshotId = libraryAssetId || `workflow-video-${run.id}`;
  const assetPayload = scriptAssetPayloadFromVideoAnalysis(analysis, {
    type: "script",
    id: snapshotId,
    name: analysis.name,
    sourceFile: analysis.sourceFile,
    createdAt: analysis.createdAt,
  }, { id: snapshotId });

  let savedAsset = null;
  if (libraryAssetId) {
    savedAsset = await saveAsset(user, "script", {
      id: libraryAssetId,
      name: analysis.name,
      groupId: "",
      fileUrl: analysis.sourceFile.fileUrl,
      fileKey: analysis.sourceFile.fileKey,
      mimeType: analysis.sourceFile.mimeType,
      sizeBytes: analysis.sourceFile.sizeBytes,
      createdAt: analysis.createdAt,
      payload: {
        ...assetPayload,
        id: libraryAssetId,
        savedFromWorkflowId: workflow.id,
        savedFromWorkflowRunId: run.id,
      },
    }, config);
  }

  const scriptSnapshot = workflowScriptAssetSnapshot(
    savedAsset?.payload || assetPayload,
    savedAsset?.id || snapshotId,
  );
  const completedSource = {
    ...source,
    name: analysis.name,
    sourceFile: analysis.sourceFile,
    analysisStatus: "done",
    analysisError: "",
    analysisLlmKeyId: analysis.llmKeyId,
    analysisModelId: analysis.modelId,
    analyzedAt: analysis.updatedAt,
    scriptAssetId: libraryAssetId,
  };
  const nextSnapshot = workflowSnapshotWithAnalyzedVideo(
    workflowSnapshot,
    completedSource,
    scriptSnapshot,
    libraryAssetId,
  );
  const result = normalizeObject(run.result);
  const updatedRun = await updateWorkflowRun(user.id, run.id, {
    status: "running",
    completedAt: "",
    error: "",
    result: {
      ...result,
      workflowSnapshot: nextSnapshot,
      storyVideoAnalysis: {
        status: "done",
        sourceType: completedSource.sourceType,
        sourceName: completedSource.name,
        savedToScriptLibrary: Boolean(libraryAssetId),
        scriptAssetId: libraryAssetId,
        analyzedAt: completedSource.analyzedAt,
      },
    },
  }, config);

  await persistAnalyzedVideoOnWorkflow({
    userId: user.id,
    workflow,
    source,
    completedSource,
    scriptSnapshot,
    libraryAssetId,
    config,
  });

  return {
    run: updatedRun,
    scriptAsset: scriptSnapshot,
    savedAsset,
  };
}

export function workflowVideoNeedsAnalysis(workflow = {}) {
  const config = normalizeObject(workflow.config && typeof workflow.config === "object" ? workflow.config : workflow);
  if (!["story", "ecommerce"].includes(normalizeId(config.type))) return false;
  if (normalizeId(config.storyScriptSourceMode) !== "direct") return false;
  const source = normalizeWorkflowStoryVideoSource(config.storyVideoSource);
  if (!source.sourceFile.fileUrl) return false;
  const script = normalizeObject(config.ecommerceAssets?.scripts);
  return source.analysisStatus !== "done" || !normalizeId(script.prompt);
}

export function workflowVideoAnalysisRetrySnapshot(snapshot = {}, input = {}) {
  const baseSnapshot = normalizeObject(snapshot);
  const baseSource = normalizeWorkflowStoryVideoSource(baseSnapshot.storyVideoSource);
  const retryLlmKeyId = normalizeId(input.llmKeyId || input.apiKeyId);
  const retryModelId = normalizeId(input.modelId || input.storyModelId);
  if (!retryLlmKeyId && !retryModelId) return baseSnapshot;
  return {
    ...baseSnapshot,
    storyVideoSource: {
      ...baseSource,
      analysisLlmKeyId: retryLlmKeyId || baseSource.analysisLlmKeyId,
      analysisModelId: retryModelId || baseSource.analysisModelId,
    },
  };
}

export function normalizeWorkflowStoryVideoSource(value = {}) {
  const source = normalizeObject(value);
  const inputFile = normalizeObject(source.sourceFile);
  const youtubeUrl = normalizeYoutubeVideoUrl(inputFile.sourceUrl || source.youtubeUrl || inputFile.fileUrl);
  const sourceType = youtubeUrl || source.sourceType === "youtube" ? "youtube" : "upload";
  const fileUrl = sourceType === "youtube" ? youtubeUrl : normalizeId(inputFile.fileUrl || inputFile.url);
  return {
    name: normalizeId(source.name || inputFile.name || inputFile.originalName) || (sourceType === "youtube" ? "YouTube 视频" : "工作流视频"),
    sourceType,
    sourceFile: {
      name: normalizeId(inputFile.name || inputFile.originalName || source.name),
      fileUrl,
      fileKey: normalizeId(inputFile.fileKey || inputFile.key),
      mimeType: normalizeId(inputFile.mimeType || inputFile.type) || (sourceType === "youtube" ? "video/*" : "video/mp4"),
      sizeBytes: positiveNumber(inputFile.sizeBytes || inputFile.size),
      durationSeconds: positiveNumber(inputFile.durationSeconds || inputFile.duration),
      sourceType,
      sourceUrl: sourceType === "youtube" ? youtubeUrl : "",
    },
    saveToScriptLibrary: Boolean(source.saveToScriptLibrary),
    scriptAssetId: normalizeId(source.scriptAssetId),
    analysisStatus: normalizeId(source.analysisStatus) || "pending",
    analysisError: normalizeId(source.analysisError),
    analysisLlmKeyId: normalizeId(source.analysisLlmKeyId),
    analysisModelId: normalizeId(source.analysisModelId),
    analyzedAt: normalizeId(source.analyzedAt),
    createdAt: normalizeId(source.createdAt),
  };
}

export function workflowVideoSourceKey(value = {}) {
  const source = normalizeWorkflowStoryVideoSource(value);
  return [
    source.sourceType,
    source.sourceFile.sourceUrl || source.sourceFile.fileKey || source.sourceFile.fileUrl,
  ].join(":");
}

export function workflowScriptAssetSnapshot(payload = {}, id = "") {
  const asset = normalizeObject(payload);
  return {
    id: normalizeId(id || asset.id),
    type: "script",
    name: normalizeId(asset.name) || "工作流视频脚本",
    desc: normalizeId(asset.desc),
    tag: normalizeId(asset.tag),
    prompt: normalizeId(asset.prompt),
    sourceFile: normalizeObject(asset.sourceFile),
    targetDurationMode: normalizeId(asset.targetDurationMode) || "source",
    targetDurationSeconds: positiveNumber(asset.targetDurationSeconds),
    durationSeconds: positiveNumber(asset.durationSeconds),
    scriptProfile: normalizeObject(asset.scriptProfile),
    sourceShotCount: positiveNumber(asset.sourceShotCount),
    targetShotCount: positiveNumber(asset.targetShotCount),
    estimatedShotCount: positiveNumber(asset.estimatedShotCount),
    updatedAt: normalizeId(asset.updatedAt || asset.createdAt),
  };
}

function workflowSnapshotWithAnalyzedVideo(snapshot, source, scriptSnapshot, libraryAssetId) {
  return {
    ...snapshot,
    storyScriptSourceMode: "direct",
    storyVideoSource: source,
    scriptAssetId: libraryAssetId,
    ecommerceAssets: {
      ...normalizeObject(snapshot.ecommerceAssets),
      scripts: scriptSnapshot,
    },
  };
}

async function persistAnalyzedVideoOnWorkflow({ userId, workflow, source, completedSource, scriptSnapshot, libraryAssetId, config }) {
  const currentConfig = normalizeObject(workflow.config);
  if (workflowVideoSourceKey(currentConfig.storyVideoSource) !== workflowVideoSourceKey(source)) return null;
  const nextConfig = workflowSnapshotWithAnalyzedVideo(
    currentConfig,
    completedSource,
    scriptSnapshot,
    libraryAssetId,
  );
  return await updateWorkflow(userId, workflow.id, {
    name: workflow.name || currentConfig.name || "视频工作流",
    type: workflow.type || currentConfig.type || "story",
    config: nextConfig,
  }, config);
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeId(value = "") {
  return String(value || "").trim();
}

function positiveNumber(value = 0) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}
