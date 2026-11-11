import { normalizeYoutubeVideoUrl } from "./youtube-video-url.mjs";

export function workflowVideoSourceIdentity(value = {}) {
  const source = objectValue(value);
  const sourceFile = objectValue(source.sourceFile);
  const youtubeUrl = normalizeYoutubeVideoUrl(sourceFile.sourceUrl || sourceFile.fileUrl || "");
  if (youtubeUrl) return `youtube:${youtubeUrl}`;
  const uploadedKey = String(sourceFile.fileKey || sourceFile.fileUrl || "").trim();
  return uploadedKey ? `upload:${uploadedKey}` : "";
}

export function canReuseWorkflowVideoAnalysis({
  existingSource = {},
  nextSource = {},
  scriptAsset = null,
  analysisConfigChanged = false,
  saveToScriptLibrary = false,
} = {}) {
  const existingIdentity = workflowVideoSourceIdentity(existingSource);
  const nextIdentity = workflowVideoSourceIdentity(nextSource);
  const existing = objectValue(existingSource);
  const asset = objectValue(scriptAsset);
  const saveAlreadySatisfied = !saveToScriptLibrary || Boolean(String(existing.scriptAssetId || "").trim());
  return Boolean(
    existingIdentity
    && existingIdentity === nextIdentity
    && existing.analysisStatus === "done"
    && String(asset.prompt || "").trim()
    && !analysisConfigChanged
    && saveAlreadySatisfied
  );
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
