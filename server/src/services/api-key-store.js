import crypto from "node:crypto";
import { encryptSecret, decryptSecret } from "../security/crypto.js";
import { httpError } from "../http.js";
import { readStore, writeStore, getStoreDriver } from "../storage/store.js";
import { withPgClient } from "../db/postgres.js";
import { deleteApiKeyPg, getApiKeyPg, listApiKeysPg, upsertApiKeyPg } from "../storage/postgres-repositories.js";
import { recordBackendRequestLog } from "./backend-request-log-store.js";
import { getUserTeamContext } from "./team-store.js";
import {
  CUSTOM_API_CHANNEL,
  CUSTOM_API_STORED_SECRET,
  CUSTOM_API_UNAVAILABLE_MESSAGE,
  applyTrustedApiPolicy,
  isUntrustedApiConfiguration,
} from "./trusted-api-registry.js";

const allowedServiceTypes = new Set(["llm", "image", "video", "audio", "draft"]);

export async function listApiKeys(userId, config) {
  const teamContext = await getUserTeamContext(config, userId);
  const teamId = teamContext.team?.id || "";
  if (isPostgresStore(config)) {
    return (await listApiKeysPg(config, userId, teamId)).map((record) => toPublicRecord(record, config, teamContext));
  }
  return readStore(config).apiKeys
    .filter((record) => (record.userId === userId && !record.teamId) || (teamId && record.teamId === teamId))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map((record) => toPublicRecord(record, config, teamContext));
}

export async function saveApiKey(user, input, config) {
  const normalized = normalizeApiKeyInput(input);
  const teamContext = await getUserTeamContext(config, user.id);
  if (isPostgresStore(config)) return await saveApiKeyPg(user, normalized, config, teamContext);
  const store = readStore(config);
  const now = new Date().toISOString();
  const teamId = teamContext.team?.id || "";
  const previous = normalized.id
    ? store.apiKeys.find((record) => record.id === normalized.id && ((record.userId === user.id && !record.teamId) || (teamId && record.teamId === teamId)))
    : null;
  const teamShared = Boolean(normalized.teamShared || previous?.teamId);
  if (teamShared) assertCanManageTeamApiKeys(teamContext);
  const id = normalized.id || crypto.randomUUID();
  if (!normalized.apiKey && !previous?.encryptedApiKey) {
    throw httpError(400, "请输入 API Key。");
  }
  const encryptedApiKey = isUntrustedApiConfiguration(normalized.channel, normalized.serviceType)
    ? encryptSecret(CUSTOM_API_STORED_SECRET, config.apiKeyEncryptionKey)
    : normalized.apiKey
      ? encryptSecret(normalized.apiKey, config.apiKeyEncryptionKey)
      : previous?.encryptedApiKey;

  const record = {
    ...previous,
    ...normalized,
    id,
    userId: teamShared ? teamContext.team.ownerUserId : user.id,
    teamId: teamShared ? teamId : "",
    encryptedApiKey,
    createdAt: previous?.createdAt || now,
    updatedAt: now,
  };
  delete record.apiKey;
  if (previous) {
    store.apiKeys = store.apiKeys.map((item) => (item === previous ? record : item));
  } else {
    store.apiKeys.unshift(record);
  }
  writeStore(config, store);
  const publicRecord = toPublicRecord(record, config, teamContext);
  await recordCustomChannelEvent(config, user, record, "save", 200);
  return publicRecord;
}

export async function deleteApiKey(user, id, config) {
  const teamContext = await getUserTeamContext(config, user.id);
  const teamId = teamContext.team?.id || "";
  if (isPostgresStore(config)) {
    const previous = await getApiKeyPg(config, user.id, id, teamId);
    if (previous?.teamId) assertCanManageTeamApiKeys(teamContext);
    const deleteUserId = previous?.teamId ? teamContext.team.ownerUserId : user.id;
    return await deleteApiKeyPg(config, deleteUserId, id, previous?.teamId || "");
  }
  const store = readStore(config);
  const previous = store.apiKeys.find((record) => record.id === id && ((record.userId === user.id && !record.teamId) || (teamId && record.teamId === teamId)));
  if (previous?.teamId) assertCanManageTeamApiKeys(teamContext);
  const before = store.apiKeys.length;
  store.apiKeys = store.apiKeys.filter((record) => record !== previous);
  writeStore(config, store);
  return store.apiKeys.length !== before;
}

