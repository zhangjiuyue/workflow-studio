import { httpError } from "../http.js";
import { listAssets } from "./asset-store.js";

const ASSET_TYPE_LABELS = {
  "writing-style": "文风",
  "visual-style": "图风",
  script: "脚本",
  role: "角色",
  hook: "爆款开头",
  element: "爆款元素",
  product: "产品",
};

const DIRECT_ASSET_KEYS = {
  "writing-style": ["writingStyleId", "writingStyleAssetId"],
  "visual-style": ["visualStyleId", "visualStyleAssetId"],
  script: ["scriptAssetId"],
  role: ["roleAssetId"],
  hook: ["hookAssetId"],
  element: ["elementAssetId", "elementAssetIds"],
  product: ["productAssetId"],
};

const ECOMMERCE_ASSET_KEYS = {
  script: "scripts",
  role: "roles",
  product: "products",
  hook: "hooks",
  element: "elements",
};

export async function assertWorkflowResourcesAccessible(userId, workflowConfig = {}, config, assetTypes = []) {
  const requestedTypes = new Set(assetTypes.filter(Boolean));
  const references = collectWorkflowAssetReferences(workflowConfig)
    .filter((reference) => !requestedTypes.size || requestedTypes.has(reference.type));
  if (!references.length) return;

  const uniqueTypes = [...new Set(references.map((reference) => reference.type))];
  const visibleByType = new Map(await Promise.all(uniqueTypes.map(async (type) => {
    const data = await listAssets(userId, type, config);
    return [type, Array.isArray(data.assets) ? data.assets : []];
  })));

  const missing = dedupeReferences(references).filter((reference) => {
    const visibleAssets = visibleByType.get(reference.type) || [];
    return !visibleAssets.some((asset) => assetMatchesReference(asset, reference));
  });
  if (!missing.length) return;

  const labels = missing
    .slice(0, 5)
    .map((reference) => `${ASSET_TYPE_LABELS[reference.type] || reference.type}「${reference.name || reference.id}」`)
    .join("、");
  throw httpError(403, `团队资源不可用：${labels}。请重新选择个人资源或当前团队可用资源后再运行。`, {
    code: "TEAM_RESOURCE_UNAVAILABLE",
    resources: missing,
  });
}

function collectWorkflowAssetReferences(workflow = {}) {
  const config = workflow.config && typeof workflow.config === "object" ? workflow.config : workflow;
  const references = [];

  Object.entries(DIRECT_ASSET_KEYS).forEach(([type, keys]) => {
    keys.forEach((key) => {
      normalizeList(config[key]).forEach((id) => {
        if (id && !isSystemAssetReference(id)) {
          references.push({ type, id, name: "", source: key, requiresLiveLookup: true });
        }
      });
    });
  });

  const ecommerceAssets = config.ecommerceAssets && typeof config.ecommerceAssets === "object" ? config.ecommerceAssets : {};
  Object.entries(ECOMMERCE_ASSET_KEYS).forEach(([type, key]) => {
    normalizeList(ecommerceAssets[key]).forEach((item) => {
      const reference = referenceFromAssetSnapshot(type, item, `ecommerceAssets.${key}`);
      if (reference) references.push(reference);
    });
  });

  collectNestedTeamAssetReferences(config).forEach((reference) => references.push(reference));
  return references;
}

function referenceFromAssetSnapshot(type, item, source) {
  if (!item) return null;
  if (typeof item === "string") return null;
  if (typeof item !== "object") return null;
  const id = normalizeId(item.id || item.assetId);
  if (!id) return null;
  const teamMarked = Boolean(item.teamId || item.scope === "team" || item.shared || item.teamRole);
  if (!teamMarked) return null;
  return {
    type,
    id,
    name: normalizeId(item.name || item.title || item.label),
    source,
    teamId: normalizeId(item.teamId),
  };
}

function collectNestedTeamAssetReferences(value, source = "config", output = []) {
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectNestedTeamAssetReferences(item, `${source}.${index}`, output));
    return output;
  }
  const type = normalizeAssetType(value.type || value.assetType || value.category || value.libraryType);
  const id = normalizeId(value.id || value.assetId);
  if (id && type && (value.teamId || value.scope === "team")) {
    output.push({
      type,
      id,
      name: normalizeId(value.name || value.title || value.label),
      source,
      teamId: normalizeId(value.teamId),
    });
  }
  Object.entries(value).forEach(([key, child]) => {
    if (key === "payload" || key === "config" || key === "result") return;
    collectNestedTeamAssetReferences(child, `${source}.${key}`, output);
  });
  return output;
}

function normalizeAssetType(value = "") {
  const type = normalizeId(value);
  if (type === "writingStyle") return "writing-style";
  if (type === "visualStyle") return "visual-style";
  if (ASSET_TYPE_LABELS[type]) return type;
  return "";
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.flatMap(normalizeList);
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function isSystemAssetReference(id = "") {
  return normalizeId(id).startsWith("system-");
}

function assetMatchesReference(asset = {}, reference = {}) {
  const id = normalizeId(reference.id);
  if (!id) return false;
  return normalizeId(asset.id) === id || normalizeId(asset.name) === id || normalizeId(asset.payload?.name) === id;
}

function dedupeReferences(references = []) {
  const seen = new Set();
  return references.filter((reference) => {
    const key = `${reference.type}:${reference.id || reference.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeId(value = "") {
  return String(value || "").trim();
}
