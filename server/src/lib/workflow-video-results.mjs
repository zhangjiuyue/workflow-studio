function workflowVideoString(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function workflowVideoResultInstanceId(video = {}) {
  return workflowVideoString(video?.id || video?.resultId || video?.taskId || video?.meta?.taskId);
}

function workflowVideoResultLegacyKey(video = {}) {
  const timelineItemId = workflowVideoString(video?.timelineItemId);
  if (!timelineItemId) return "";
  const createdAt = workflowVideoString(video?.createdAt || video?.submittedAt);
  const title = workflowVideoString(video?.title);
  return `legacy:${timelineItemId}:${createdAt || title}`;
}

export function workflowVideoResultStorageKey(video = {}) {
  const instanceId = workflowVideoResultInstanceId(video);
  return instanceId ? `instance:${instanceId}` : workflowVideoResultLegacyKey(video);
}

function workflowVideoResultTimestamp(video = {}) {
  const parsed = Date.parse(video?.updatedAt || video?.lastQueriedAt || video?.submittedAt || video?.createdAt || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function mergeWorkflowVideoResultRecord(current = {}, incoming = {}) {
  const currentTimestamp = workflowVideoResultTimestamp(current);
  const incomingTimestamp = workflowVideoResultTimestamp(incoming);
  const newer = currentTimestamp > incomingTimestamp ? current : incoming;
  const older = newer === current ? incoming : current;
  return {
    ...older,
    ...newer,
    id: current.id || incoming.id,
    createdAt: current.createdAt || incoming.createdAt,
  };
}

function findWorkflowVideoResultInList(results = [], video = {}) {
  const list = Array.isArray(results) ? results : [];
  const targetInstanceId = workflowVideoResultInstanceId(video);
  if (targetInstanceId) {
    return list.find((item) => workflowVideoResultInstanceId(item) === targetInstanceId) || null;
  }

  const targetKey = workflowVideoResultLegacyKey(video);
  if (targetKey) {
    const keyedMatch = list.find((item) => workflowVideoResultLegacyKey(item) === targetKey);
    if (keyedMatch) return keyedMatch;
  }

  const timelineItemId = workflowVideoString(video?.timelineItemId);
  if (!timelineItemId) return null;
  const timelineMatches = list.filter((item) => workflowVideoString(item?.timelineItemId) === timelineItemId);
  return timelineMatches.length === 1 ? timelineMatches[0] : null;
}

function upsertWorkflowVideoResult(results = [], nextVideo = {}) {
  const list = Array.isArray(results) ? results : [];
  const current = findWorkflowVideoResultInList(list, nextVideo);
  if (!current) return [...list, nextVideo];
  return list.map((video) => video === current ? mergeWorkflowVideoResultRecord(video, nextVideo) : video);
}

export function mergeWorkflowVideoResultLists(currentResults = [], incomingResults = []) {
  return (Array.isArray(incomingResults) ? incomingResults : []).reduce(
    (results, incoming) => upsertWorkflowVideoResult(results, incoming),
    Array.isArray(currentResults) ? currentResults : [],
  );
}

export function removeWorkflowVideoResultInstances(results = [], removals = []) {
  const removalKeys = new Set(
    (Array.isArray(removals) ? removals : [])
      .map(workflowVideoResultStorageKey)
      .filter(Boolean),
  );
  if (!removalKeys.size) return Array.isArray(results) ? results : [];
  return (Array.isArray(results) ? results : [])
    .filter((video) => !removalKeys.has(workflowVideoResultStorageKey(video)));
}