export async function getDecryptedApiKey(userId, id, config) {
  const teamContext = await getUserTeamContext(config, userId);
  const teamId = teamContext.team?.id || "";
  if (isPostgresStore(config)) {
    const record = await getApiKeyPg(config, userId, id, teamId);
    if (!record) return null;
    if (isUntrustedApiRecord(record)) {
      await recordCustomChannelEvent(config, { id: userId }, record, "call", 503);
      throw httpError(503, CUSTOM_API_UNAVAILABLE_MESSAGE);
    }
    return {
      ...toPublicRecord(record, config, teamContext),
      apiKey: decryptSecret(record.encryptedApiKey, config.apiKeyEncryptionKey),
      billingUserId: record.teamId ? teamContext.team?.ownerUserId || record.userId : record.userId,
    };
  }
  const record = readStore(config).apiKeys.find((item) => item.id === id && ((item.userId === userId && !item.teamId) || (teamId && item.teamId === teamId)));
  if (!record) return null;
  if (isUntrustedApiRecord(record)) {
    await recordCustomChannelEvent(config, { id: userId }, record, "call", 503);
    throw httpError(503, CUSTOM_API_UNAVAILABLE_MESSAGE);
  }
  return {
    ...toPublicRecord(record, config, teamContext),
    apiKey: decryptSecret(record.encryptedApiKey, config.apiKeyEncryptionKey),
    billingUserId: record.teamId ? teamContext.team?.ownerUserId || record.userId : record.userId,
  };
}

async function saveApiKeyPg(user, normalized, config, teamContext) {
  const now = new Date().toISOString();
  const teamId = teamContext.team?.id || "";
  const previous = normalized.id ? await getApiKeyPg(config, user.id, normalized.id, teamId) : null;
  const teamShared = Boolean(normalized.teamShared || previous?.teamId);
  if (teamShared) assertCanManageTeamApiKeys(teamContext);
  const id = normalized.id || crypto.randomUUID();
  if (!normalized.apiKey && !previous?.encryptedApiKey) {
    throw httpError(400, "请输入 API Key。");
  }
  const encryptedApiKey = isUntrustedApiConfiguration(normalized.channel, normalized.serviceType)
    ? encryptSecret(CUSTOM_API_STORED_SECRET, config.apiKeyEncryptionKey)
    : normalized.apiKey
      ? encryptSecret(normalized.apiKey, config.apiKeyEncryptionKey)
      : previous?.encryptedApiKey;

  const record = {
    ...previous,
    ...normalized,
    id,
    userId: teamShared ? teamContext.team.ownerUserId : user.id,
    teamId: teamShared ? teamId : "",
    encryptedApiKey,
    createdAt: previous?.createdAt || now,
    updatedAt: now,
  };
  delete record.apiKey;
  if (record.serviceType === "draft") await ensureDraftServiceTypeAllowed(config);
  const saved = await upsertApiKeyPg(config, record).catch(async (error) => {
    if (isApiKeyServiceTypeConstraintError(error)) {
      await ensureDraftServiceTypeAllowed(config);
      return await upsertApiKeyPg(config, record);
    }
    throw error;
  });
  if (!saved) throw httpError(404, "API Key 不存在或无权修改。");
  const publicRecord = toPublicRecord(saved, config, teamContext);
  await recordCustomChannelEvent(config, user, saved, "save", 200);
  return publicRecord;
}

function normalizeApiKeyInput(input = {}) {
  const serviceType = String(input.serviceType || "").trim();
  const channel = String(input.channel || "").trim();
  if (!serviceType) throw httpError(400, "请选择服务类型。");
  if (!allowedServiceTypes.has(serviceType)) throw httpError(400, "不支持的服务类型。");
  if (!channel) throw httpError(400, "请选择渠道。");
  const endpoint = String(input.endpoint || "").trim();
  if (isUntrustedApiConfiguration(channel, serviceType) && !isHttpsEndpoint(endpoint)) {
    throw httpError(400, "自定义渠道接口地址只支持 HTTPS 开头的地址。");
  }
  return applyTrustedApiPolicy({
    id: String(input.id || "").trim(),
    serviceType,
    channel,
    apiKey: String(input.apiKey || "").trim(),
    endpoint,
    model: String(input.model || "").trim(),
    authType: String(input.authType || "Bearer").trim(),
    protocol: String(input.protocol || "").trim(),
    teamShared: Boolean(input.teamShared || input.scope === "team" || input.teamId),
  });
}

