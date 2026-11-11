import assert from "node:assert/strict";
import test from "node:test";

import { buildWorkflowAiDirectorVideoPrompt, workflowAiDirectorErrorMessage, workflowAiDirectorTimelineTaskView, workflowStoryboardReadyForVideoTimeline, workflowVideoTimelineHasAiDirectorOutput } from "./workflow-ai-video-prompt.mjs";

test("AI director prompt numbers images with the existing local filename order", () => {
  const prompt = buildWorkflowAiDirectorVideoPrompt({
    assets: [
      { title: "家庭餐厅", assetType: "scene", imageUrl: "https://example.com/scene.png" },
      { title: "谷雨", assetType: "role", imageUrl: "https://example.com/gu.png" },
      { title: "Mira", assetType: "role", imageUrl: "https://example.com/mira.png" },
      { title: "父亲", assetType: "role", imageUrl: "https://example.com/father.png" },
    ],
    voiceBindings: [
      { name: "谷雨", voice: "克制真诚的青年男声" },
      { name: "Mira", voice: "清晰坚定的青年女声" },
      { name: "父亲", voice: "沉稳厚重的中年男声" },
    ],
    beats: [
      { start: 0, end: 4, description: "家庭餐厅中景，谷雨抬头看向父亲。" },
    ],
  });

  assert.match(prompt, /场景参考：@图片4 家庭餐厅/);
  assert.match(prompt, /角色：@图片1 Mira，@图片2 父亲，@图片3 谷雨/);
  assert.match(prompt, /角色-声线绑定：Mira｜清晰坚定的青年女声，父亲｜沉稳厚重的中年男声，谷雨｜克制真诚的青年男声/);
  assert.match(prompt, /\[0–4秒\]：家庭餐厅中景，谷雨抬头看向父亲。/);
  assert.match(prompt, /不要生成任何背景音乐（BGM）或配乐/);
});

test("AI director task view lets a current backend run override a stale local error", () => {
  const task = workflowAiDirectorTimelineTaskView({
    localTask: {
      mode: "ai-director",
      status: "error",
      detail: "上一次生成失败。",
    },
    running: true,
    progress: 12,
    failed: true,
    error: "上一次生成失败。",
    backendJobId: "new-job",
  });

  assert.equal(task.status, "running");
  assert.equal(task.progress, 12);
  assert.match(task.detail, /正在分析完整剧本/);
});

test("AI director task view keeps a newly submitted job ahead of an older persisted error", () => {
  const submitting = workflowAiDirectorTimelineTaskView({
    localTask: {
      mode: "ai-director",
      status: "submitting",
      detail: "正在提交新的 AI 导演任务。",
    },
    failed: true,
    error: "上一次生成失败。",
    backendJobId: "old-job",
  });
  assert.equal(submitting.status, "submitting");

  const accepted = workflowAiDirectorTimelineTaskView({
    localTask: {
      mode: "ai-director",
      status: "running",
      jobId: "new-job",
      detail: "正在生成。",
    },
    failed: true,
    error: "上一次生成失败。",
    backendJobId: "old-job",
  });
  assert.equal(accepted.status, "running");
});

test("AI director task view restores a persisted backend failure without local state", () => {
  const task = workflowAiDirectorTimelineTaskView({
    failed: true,
    error: "模型返回内容不符合时间码要求。",
    backendJobId: "failed-job",
  });

  assert.equal(task.status, "error");
  assert.equal(task.progress, 100);
  assert.equal(task.detail, "模型返回内容不符合时间码要求。");
});

test("AI director task view explains legacy terminated transport failures", () => {
  const detail = workflowAiDirectorErrorMessage("terminated");
  const task = workflowAiDirectorTimelineTaskView({
    failed: true,
    error: "terminated",
  });

  assert.match(detail, /模型返回连接意外中断/);
  assert.match(detail, /渠道后台没有请求记录/);
  assert.equal(task.detail, detail);
  assert.equal(workflowAiDirectorErrorMessage("模型额度不足"), "模型额度不足");
});

test("AI director timeline output is distinguished from quick assembly", () => {
  assert.equal(workflowVideoTimelineHasAiDirectorOutput([
    { id: "quick", videoPromptMode: "" },
    { id: "director", videoPromptMode: "ai-director" },
  ]), true);
  assert.equal(workflowVideoTimelineHasAiDirectorOutput([
    { id: "quick", videoPromptMode: "" },
  ]), false);
});

test("story and ecommerce AI director timelines use the stored plan instead of traditional storyboard text", () => {
  for (const workflowType of ["story", "ecommerce"]) {
    assert.equal(workflowStoryboardReadyForVideoTimeline({
      workflowType,
      storyboardMode: "ai-director",
      aiDirectorPlan: { segments: [{ prompt: `director ${workflowType}` }] },
      traditionalStoryboardCount: 0,
    }), true);
    assert.equal(workflowStoryboardReadyForVideoTimeline({
      workflowType,
      storyboardMode: "ai-director",
      aiDirectorPlan: { segments: [] },
      traditionalStoryboardCount: 12,
    }), false);
  }
});

test("traditional storyboard timelines keep their existing parsed-shot requirement", () => {
  assert.equal(workflowStoryboardReadyForVideoTimeline({
    workflowType: "story",
    storyboardMode: "traditional",
    traditionalStoryboardCount: 0,
  }), false);
  assert.equal(workflowStoryboardReadyForVideoTimeline({
    workflowType: "ecommerce",
    storyboardMode: "traditional",
    traditionalStoryboardCount: 3,
  }), true);
  assert.equal(workflowStoryboardReadyForVideoTimeline({
    workflowType: "explain",
    storyboardMode: "traditional",
    traditionalStoryboardCount: 0,
  }), true);
});
