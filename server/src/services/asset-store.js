import crypto from "node:crypto";
import { httpError } from "../http.js";
import { readStore, writeStore, getStoreDriver } from "../storage/store.js";
import {
  countAssetsPg,
  deleteAssetGroupPg,
  deleteAssetPg,
  getAssetGroupPg,
  getAssetPg,
  listAssetsPg,
  listWorkflowRunsPg,
  listWorkflowsPg,
  upsertAssetGroupPg,
  upsertAssetPg,
} from "../storage/postgres-repositories.js";
import { getUserTeamContext } from "./team-store.js";

const INTERNAL_ASSET_TYPES = new Set(["tool-task"]);
const VALID_ASSET_TYPES = new Set([
  "writing-style",
  "prompt",
  "image-library",
  "music",
  "visual-style",
  "script",
  "role",
  "hook",
  "element",
  "product",
  ...INTERNAL_ASSET_TYPES,
]);

export async function listAssets(userId, type, config) {
  const normalizedType = normalizeAssetType(type);
  const teamContext = await getUserTeamContext(config, userId);
  const teamId = teamContext.team?.id || "";
  if (isPostgresStore(config)) {
    const data = await listAssetsPg(config, userId, normalizedType, teamId);
    return {
      groups: data.groups.map(publicGroup),
      assets: data.assets.map((asset) => publicAsset(asset, teamContext)),
    };
  }
  const store = readStore(config);
  const visibleAssets = store.assets
    .filter((asset) => asset.type === normalizedType)
    .filter((asset) => isVisibleAssetForUser(asset, userId, teamId));
  return {
    groups: store.assetGroups
      .filter((group) => group.userId === userId && group.type === normalizedType)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(publicGroup),
    assets: visibleAssets
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((asset) => publicAsset(asset, teamContext)),
  };
}

export async function saveAsset(user, type, input, config) {
  const normalizedType = normalizeAssetType(type);
  if (isPostgresStore(config)) return await saveAssetPg(user, normalizedType, input, config);
  const store = readStore(config);
  const now = new Date().toISOString();
  const id = normalizeId(input.id) || crypto.randomUUID();
  const teamContext = await getUserTeamContext(config, user.id);
  const previous = store.assets.find((asset) => asset.id === id && asset.type === normalizedType && isVisibleAssetForUser(asset, user.id, teamContext.team?.id || ""));
  const teamState = resolveAssetTeamState(user, input, previous, teamContext);
  if (previous) assertCanSaveAsset(previous, user.id, teamContext);
  if (!previous && teamState.scope === "personal") assertAssetQuota(user, store, normalizedType);
  const payload = normalizeObject(input.payload || input.data || {});
  const storedPayload = payloadWithTeamState(payload, teamState);
  const record = {
    id,
    userId: previous?.userId || user.id,
    type: normalizedType,
    groupId: normalizeId(input.groupId || payload.groupId),
    name: requiredText(input.name || payload.name, "请填写资产名称。"),
    payload: storedPayload,
    teamId: teamState.teamId,
    scope: teamState.scope,
    reviewStatus: teamState.reviewStatus,
    submittedByUserId: teamState.submittedByUserId,
    reviewedByUserId: teamState.reviewedByUserId,
    reviewedAt: teamState.reviewedAt,
    createdAt: previous?.createdAt || input.createdAt || now,
    updatedAt: now,
  };
  if (previous) {
    store.assets = store.assets.map((asset) => (asset.id === id && asset.type === normalizedType ? record : asset));
  } else {
    store.assets.unshift(record);
  }
  writeStore(config, store);
  return publicAsset(record, teamContext);
}

