export function workflowTypeFrom(value = null) {
  return String(value?.type || value?.workflowType || value?.config?.type || "").trim();
}

export function isTalkingVideoWorkflow(value = null) {
  return workflowTypeFrom(value) === "explain";
}

export function orderWorkflowStageIds(stageIds = [], workflow = null) {
  const ids = [...stageIds];
  if (!isTalkingVideoWorkflow(workflow)) return ids;

  const ordered = ids.filter((id) => !["outline", "optimize", "audio"].includes(id));
  if (!ids.includes("audio")) return ordered;

  const scriptIndex = ordered.indexOf("script");
  ordered.splice(scriptIndex >= 0 ? scriptIndex + 1 : 0, 0, "audio");
  return ordered;
}

export function workflowSupportsRoleOutfitVariantDetection(workflow = null) {
  return !isTalkingVideoWorkflow(workflow);
}

export function workflowNodeActiveStatus(run = null, nodeId = "") {
  if (!run || !nodeId) return "";
  const activeStatuses = new Set(["running", "queued"]);
  const stageStatus = String(run?.stages?.[nodeId] || "").trim();
  const backendJobs = run?.backendJobs && typeof run.backendJobs === "object"
    ? run.backendJobs
    : run?.result?.backendJobs && typeof run.result.backendJobs === "object"
      ? run.result.backendJobs
      : {};
  const jobStatus = String(backendJobs?.[nodeId]?.status || "").trim();
  if (activeStatuses.has(jobStatus)) return jobStatus;
  if (activeStatuses.has(String(run?.status || "").trim()) && activeStatuses.has(stageStatus)) return stageStatus;
  return "";
}
