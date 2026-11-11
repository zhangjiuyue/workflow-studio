import assert from "node:assert/strict";
import test from "node:test";

import {
  isTalkingVideoWorkflow,
  orderWorkflowStageIds,
  workflowNodeActiveStatus,
  workflowSupportsRoleOutfitVariantDetection,
} from "./workflow-stage-policy.mjs";

const defaultStages = ["topic", "outline", "script", "optimize", "shot", "image", "audio", "videoPrompt", "video"];

test("talking-video stages omit outline and optimize, then place audio after script", () => {
  assert.deepEqual(
    orderWorkflowStageIds(defaultStages, { type: "explain" }),
    ["topic", "script", "audio", "shot", "image", "videoPrompt", "video"],
  );
});

test("non-talking workflows retain their existing stage order", () => {
  for (const type of ["ecommerce", "story", "free"]) {
    assert.deepEqual(orderWorkflowStageIds(defaultStages, { type }), defaultStages);
  }
});

test("talking-video detection works with nested workflow config", () => {
  assert.equal(isTalkingVideoWorkflow({ config: { type: "explain" } }), true);
  assert.equal(isTalkingVideoWorkflow({ config: { type: "ecommerce" } }), false);
});

test("outfit-variant detection is disabled only for talking video", () => {
  assert.equal(workflowSupportsRoleOutfitVariantDetection({ type: "explain" }), false);
  assert.equal(workflowSupportsRoleOutfitVariantDetection({ type: "ecommerce" }), true);
  assert.equal(workflowSupportsRoleOutfitVariantDetection({ type: "story" }), true);
  assert.equal(workflowSupportsRoleOutfitVariantDetection({ type: "free" }), true);
});

test("audio regeneration remains visibly running while an older audio result exists", () => {
  assert.equal(workflowNodeActiveStatus({
    status: "running",
    stages: { audio: "running" },
    result: { audioUrl: "/audio/previous.mp3" },
  }, "audio"), "running");
});

test("an active audio backend job is authoritative even before the run status refreshes", () => {
  assert.equal(workflowNodeActiveStatus({
    status: "waiting",
    stages: { audio: "pending" },
    result: { backendJobs: { audio: { status: "queued" } } },
  }, "audio"), "queued");
  assert.equal(workflowNodeActiveStatus({
    status: "waiting",
    stages: { audio: "running" },
  }, "audio"), "");
});