export async function deleteAsset(userId, type, id, config) {
  const normalizedType = normalizeAssetType(type);
  const teamContext = await getUserTeamContext(config, userId);
  const teamId = teamContext.team?.id || "";
  const existing = isPostgresStore(config)
    ? await getAssetPg(config, userId, normalizedType, id, teamId)
    : readStore(config).assets.find((asset) => asset.id === id && asset.type === normalizedType && isVisibleAssetForUser(asset, userId, teamId));
  if (!existing) throw httpError(404, "资产不存在。");
  assertCanDeleteAsset(existing, userId, teamContext);
  if (!isTeamApprovedAsset(existing)) {
    await assertAssetNotReferencedByWorkflows(userId, normalizedType, id, config);
  }
  if (isPostgresStore(config)) return await deleteAssetPg(config, userId, normalizedType, id, teamId);
  const store = readStore(config);
  const before = store.assets.length;
  store.assets = store.assets.filter((asset) => !(asset.id === id && asset.type === normalizedType));
  writeStore(config, store);
  return { id, deleted: before !== store.assets.length };
}

export async function saveAssetGroup(user, type, input, config) {
  const normalizedType = normalizeAssetType(type);
  if (isPostgresStore(config)) return await saveAssetGroupPg(user, normalizedType, input, config);
  const store = readStore(config);
  const now = new Date().toISOString();
  const id = normalizeId(input.id) || crypto.randomUUID();
  const previous = store.assetGroups.find((group) => group.id === id && group.userId === user.id && group.type === normalizedType);
  const record = {
    id,
    userId: user.id,
    type: normalizedType,
    name: requiredText(input.name, "请填写分组名称。"),
    desc: String(input.desc || "").trim(),
    createdAt: previous?.createdAt || input.createdAt || now,
    updatedAt: now,
  };
  if (previous) {
    store.assetGroups = store.assetGroups.map((group) => (group.id === id && group.userId === user.id ? record : group));
  } else {
    store.assetGroups.push(record);
  }
  writeStore(config, store);
  return publicGroup(record);
}

export async function deleteAssetGroup(userId, type, id, config) {
  const normalizedType = normalizeAssetType(type);
  if (isPostgresStore(config)) return await deleteAssetGroupPg(config, userId, normalizedType, id);
  const store = readStore(config);
  const before = store.assetGroups.length;
  store.assetGroups = store.assetGroups.filter((group) => !(group.id === id && group.userId === userId && group.type === normalizedType));
  store.assets = store.assets.map((asset) =>
    asset.userId === userId && asset.type === normalizedType && asset.groupId === id
      ? { ...asset, groupId: "", updatedAt: new Date().toISOString() }
      : asset
  );
  writeStore(config, store);
  return { id, deleted: before !== store.assetGroups.length };
}

async function saveAssetPg(user, normalizedType, input, config) {
  const now = new Date().toISOString();
  const id = normalizeId(input.id) || crypto.randomUUID();
  const teamContext = await getUserTeamContext(config, user.id);
  const previous = await getAssetPg(config, user.id, normalizedType, id, teamContext.team?.id || "");
  const teamState = resolveAssetTeamState(user, input, previous, teamContext);
  if (previous) assertCanSaveAsset(previous, user.id, teamContext);
  if (!previous && teamState.scope === "personal") await assertAssetQuotaPg(user, config, normalizedType);
  const payload = normalizeObject(input.payload || input.data || {});
  const storedPayload = payloadWithTeamState(payload, teamState);
  const record = {
    id,
    userId: previous?.userId || user.id,
    type: normalizedType,
    groupId: normalizeId(input.groupId || payload.groupId),
    name: requiredText(input.name || payload.name, "请填写资产名称。"),
    payload: storedPayload,
    fileUrl: String(input.fileUrl || payload.fileUrl || "").trim(),
    fileKey: String(input.fileKey || payload.fileKey || "").trim(),
    mimeType: String(input.mimeType || payload.mimeType || "").trim(),
    sizeBytes: Number(input.sizeBytes || payload.sizeBytes || 0),
    teamId: teamState.teamId,
    scope: teamState.scope,
    reviewStatus: teamState.reviewStatus,
    submittedByUserId: teamState.submittedByUserId,
    reviewedByUserId: teamState.reviewedByUserId,
    reviewedAt: teamState.reviewedAt,
    createdAt: previous?.createdAt || input.createdAt || now,
    updatedAt: now,
  };
  const saved = await upsertAssetPg(config, record);
  if (!saved) throw httpError(404, "资产不存在或无权修改。");
  return publicAsset(saved, teamContext);
}

