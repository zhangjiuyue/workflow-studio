import assert from "node:assert/strict";
import test from "node:test";

import {
  findWorkflowVideoResultInList,
  mergeWorkflowVideoResultLists,
  removeWorkflowVideoResultInstances,
  upsertWorkflowVideoResult,
  workflowRunForRefresh,
  workflowVideoResultsHaveActiveTask,
} from "./workflow-video-results.mjs";

test("a second generation for the same storyboard remains an independent task", () => {
  const first = { id: "local-1", timelineItemId: "segment-1", taskId: "task-1", status: "running" };
  const second = { id: "local-2", timelineItemId: "segment-1", taskId: "task-2", status: "running" };

  const results = upsertWorkflowVideoResult([first], second);

  assert.equal(results.length, 2);
  assert.deepEqual(results.map((video) => video.taskId), ["task-1", "task-2"]);
});

test("polling updates only the matching task instance", () => {
  const first = { id: "local-1", timelineItemId: "segment-1", taskId: "task-1", status: "running" };
  const second = { id: "local-2", timelineItemId: "segment-1", taskId: "task-2", status: "running" };

  const results = upsertWorkflowVideoResult([first, second], {
    ...second,
    status: "done",
    videoUrl: "https://example.com/task-2.mp4",
    updatedAt: "2026-07-20T08:00:00.000Z",
  });

  assert.equal(results[0], first);
  assert.equal(results[1].taskId, "task-2");
  assert.equal(results[1].status, "done");
});

test("an older persistence snapshot cannot remove a concurrently added task", () => {
  const first = { id: "local-1", timelineItemId: "segment-1", updatedAt: "2026-07-20T08:00:00.000Z" };
  const second = { id: "local-2", timelineItemId: "segment-2", updatedAt: "2026-07-20T08:00:01.000Z" };

  const merged = mergeWorkflowVideoResultLists([first, second], [{ ...first, status: "running" }]);

  assert.equal(merged.length, 2);
  assert.equal(findWorkflowVideoResultInList(merged, second), second);
});

test("an explicit removal deletes only the selected task instance", () => {
  const first = { id: "local-1", timelineItemId: "segment-1", taskId: "task-1" };
  const second = { id: "local-2", timelineItemId: "segment-1", taskId: "task-2" };

  const remaining = removeWorkflowVideoResultInstances([first, second], [second]);

  assert.deepEqual(remaining, [first]);
});

test("only genuinely active video tasks keep workflow mutations locked", () => {
  assert.equal(workflowVideoResultsHaveActiveTask([
    { id: "done", status: "done", videoUrl: "https://example.com/done.mp4" },
    { id: "failed", status: "error" },
  ]), false);
  assert.equal(workflowVideoResultsHaveActiveTask([
    { id: "done", status: "done", videoUrl: "https://example.com/done.mp4" },
    { id: "queued", status: "queued" },
  ]), true);
});

test("a stale or tied background refresh cannot roll back the current run", () => {
  const current = { id: "run-1", updatedAt: "2026-07-20T08:00:02.000Z", result: { videoResults: [1, 2] } };
  const stale = { id: "run-1", updatedAt: "2026-07-20T08:00:01.000Z", result: { videoResults: [1] } };
  const tied = { id: "run-1", updatedAt: current.updatedAt, result: { videoResults: [1] } };
  const newer = { id: "run-1", updatedAt: "2026-07-20T08:00:03.000Z", result: { videoResults: [1, 2, 3] } };

  assert.equal(workflowRunForRefresh(current, stale), current);
  assert.equal(workflowRunForRefresh(current, tied), current);
  assert.equal(workflowRunForRefresh(current, newer), newer);
});
