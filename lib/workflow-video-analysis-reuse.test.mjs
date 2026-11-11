import assert from "node:assert/strict";
import test from "node:test";
import {
  canReuseWorkflowVideoAnalysis,
  workflowVideoSourceIdentity,
} from "./workflow-video-analysis-reuse.mjs";

const analyzedYoutubeSource = {
  sourceType: "youtube",
  sourceFile: {
    fileUrl: "https://www.youtube.com/watch?v=9hE5-98ZeCg",
    sourceUrl: "https://www.youtube.com/watch?v=9hE5-98ZeCg",
  },
  analysisStatus: "done",
  analysisLlmKeyId: "removed-provider-key",
  analysisModelId: "gemini-3.1-pro-preview",
  scriptAssetId: "",
};

test("completed video analysis is reused when only downstream workflow settings change", () => {
  assert.equal(canReuseWorkflowVideoAnalysis({
    existingSource: analyzedYoutubeSource,
    nextSource: {
      sourceType: "youtube",
      sourceFile: { fileUrl: "https://youtu.be/9hE5-98ZeCg?si=tracking" },
    },
    scriptAsset: { prompt: "structured reference script" },
    analysisConfigChanged: false,
  }), true);
});

test("video analysis is not reused after an explicit analysis config or source change", () => {
  const scriptAsset = { prompt: "structured reference script" };
  assert.equal(canReuseWorkflowVideoAnalysis({
    existingSource: analyzedYoutubeSource,
    nextSource: analyzedYoutubeSource,
    scriptAsset,
    analysisConfigChanged: true,
  }), false);
  assert.equal(canReuseWorkflowVideoAnalysis({
    existingSource: analyzedYoutubeSource,
    nextSource: {
      sourceType: "youtube",
      sourceFile: { fileUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
    },
    scriptAsset,
  }), false);
});

test("enabling script-library persistence requires an existing saved asset", () => {
  assert.equal(canReuseWorkflowVideoAnalysis({
    existingSource: analyzedYoutubeSource,
    nextSource: analyzedYoutubeSource,
    scriptAsset: { prompt: "structured reference script" },
    saveToScriptLibrary: true,
  }), false);
  assert.equal(workflowVideoSourceIdentity({
    sourceFile: { fileKey: "uploads/reference.mp4", fileUrl: "https://cdn.example.com/reference.mp4" },
  }), "upload:uploads/reference.mp4");
});