async function saveAssetGroupPg(user, normalizedType, input, config) {
  const now = new Date().toISOString();
  const id = normalizeId(input.id) || crypto.randomUUID();
  const previous = await getAssetGroupPg(config, user.id, normalizedType, id);
  const record = {
    id,
    userId: user.id,
    type: normalizedType,
    name: requiredText(input.name, "请填写分组名称。"),
    desc: String(input.desc || "").trim(),
    createdAt: previous?.createdAt || input.createdAt || now,
    updatedAt: now,
  };
  const saved = await upsertAssetGroupPg(config, record);
  if (!saved) throw httpError(404, "分组不存在或无权修改。");
  return publicGroup(saved);
}

function assertAssetQuota(user, store, type) {
  if (INTERNAL_ASSET_TYPES.has(type)) return;
  if (user.role === "admin") return;
  const limit = Number(user.membership?.assetLimitPerType || 0);
  if (!limit) return;
  const count = store.assets.filter((asset) => asset.userId === user.id && asset.type === type).length;
  if (count >= limit) {
    throw httpError(403, `当前会员每类创意资产最多可保存 ${limit} 个。`, {
      code: "ASSET_LIMIT_REACHED",
      limit,
      count,
      type,
    });
  }
}

async function assertAssetQuotaPg(user, config, type) {
  if (INTERNAL_ASSET_TYPES.has(type)) return;
  if (user.role === "admin") return;
  const limit = Number(user.membership?.assetLimitPerType || 0);
  if (!limit) return;
  const count = await countAssetsPg(config, user.id, type);
  if (count >= limit) {
    throw httpError(403, `当前会员每类创意资产最多可保存 ${limit} 个。`, {
      code: "ASSET_LIMIT_REACHED",
      limit,
      count,
      type,
    });
  }
}

async function assertAssetNotReferencedByWorkflows(userId, type, id, config) {
  if (INTERNAL_ASSET_TYPES.has(type)) return;
  const assetId = normalizeId(id);
  if (!assetId) return;
  const references = isPostgresStore(config)
    ? await workflowReferencesForAssetPg(userId, type, assetId, config)
    : workflowReferencesForAssetJson(userId, type, assetId, config);
  if (!references.length) return;
  const names = references.map((workflow) => `「${workflow.name || "未命名工作流"}」`).join("、");
  throw httpError(409, `无法删除该资产：已被工作流 ${names} 引用。请先删除引用它的工作流，再删除资产。`, {
    code: "ASSET_REFERENCED_BY_WORKFLOW",
    references,
  });
}

function workflowReferencesForAssetJson(userId, type, id, config) {
  const store = readStore(config);
  const workflows = (store.workflows || []).filter((workflow) => workflow.userId === userId);
  const runs = (store.workflowRuns || []).filter((run) => run.userId === userId && run.status !== "deleted");
  return workflowReferencesForAsset(workflows, runs, type, id);
}

async function workflowReferencesForAssetPg(userId, type, id, config) {
  const [workflows, runs] = await Promise.all([
    listWorkflowsPg(config, userId),
    listWorkflowRunsPg(config, userId),
  ]);
  return workflowReferencesForAsset(workflows, runs.filter((run) => run.status !== "deleted"), type, id);
}

function workflowReferencesForAsset(workflows = [], runs = [], type, id) {
  const references = [];
  for (const workflow of workflows) {
    const candidates = [
      normalizeObject(workflow.config),
      ...runs
        .filter((run) => run.workflowId === workflow.id)
        .map((run) => workflowSnapshotFromRun(run)),
    ];
    if (candidates.some((candidate) => workflowConfigReferencesAsset(candidate, type, id))) {
      references.push({
        id: workflow.id,
        name: workflow.name || workflow.config?.name || "",
      });
    }
  }
  return references;
}

function workflowSnapshotFromRun(run = {}) {
  const result = normalizeObject(run.result);
  return normalizeObject(result.workflowSnapshot || result.workflowConfig || run.workflowSnapshot || run.workflowConfig);
}

