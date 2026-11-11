const latinFileNameCollator = new Intl.Collator("en-US", {
  numeric: true,
  sensitivity: "base",
});

const pinyinFileNameCollator = new Intl.Collator("zh-CN-u-co-pinyin", {
  numeric: true,
  sensitivity: "base",
});

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
function defaultWorkflowVideoAssetFileName(asset = {}) {
  return String(asset?.title || asset?.name || asset?.roleKey || asset?.sceneMapping || "");
}

function workflowVideoFileNameGroup(fileName = "") {
  return /^[A-Za-z0-9]/.test(String(fileName).trim()) ? 0 : 1;
}
