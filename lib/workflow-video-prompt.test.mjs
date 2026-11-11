import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWorkflowVideoPromptSaveState,
  safeWorkflowVideoDownloadName,
  sortWorkflowVideoAssetsByFileName,
  workflowVideoMaterialFolderName,
  workflowVideoMaterialImagePath,
  workflowVideoTimelineItemId,
} from "./workflow-video-prompt.mjs";

test("video material folders use pure shot numbers for incomplete final groups", () => {
  assert.equal(workflowVideoMaterialFolderName({
    startIndex: 85,
    endIndex: 87,
    title: "第 85-87 镜",
  }), "第85-87镜");
  assert.equal(workflowVideoMaterialFolderName({
    startIndex: 88,
    endIndex: 88,
    title: "第 88 镜：客厅/全景推进",
  }), "第88镜");
});

test("video material image paths cannot create nested folders from titles", () => {
  const path = workflowVideoMaterialImagePath({
    item: {
      startIndex: 88,
      endIndex: 88,
      title: "第 88 镜：客厅/全景推进",
    },
    assetName: "Mira/正面\\近景／黑裙",
    extension: "png",
  });

  assert.equal(path, "第88镜/Mira-正面-近景-黑裙.png");
  assert.equal(path.split("/").length, 2);
  assert.equal(safeWorkflowVideoDownloadName("客厅/全景", "图片"), "客厅-全景");
});

test("video assets follow the downloaded folder's filename order without renaming", () => {
  const assets = [
    { title: "昏暗魔法实验教室", assetType: "scene" },
    { title: "Rumi", assetType: "role" },
    { title: "jinu", assetType: "role" },
    { title: "红发男老师", assetType: "role" },
    { title: "魔法比赛讲台区", assetType: "scene" },
    { title: "Mira", assetType: "role" },
  ];

  const sorted = sortWorkflowVideoAssetsByFileName(assets);

  assert.deepEqual(sorted.map((asset) => asset.title), [
    "jinu",
    "Mira",
    "Rumi",
    "红发男老师",
    "昏暗魔法实验教室",
    "魔法比赛讲台区",
  ]);
  assert.deepEqual(assets.map((asset) => asset.title), [
    "昏暗魔法实验教室",
    "Rumi",
    "jinu",
    "红发男老师",
    "魔法比赛讲台区",
    "Mira",
  ]);
});

test("video asset filename sorting is numeric and stable for duplicate names", () => {
  const sorted = sortWorkflowVideoAssetsByFileName([
    { title: "Role10", id: "ten" },
    { title: "role2", id: "second" },
    { title: "Role2", id: "first" },
    { title: "Role1", id: "one" },
  ]);

  assert.deepEqual(sorted.map((asset) => asset.id), ["one", "second", "first", "ten"]);
});

test("saving one video prompt preserves every existing video result", () => {
  const timeline = [
    { id: "segment-1", videoPrompt: "old one" },
    { id: "segment-2", videoPrompt: "old two" },
  ];
  const videoResults = [
    { id: "result-1", timelineItemId: "segment-1", status: "done", videoUrl: "https://example.com/one.mp4" },
    { id: "result-2", timelineItemId: "segment-2", status: "done", videoUrl: "https://example.com/two.mp4" },
  ];

  const saved = buildWorkflowVideoPromptSaveState({
    timeline,
    videoResults,
    promptId: "segment-1",
    nextPrompt: "  revised one  ",
  });

  assert.equal(saved.videoTimeline[0].videoPrompt, "revised one");
  assert.equal(saved.videoTimeline[1], timeline[1]);
  assert.equal(saved.videoResults, videoResults);
  assert.deepEqual(saved.videoResults, videoResults);
});

test("timeline ids retain the workflow fallback format", () => {
  assert.equal(workflowVideoTimelineItemId({ id: "explicit" }, 3), "explicit");
  assert.equal(workflowVideoTimelineItemId({ segmentId: "segment" }, 3), "segment");
  assert.equal(workflowVideoTimelineItemId({ shotId: "shot-7" }, 3), "shot-7-3");
});