const WORKFLOW_ASSET_REFERENCE_KEYS = {
  "writing-style": ["writingStyleId", "writingStyleAssetId"],
  prompt: ["promptAssetId", "promptAssetIds", "scriptPromptAssetId"],
  "image-library": ["imageLibraryId", "imageLibraryAssetId", "imageAssetId", "imageAssetIds"],
  music: ["musicAssetId", "musicAssetIds", "backgroundMusicAssetId", "bgmAssetId"],
  "visual-style": ["visualStyleId", "visualStyleAssetId"],
  script: ["scriptAssetId"],
  role: ["roleAssetId"],
  hook: ["hookAssetId"],
  element: ["elementAssetIds"],
  product: ["productAssetId"],
};

const ECOMMERCE_ASSET_LIST_KEYS = {
  script: ["scripts"],
  role: ["roles"],
  hook: ["hooks"],
  element: ["elements"],
  product: ["products"],
};

function workflowConfigReferencesAsset(config = {}, type, id) {
  if (!config || typeof config !== "object") return false;
  const directKeys = WORKFLOW_ASSET_REFERENCE_KEYS[type] || [];
  if (directKeys.some((key) => idListContains(config[key], id))) return true;
  const ecommerceKeys = ECOMMERCE_ASSET_LIST_KEYS[type] || [];
  if (ecommerceKeys.some((key) => workflowAssetSnapshotReferencesId(config.ecommerceAssets?.[key], type, id))) return true;
  return workflowAssetSnapshotReferencesId(config, type, id);
}

function idListContains(value, id) {
  if (Array.isArray(value)) return value.some((item) => normalizeId(item) === id);
  return normalizeId(value) === id;
}

function workflowAssetSnapshotReferencesId(value, type, id) {
  if (!value) return false;
  if (Array.isArray(value)) return value.some((item) => workflowAssetSnapshotReferencesId(item, type, id));
  if (typeof value !== "object") return false;
  if (normalizeId(value.id || value.assetId) === id && workflowAssetTypeMatches(value, type)) return true;
  return Object.entries(value).some(([key, child]) => {
    if (key === "config" || key === "result" || key === "runs" || key === "children") return false;
    return workflowAssetSnapshotReferencesId(child, type, id);
  });
}

function workflowAssetTypeMatches(value = {}, type) {
  const rawType = normalizeId(value.type || value.assetType || value.category || value.libraryType);
  if (!rawType) return true;
  return rawType === type || rawType === assetTypeAlias(type);
}

function assetTypeAlias(type) {
  if (type === "image-library") return "image";
  if (type === "writing-style") return "writingStyle";
  if (type === "visual-style") return "visualStyle";
  return type;
}

function normalizeAssetType(type) {
  const normalized = String(type || "").trim();
  if (!VALID_ASSET_TYPES.has(normalized)) throw httpError(400, "不支持的资产类型。");
  return normalized;
}

function isVisibleAssetForUser(asset, userId, teamId = "") {
  if (asset.userId === userId && !asset.teamId) return true;
  if (!teamId || asset.teamId !== teamId) return false;
  if (asset.reviewStatus === "approved") return true;
  return asset.userId === userId && ["pending", "rejected"].includes(asset.reviewStatus);
}

