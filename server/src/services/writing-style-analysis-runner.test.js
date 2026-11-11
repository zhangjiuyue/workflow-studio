import assert from "node:assert/strict";
import test from "node:test";
import { buildWritingStyleAnalysisPrompt, writingStylePayloadFromAnalysis } from "./writing-style-analysis-runner.js";

test("writing style analysis prompt keeps the source file context", () => {
  const prompt = buildWritingStyleAnalysisPrompt({
    name: "sample.md",
    text: "这是用于分析的正文。",
  });
  assert.match(prompt, /文章文件名：sample\.md/);
  assert.match(prompt, /这是用于分析的正文/);
  assert.match(prompt, /【用词指纹】/);
});

test("completed writing style analysis replaces running state with reusable report", () => {
  const payload = writingStylePayloadFromAnalysis("【调性】\n亲切，像朋友聊天。", {
    analysisStatus: "running",
    analysisError: "旧错误",
  }, {
    id: "style-1",
    name: "示例文风",
    groupId: "group-1",
    llmKeyId: "key-1",
    modelId: "model-1",
    sourceFile: { name: "sample.md", text: "正文" },
  });

  assert.equal(payload.analysisStatus, "done");
  assert.equal(payload.analysisError, "");
  assert.equal(payload.prompt, "【调性】\n亲切，像朋友聊天。");
  assert.equal(payload.desc, "亲切，像朋友聊天。");
  assert.equal(payload.sourceFiles[0].name, "sample.md");
});
