import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeWorkflowStoryVideoSource,
  workflowScriptAssetSnapshot,
  workflowVideoAnalysisRetrySnapshot,
  workflowVideoNeedsAnalysis,
  workflowVideoSourceKey,
} from "./workflow-story-video-analysis-runner.js";

test("normalizes YouTube workflow sources to the canonical video URL", () => {
  const source = normalizeWorkflowStoryVideoSource({
    name: "Reference short",
    saveToScriptLibrary: true,
    sourceFile: {
      fileUrl: "https://youtu.be/9hE5-98ZeCg?t=12",
    },
  });

  assert.equal(source.sourceType, "youtube");
  assert.equal(source.sourceFile.fileUrl, "https://www.youtube.com/watch?v=9hE5-98ZeCg");
  assert.equal(source.sourceFile.sourceUrl, "https://www.youtube.com/watch?v=9hE5-98ZeCg");
  assert.equal(source.saveToScriptLibrary, true);
});

test("only pending direct storyboard video sources require analysis", () => {
  const source = {
    analysisStatus: "pending",
    sourceFile: { fileUrl: "/files/reference.mp4" },
  };
  assert.equal(workflowVideoNeedsAnalysis({
    type: "story",
    storyScriptSourceMode: "direct",
    storyVideoSource: source,
    ecommerceAssets: { scripts: null },
  }), true);

  assert.equal(workflowVideoNeedsAnalysis({
    type: "story",
    storyScriptSourceMode: "direct",
    storyVideoSource: { ...source, analysisStatus: "done" },
    ecommerceAssets: { scripts: { prompt: "【脚本资产摘要】\n原时长：30 秒" } },
  }), false);

  assert.equal(workflowVideoNeedsAnalysis({
    type: "story",
    storyScriptSourceMode: "library",
    storyVideoSource: source,
  }), false);

  assert.equal(workflowVideoNeedsAnalysis({
    type: "ecommerce",
    storyScriptSourceMode: "direct",
    storyVideoSource: source,
    ecommerceAssets: { scripts: null },
  }), true);
});

test("source keys remain stable across equivalent uploaded and YouTube records", () => {
  assert.equal(
    workflowVideoSourceKey({ sourceFile: { fileKey: "uploads/a.mp4", fileUrl: "/files/a.mp4" } }),
    workflowVideoSourceKey({ sourceFile: { fileKey: "uploads/a.mp4", fileUrl: "https://cdn.example/a.mp4" } }),
  );
  assert.equal(
    workflowVideoSourceKey({ sourceFile: { fileUrl: "https://youtube.com/shorts/9hE5-98ZeCg" } }),
    workflowVideoSourceKey({ sourceFile: { sourceUrl: "https://youtu.be/9hE5-98ZeCg" } }),
  );
});

test("builds a workflow script snapshot from the shared script payload", () => {
  const snapshot = workflowScriptAssetSnapshot({
    id: "script-1",
    name: "Reference",
    prompt: "restored script",
    sourceFile: { fileUrl: "/files/reference.mp4", durationSeconds: 42 },
    scriptProfile: { sourceShotCount: 9 },
    sourceShotCount: 9,
    targetShotCount: 9,
  });

  assert.deepEqual(snapshot.scriptProfile, { sourceShotCount: 9 });
  assert.equal(snapshot.id, "script-1");
  assert.equal(snapshot.prompt, "restored script");
  assert.equal(snapshot.sourceShotCount, 9);
});

test("video analysis retry uses the newly selected provider without changing the source", () => {
  const snapshot = workflowVideoAnalysisRetrySnapshot({
    type: "story",
    storyVideoSource: {
      analysisLlmKeyId: "removed-provider-key",
      analysisModelId: "gemini-3.1-pro-preview",
      analysisStatus: "error",
      sourceFile: { fileUrl: "https://www.youtube.com/watch?v=9hE5-98ZeCg" },
    },
  }, {
    llmKeyId: "synthetic-key",
    modelId: "gemini-3.1-pro-preview",
  });

  assert.equal(snapshot.storyVideoSource.analysisLlmKeyId, "synthetic-key");
  assert.equal(snapshot.storyVideoSource.analysisModelId, "gemini-3.1-pro-preview");
  assert.equal(snapshot.storyVideoSource.sourceFile.fileUrl, "https://www.youtube.com/watch?v=9hE5-98ZeCg");
});
