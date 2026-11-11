import assert from "node:assert/strict";
import test from "node:test";

import { workflowAudioProgressView } from "./workflow-audio-progress.mjs";

test("shows the current chunk and percentage for multi-part audio", () => {
  assert.deepEqual(workflowAudioProgressView({
    completedChunks: 5,
    totalChunks: 18,
    currentChunk: 6,
  }), {
    determinate: true,
    totalChunks: 18,
    completedChunks: 5,
    currentChunk: 6,
    percentage: 28,
    title: "正在生成第 6/18 段音频",
    detail: "已完成 5/18 段，当前段正在生成音频并提取时间戳。",
  });
});

test("shows finalizing state after every chunk has completed", () => {
  const view = workflowAudioProgressView({
    completedChunks: 3,
    totalChunks: 3,
    currentChunk: 3,
  });

  assert.equal(view.percentage, 100);
  assert.equal(view.title, "全部 3 段已生成，正在整理结果");
  assert.equal(view.detail, "正在合并音频并保存时间戳，请稍候。");
});

test("falls back to indeterminate progress for legacy runs", () => {
  assert.deepEqual(workflowAudioProgressView(null), {
    determinate: false,
    totalChunks: 0,
    completedChunks: 0,
    currentChunk: 0,
    percentage: 0,
    title: "音频生成中",
    detail: "正在生成口播音频并提取时间戳。",
  });
});

test("clamps stale or invalid chunk counters", () => {
  const view = workflowAudioProgressView({
    completedChunks: 99,
    totalChunks: 4,
    currentChunk: -2,
  });

  assert.equal(view.completedChunks, 4);
  assert.equal(view.currentChunk, 4);
  assert.equal(view.percentage, 100);
});
