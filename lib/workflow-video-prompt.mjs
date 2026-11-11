const latinFileNameCollator = new Intl.Collator("en-US", {
  numeric: true,
  sensitivity: "base",
});

const pinyinFileNameCollator = new Intl.Collator("zh-CN-u-co-pinyin", {
  numeric: true,
  sensitivity: "base",
});

export function workflowVideoTimelineItemId(item = {}, index = 0) {
  return String(item?.id || item?.segmentId || `${item?.shotId || "segment"}-${index}`);
}

export function sortWorkflowVideoAssetsByFileName(assets = [], getFileName = defaultWorkflowVideoAssetFileName) {
  return (Array.isArray(assets) ? assets : [])
    .map((asset, index) => ({
      asset,
      index,
      fileName: String(getFileName(asset, index) || "").trim(),
    }))
    .sort((left, right) => {
      const leftGroup = workflowVideoFileNameGroup(left.fileName);
      const rightGroup = workflowVideoFileNameGroup(right.fileName);
      if (leftGroup !== rightGroup) return leftGroup - rightGroup;
      const collator = leftGroup === 0 ? latinFileNameCollator : pinyinFileNameCollator;
      return collator.compare(left.fileName, right.fileName) || left.index - right.index;
    })
    .map(({ asset }) => asset);
}

export function workflowVideoMaterialFolderName(item = {}, index = 0) {
  const numericShotIds = Array.isArray(item?.shotIds)
    ? item.shotIds.map(positiveWorkflowVideoNumber).filter(Boolean)
    : [];
  const start = [item?.startIndex, numericShotIds[0], item?.index, index + 1]
    .map(positiveWorkflowVideoNumber)
    .find(Boolean) || index + 1;
  const groupSize = positiveWorkflowVideoNumber(item?.groupSize || numericShotIds.length) || 1;
  const end = [item?.endIndex, numericShotIds.at(-1), start + groupSize - 1, start]
    .map(positiveWorkflowVideoNumber)
    .find(Boolean) || start;
  return start === end ? `第${start}镜` : `第${start}-${end}镜`;
}

export function workflowVideoMaterialImagePath({ item = {}, itemIndex = 0, assetName = "", extension = "png" } = {}) {
  const folderName = workflowVideoMaterialFolderName(item, itemIndex);
  const fileName = safeWorkflowVideoDownloadName(assetName, "图片");
  const safeExtension = String(extension || "png").replace(/[^a-z0-9]/gi, "").toLowerCase() || "png";
  return `${folderName}/${fileName}.${safeExtension}`;
}

export function safeWorkflowVideoDownloadName(name = "", fallback = "视频") {
  return String(name || fallback)
    .replace(/[\\/:*?"<>|／]+/g, "-")
    .replace(/\s+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    || fallback;
}

export function buildWorkflowVideoPromptSaveState({ timeline = [], videoResults = [], promptId = "", nextPrompt = "" } = {}) {
  const normalizedPromptId = String(promptId || "");
  const normalizedPrompt = String(nextPrompt || "").trim();
  return {
    videoTimeline: (Array.isArray(timeline) ? timeline : []).map((entry, entryIndex) => (
      workflowVideoTimelineItemId(entry, entryIndex) === normalizedPromptId
        ? { ...entry, videoPrompt: normalizedPrompt }
        : entry
    )),
    videoResults: Array.isArray(videoResults) ? videoResults : [],
  };
}

function defaultWorkflowVideoAssetFileName(asset = {}) {
  return String(asset?.title || asset?.name || asset?.roleKey || asset?.sceneMapping || "");
}

function workflowVideoFileNameGroup(fileName = "") {
  return /^[A-Za-z0-9]/.test(String(fileName).trim()) ? 0 : 1;
}

function positiveWorkflowVideoNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}