function resolveAssetTeamState(user, input = {}, previous = null, teamContext = null) {
  const teamId = teamContext?.team?.id || "";
  const now = new Date().toISOString();
  const previousState = previous ? {
    teamId: previous.teamId || "",
    scope: previous.scope || (previous.teamId ? "team" : "personal"),
    reviewStatus: previous.reviewStatus || "approved",
    submittedByUserId: previous.submittedByUserId || previous.userId || user.id,
    reviewedByUserId: previous.reviewedByUserId || "",
    reviewedAt: previous.reviewedAt || "",
  } : null;
  const wantsOwnerShare = Boolean(input.teamShared || input.shareToTeam);
  const wantsReview = Boolean(input.requestTeamShare || input.teamShareRequested);

  if (wantsOwnerShare) {
    assertTeamOwner(teamContext);
    return {
      teamId,
      scope: "team",
      reviewStatus: "approved",
      submittedByUserId: previousState?.submittedByUserId || user.id,
      reviewedByUserId: user.id,
      reviewedAt: now,
    };
  }

  if (wantsReview) {
    if (!teamContext?.team) throw httpError(403, "需要先加入团队才能申请共享。");
    if (teamContext.role === "owner") {
      return {
        teamId,
        scope: "team",
        reviewStatus: "approved",
        submittedByUserId: previousState?.submittedByUserId || user.id,
        reviewedByUserId: user.id,
        reviewedAt: now,
      };
    }
    return {
      teamId,
      scope: "team",
      reviewStatus: "pending",
      submittedByUserId: previousState?.submittedByUserId || user.id,
      reviewedByUserId: "",
      reviewedAt: "",
    };
  }

  if (previousState?.teamId && previousState.reviewStatus === "approved") return previousState;
  if (previousState?.teamId && previousState.reviewStatus === "pending") return previousState;
  return {
    teamId: "",
    scope: "personal",
    reviewStatus: "approved",
    submittedByUserId: "",
    reviewedByUserId: "",
    reviewedAt: "",
  };
}

function assertCanSaveAsset(previous, userId, teamContext = null) {
  if (!previous?.teamId) return;
  if (previous.reviewStatus === "approved") {
    assertTeamOwner(teamContext);
    return;
  }
  if (previous.userId === userId) return;
  assertTeamOwner(teamContext);
}

function assertCanDeleteAsset(asset, userId, teamContext = null) {
  if (!asset?.teamId) {
    if (asset.userId !== userId) throw httpError(403, "无权删除该资产。");
    return;
  }
  if (asset.reviewStatus === "approved") {
    assertTeamOwner(teamContext);
    return;
  }
  if (asset.userId === userId) return;
  assertTeamOwner(teamContext);
}

function assertTeamOwner(teamContext = null) {
  if (!teamContext?.team || teamContext.role !== "owner") {
    throw httpError(403, "只有团队所有者可以管理团队共享资产。");
  }
}

function isTeamApprovedAsset(asset = {}) {
  return Boolean(asset.teamId && asset.reviewStatus === "approved");
}

function payloadWithTeamState(payload, teamState) {
  return {
    ...payload,
    shared: teamState.scope === "team" && teamState.reviewStatus === "approved",
    teamId: teamState.teamId || "",
    scope: teamState.scope,
    reviewStatus: teamState.reviewStatus,
    teamReviewStatus: teamState.reviewStatus,
  };
}

function publicAsset(asset, teamContext = null) {
  const isTeamAsset = Boolean(asset.teamId);
  const reviewStatus = asset.reviewStatus || "approved";
  const shared = isTeamAsset && reviewStatus === "approved";
  const teamRole = isTeamAsset && teamContext?.team?.id === asset.teamId ? teamContext.role : "none";
  return {
    id: asset.id,
    userId: asset.userId,
    teamId: asset.teamId || "",
    scope: isTeamAsset ? "team" : "personal",
    reviewStatus,
    teamReviewStatus: reviewStatus,
    teamRole,
    shared,
    submittedByUserId: asset.submittedByUserId || "",
    reviewedByUserId: asset.reviewedByUserId || "",
    reviewedAt: asset.reviewedAt || "",
    type: asset.type,
    groupId: asset.groupId,
    name: asset.name,
    payload: asset.payload || {},
    fileUrl: asset.fileUrl || "",
    fileKey: asset.fileKey || "",
    mimeType: asset.mimeType || "",
    sizeBytes: Number(asset.sizeBytes || 0),
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
    storedOnServer: true,
  };
}

function publicGroup(group) {
  return {
    id: group.id,
    type: group.type,
    name: group.name,
    desc: group.desc,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
    storedOnServer: true,
  };
}

function normalizeId(value) {
  return String(value || "").trim();
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function requiredText(value, message) {
  const text = String(value || "").trim();
  if (!text) throw httpError(400, message);
  return text;
}

function isPostgresStore(config) {
  return getStoreDriver(config) === "postgres";
}