function toPublicRecord(record, config, teamContext = null) {
  const securedRecord = applyTrustedApiPolicy({ ...record, serviceType: publicServiceType(record) });
  const isTeam = Boolean(securedRecord.teamId);
  const role = isTeam && teamContext?.team?.id === securedRecord.teamId ? teamContext.role : "none";
  return {
    id: securedRecord.id,
    scope: isTeam ? "team" : "personal",
    teamId: securedRecord.teamId || "",
    teamRole: role,
    shared: isTeam,
    canManage: !isTeam || role === "owner",
    serviceType: publicServiceType(securedRecord),
    channel: securedRecord.channel,
    endpoint: securedRecord.endpoint,
    model: securedRecord.model,
    modelOptions: securedRecord.modelOptions || [],
    authType: securedRecord.authType,
    protocol: securedRecord.protocol,
    keyPreview: isUntrustedApiRecord(securedRecord)
      ? "********"
      : maskSecret(decryptSecret(record.encryptedApiKey, config.apiKeyEncryptionKey)),
    createdAt: securedRecord.createdAt,
    updatedAt: securedRecord.updatedAt,
    storedOnServer: true,
  };
}

function isHttpsEndpoint(value = "") {
  try {
    const endpoint = new URL(String(value || "").trim());
    return endpoint.protocol === "https:" && Boolean(endpoint.hostname);
  } catch {
    return false;
  }
}

async function recordCustomChannelEvent(config, user, record, event, statusCode) {
  if (!isUntrustedApiRecord(record)) return;
  try {
    await recordBackendRequestLog(config, {
      user,
      endpointPath: event === "save" ? "/api/api-keys" : "/api/custom-channel",
      method: "POST",
      statusCode,
      provider: CUSTOM_API_CHANNEL,
      model: record.model || "",
      taskType: event === "save" ? "custom-channel-save" : "custom-channel-call",
      errorMessage: event === "call" ? CUSTOM_API_UNAVAILABLE_MESSAGE : "",
      requestSummary: {
        event,
        attemptedChannel: String(record.channel || "").trim(),
        endpointOrigin: customEndpointOrigin(record.endpoint),
      },
    });
  } catch (error) {
    console.warn("[api-key-store] custom channel event log failed", {
      event,
      userId: user?.id || "",
      message: error?.message || String(error),
    });
  }
}

function isUntrustedApiRecord(record = {}) {
  return isUntrustedApiConfiguration(record.channel, publicServiceType(record));
}

function customEndpointOrigin(value = "") {
  try {
    return new URL(String(value || "").trim()).origin;
  } catch {
    return "";
  }
}

function assertCanManageTeamApiKeys(teamContext) {
  if (!teamContext?.team || teamContext.role !== "owner") {
    throw httpError(403, "只有团队所有者可以管理团队 API Key。");
  }
}

function publicServiceType(record = {}) {
  return record.serviceType;
}


function maskSecret(secret) {
  if (!secret) return "未填写";
  if (secret.length <= 10) return `${secret.slice(0, 2)}****`;
  return `${secret.slice(0, 4)}**** ****${secret.slice(-4)}`;
}

function isPostgresStore(config) {
  return getStoreDriver(config) === "postgres";
}

function isApiKeyServiceTypeConstraintError(error) {
  return (error?.code === "23514" && String(error?.constraint || "").includes("api_keys_service_type_check"))
    || String(error?.message || "").includes("api_keys_service_type_check");
}

async function ensureDraftServiceTypeAllowed(config) {
  await withPgClient(config, async (client) => {
    await client.query("alter table api_keys drop constraint if exists api_keys_service_type_check");
    await client.query(`
      alter table api_keys
      add constraint api_keys_service_type_check
      check (service_type in ('llm', 'image', 'video', 'audio', 'draft'))
    `);
  });
}
