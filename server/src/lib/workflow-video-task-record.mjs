function stringValue(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

export function workflowVideoProviderTaskId(video = {}) {
  return stringValue(video.taskId || video.meta?.taskId);
}

export function mergeWorkflowVideoTaskRecord(current = {}, incoming = {}) {
  const currentUpdatedAt = timestamp(current.updatedAt || current.lastQueriedAt || current.submittedAt || current.createdAt);
  const incomingUpdatedAt = timestamp(incoming.updatedAt || incoming.lastQueriedAt || incoming.submittedAt || incoming.createdAt);
  const currentTaskId = workflowVideoProviderTaskId(current);
  const incomingTaskId = workflowVideoProviderTaskId(incoming);

  if (currentUpdatedAt && incomingUpdatedAt && incomingUpdatedAt < currentUpdatedAt) {
    return { ...current };
  }

  const merged = {
    ...current,
    ...incoming,
    id: current.id || incoming.id,
    createdAt: current.createdAt || incoming.createdAt,
  };
  if (!currentTaskId || incomingTaskId) return merged;

  return {
    ...merged,
    taskId: currentTaskId,
    meta: {
      ...(current.meta && typeof current.meta === "object" ? current.meta : {}),
      ...(incoming.meta && typeof incoming.meta === "object" ? incoming.meta : {}),
      taskId: current.meta?.taskId || currentTaskId,
    },
    status: executionValue(current.status, incoming.status),
    upstreamStatus: executionValue(current.upstreamStatus, incoming.upstreamStatus),
    submissionState: executionValue(current.submissionState, incoming.submissionState),
    submissionErrorKind: executionValue(current.submissionErrorKind, incoming.submissionErrorKind),
    submittedAt: current.submittedAt || incoming.submittedAt,
    videoUrl: current.videoUrl || current.url || incoming.videoUrl || incoming.url || "",
    error: current.error || incoming.error || "",
    message: current.message || incoming.message || "",
    updatedAt: current.updatedAt || incoming.updatedAt,
  };
}

function executionValue(current, incoming) {
  return current === undefined || current === null || current === "" ? incoming : current;
}

function timestamp(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}
