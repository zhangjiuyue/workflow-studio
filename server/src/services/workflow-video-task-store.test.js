import assert from "node:assert/strict";
import test from "node:test";
import { mergeWorkflowVideoTaskRecord } from "../lib/workflow-video-task-record.mjs";

test("video task merge keeps provider identity and execution state from a committed submission", () => {
  const committed = {
    id: "video-1",
    taskId: "task_lucky_123",
    status: "running",
    submissionState: "submitted",
    submittedAt: "2026-07-21T10:00:00.000Z",
    updatedAt: "2026-07-21T10:00:00.000Z",
    meta: { taskId: "task_lucky_123", requestId: "request-1" },
  };
  const staleBrowserRecord = {
    id: "video-1",
    status: "queued",
    submissionState: "queued",
    updatedAt: "2026-07-21T10:00:01.000Z",
    meta: { promptVersion: 2 },
  };

  const merged = mergeWorkflowVideoTaskRecord(committed, staleBrowserRecord);

  assert.equal(merged.taskId, "task_lucky_123");
  assert.equal(merged.meta.taskId, "task_lucky_123");
  assert.equal(merged.meta.requestId, "request-1");
  assert.equal(merged.meta.promptVersion, 2);
  assert.equal(merged.status, "running");
  assert.equal(merged.submissionState, "submitted");
});

test("video task merge accepts a newer provider task id", () => {
  const merged = mergeWorkflowVideoTaskRecord({
    id: "video-1",
    status: "running",
    submissionState: "submitting",
    updatedAt: "2026-07-21T10:00:00.000Z",
  }, {
    id: "video-1",
    taskId: "task_lucky_456",
    status: "running",
    submissionState: "submitted",
    updatedAt: "2026-07-21T10:00:01.000Z",
  });

  assert.equal(merged.taskId, "task_lucky_456");
  assert.equal(merged.submissionState, "submitted");
});
