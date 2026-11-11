import assert from "node:assert/strict";
import test from "node:test";
import { assertVideoAnalysisModel, normalizeScriptStructureProfile, scriptAssetPayloadFromVideoAnalysis, scriptVideoMessagePart, videoAnalysisModelId } from "./script-asset-video-analysis-runner.js";

test("video analysis requires an explicitly configured model capability", () => {
  const models = [{id:'test-video', videoAnalysis:true}, {id:'test-text'}];
  assert.equal(assertVideoAnalysisModel('test-video', models), 'test-video');
  assert.throws(() => assertVideoAnalysisModel('test-text', models), error => error.status === 400);
  assert.throws(() => assertVideoAnalysisModel('test-video'), error => error.status === 400);
});

test("script video message part always includes a usable video mime type", () => {
  const movPart = scriptVideoMessagePart("https://example.com/files/video", {
    name: "reference.mov",
    mimeType: "",
  });
  assert.equal(movPart.mimeType, "video/quicktime");
  assert.equal(movPart.mime_type, "video/quicktime");
  assert.equal(movPart.video_url.mimeType, "video/quicktime");
  assert.equal(movPart.video_url.mime_type, "video/quicktime");

  const webmPart = scriptVideoMessagePart("https://example.com/files/reference.webm", {
    mimeType: "application/octet-stream",
  });
  assert.equal(webmPart.mimeType, "video/webm");

  const fallbackPart = scriptVideoMessagePart("https://example.com/files/reference", {});
  assert.equal(fallbackPart.mimeType, "video/mp4");
});

test("shared video analysis payload keeps the script library structure", () => {
  const payload = scriptAssetPayloadFromVideoAnalysis({
    name: "Reference short",
    rawText: "【脚本资产摘要】\n原时长：30 秒",
    profile: {
      sourceDurationSeconds: 30,
      targetDurationSeconds: 30,
      sourceShotCount: 6,
      targetShotCount: 6,
      estimatedShotCount: 6,
    },
    sourceFile: {
      name: "reference.mp4",
      fileUrl: "/files/reference.mp4",
      mimeType: "video/mp4",
      durationSeconds: 30,
    },
    sourceDurationSeconds: 30,
    targetDurationSeconds: 30,
    targetDurationMode: "source",
    roleCountMode: "auto",
    roleCount: 1,
    modelId: "test-video",
    llmKeyId: "llm-1",
  }, {}, { id: "script-1" });

  assert.equal(payload.id, "script-1");
  assert.equal(payload.analysisStatus, "done");
  assert.equal(payload.prompt, "【脚本资产摘要】\n原时长：30 秒");
  assert.equal(payload.sourceShotCount, 6);
  assert.equal(payload.sourceFile.fileUrl, "/files/reference.mp4");
});

test("auto role count prefers lead plus supporting count over noisy model total", () => {
  const profile = normalizeScriptStructureProfile([
    "【脚本资产摘要】",
    "原时长：430 秒",
    "目标时长：1000 秒",
    "角色数量：20",
    "有无对白：有",
    "",
    "【核心人物】",
    "主角数量：1",
    "配角数量：2",
    "人物关系：女主、丈夫和婆婆构成主要家庭冲突。",
    "角色清单：",
    "1. 女主（主角）：家庭冲突里的主要承压者。",
    "2. 丈夫（配角）：推动误会升级。",
    "3. 婆婆（配角）：制造压力和转折。",
    ...Array.from({ length: 17 }, (_, index) => `${index + 4}. 围观者${index + 1}（可确认边缘人物）：短暂出现，不推动核心冲突。`),
  ].join("\n"), {
    roleCountMode: "auto",
    roleCount: 20,
  });

  assert.equal(profile.coreCharacters.leadCount, 1);
  assert.equal(profile.coreCharacters.supportingCount, 2);
  assert.equal(profile.coreCharacters.totalCount, 3);
  assert.equal(profile.coreCharacters.characters.length, 3);
});

test("custom role count uses actual extracted list instead of blindly showing requested count", () => {
  const profile = normalizeScriptStructureProfile([
    "【脚本资产摘要】",
    "原时长：60 秒",
    "目标时长：60 秒",
    "角色数量：20",
    "有无对白：有",
    "",
    "【核心人物】",
    "主角数量：1",
    "配角数量：2",
    "人物关系：核心三人推动主线，两个边缘人物可确认外观。",
    "角色清单：",
    "1. 女主（主角）：主要角色。",
    "2. 丈夫（配角）：重要配角。",
    "3. 婆婆（配角）：重要配角。",
    "4. 店员（可确认边缘人物）：短暂出镜但外观清楚。",
    "5. 路人（可确认边缘人物）：短暂出镜但外观清楚。",
  ].join("\n"), {
    roleCountMode: "custom",
    roleCount: 20,
  });

  assert.equal(profile.coreCharacters.totalCount, 5);
  assert.equal(profile.coreCharacters.characters.length, 5);
});

test("auto role count falls back to non-edge role list when lead/support counts are missing", () => {
  const profile = normalizeScriptStructureProfile([
    "【脚本资产摘要】",
    "原时长：45 秒",
    "目标时长：45 秒",
    "角色数量：20",
    "有无对白：有",
    "",
    "【核心人物】",
    "人物关系：两名核心人物推动冲突。",
    "角色清单：",
    "1. 女主（核心角色）：负责主要冲突。",
    "2. 丈夫（重要配角）：推动剧情转折。",
    "3. 路人（可确认边缘人物）：一闪而过。",
  ].join("\n"), {
    roleCountMode: "auto",
    roleCount: 20,
  });

  assert.equal(profile.coreCharacters.totalCount, 2);
  assert.equal(profile.coreCharacters.characters.length, 2);
});
