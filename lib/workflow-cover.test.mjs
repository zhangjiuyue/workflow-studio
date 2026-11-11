import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorkflowCoverPrompt,
  collectWorkflowCoverRoleImages,
  composeWorkflowCoverInstruction,
  defaultWorkflowCoverPrompt,
  normalizeWorkflowCoverCount,
  validateWorkflowCoverRoleCount,
  workflowCoverRealismInstruction,
} from "./workflow-cover.mjs";

test("系统提示词可以与用户提示词叠加", () => {
  const prompt = composeWorkflowCoverInstruction({
    type: "story",
    includeSystemPrompt: true,
    userPrompt: "画面突出母子重逢时的情绪。",
  });

  assert.match(prompt, /这是一条故事\/短剧视频/);
  assert.match(prompt, /【用户补充要求】/);
  assert.match(prompt, /画面突出母子重逢/);
});

test("不勾选系统提示词时只发送用户提示词", () => {
  const prompt = composeWorkflowCoverInstruction({
    type: "ecommerce",
    includeSystemPrompt: false,
    userPrompt: "使用暖色电影感构图。",
  });

  assert.equal(prompt, "使用暖色电影感构图。");
  assert.doesNotMatch(prompt, /这是一条带货视频/);
});

test("勾选系统提示词时允许不填写用户提示词", () => {
  assert.equal(
    composeWorkflowCoverInstruction({ type: "explain", includeSystemPrompt: true }),
    defaultWorkflowCoverPrompt("explain"),
  );
});

test("系统提示词要求清除角色参考图中的马赛克和绘画效果", () => {
  for (const type of ["explain", "story", "ecommerce", "free"]) {
    assert.match(defaultWorkflowCoverPrompt(type), new RegExp(workflowCoverRealismInstruction.replace("。", "")));
  }
  assert.doesNotMatch(
    composeWorkflowCoverInstruction({ type: "story", includeSystemPrompt: false, userPrompt: "电影感构图" }),
    /马赛克效果/,
  );
});

test("口播封面引用选题和最终文案", () => {
  const prompt = buildWorkflowCoverPrompt({
    type: "explain",
    prompt: defaultWorkflowCoverPrompt("explain"),
    includeContentReference: true,
    topic: "普通人为什么总是存不下钱",
    script: "问题不只是收入，而是消费顺序。",
  });

  assert.match(prompt, /这是一条口播视频/);
  assert.match(prompt, /【视频选题】/);
  assert.match(prompt, /【最终文案】/);
});

test("故事和带货封面只引用选题大纲", () => {
  for (const type of ["story", "ecommerce"]) {
    const prompt = buildWorkflowCoverPrompt({
      type,
      includeContentReference: true,
      topic: "夫妻因为一封信产生误会，最后发现信来自十年前。",
      script: "这是一篇很长的最终文案，不应该追加。",
    });

    assert.match(prompt, /【选题大纲】/);
    assert.doesNotMatch(prompt, /【最终文案】/);
    assert.doesNotMatch(prompt, /这是一篇很长/);
  }
});

test("角色参考图限制为九张", () => {
  assert.equal(validateWorkflowCoverRoleCount(9), "");
  assert.match(validateWorkflowCoverRoleCount(10), /最多选择 9 张/);
});

test("生成数量限制在一到五张", () => {
  assert.equal(normalizeWorkflowCoverCount(0), 1);
  assert.equal(normalizeWorkflowCoverCount(3), 3);
  assert.equal(normalizeWorkflowCoverCount(10), 5);
});

test("角色参考图只读取当前分镜结果中的角色资产", () => {
  const images = collectWorkflowCoverRoleImages({
    shots: [
      { id: "role-1", assetType: "role", title: "母亲", imageUrl: "/objects/role-1.png", imageThumbnailUrl: "/objects/role-1.webp" },
      { id: "scene-1", assetType: "scene", title: "客厅", imageUrl: "/objects/scene-1.png" },
      { id: "role-duplicate", assetType: "role", title: "母亲备用", imageUrl: "/objects/role-1.png" },
      { id: "role-2", assetType: "role", roleName: "儿子", image: { url: "/objects/role-2.png", thumbnailUrl: "/objects/role-2.webp" } },
    ],
  });

  assert.deepEqual(images, [
    { id: "role-1", name: "母亲", url: "/objects/role-1.png", thumbnailUrl: "/objects/role-1.webp" },
    { id: "role-2", name: "儿子", url: "/objects/role-2.png", thumbnailUrl: "/objects/role-2.webp" },
  ]);
});
