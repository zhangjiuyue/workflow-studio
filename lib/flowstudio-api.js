import { updateProviderModelCatalog } from './provider-model-catalog';
import {
  isMembershipQuotaError,
  membershipQuotaErrorCode,
  membershipQuotaResource,
  MEMBERSHIP_QUOTA_REACHED_EVENT,
} from "./membership-quota.mjs";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://127.0.0.1:18787";
const AUTH_SESSION_META_KEY = "flowstudio-auth-session";
const LOCAL_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const AUTH_SESSION_UPDATED_EVENT = "flowstudio-auth-updated";
export const AUTH_SESSION_CLEARED_EVENT = "flowstudio-auth-cleared";

export async function requestFlowStudioApi(path, options = {}) {
  const isFormData = typeof FormData !== "undefined" && options.body instanceof FormData;
  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      headers: {
        ...(isFormData ? {} : { "Content-Type": "application/json" }),
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      const wrapped = new Error("请求已取消。");
      wrapped.name = "AbortError";
      wrapped.cause = error;
      throw wrapped;
    }
    const message = /failed to fetch|networkerror|load failed/i.test(String(error?.message || error))
      ? "网络连接失败或请求超时。模型请求可能已经提交到渠道侧并产生费用，请稍后刷新状态，避免立刻重复提交。"
      : error?.message || "网络请求失败，请稍后重试。";
    const wrapped = new Error(message);
    wrapped.cause = error;
    throw wrapped;
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.message || `请求失败：${response.status}`);
    error.status = response.status;
    error.payload = payload;
    error.detail = payload.detail || {};
    error.code = membershipQuotaErrorCode(error);
    if (typeof window !== "undefined" && isMembershipQuotaError(error)) {
      window.dispatchEvent(new CustomEvent(MEMBERSHIP_QUOTA_REACHED_EVENT, {
        detail: {
          code: error.code,
          resource: membershipQuotaResource(error),
        },
      }));
    }
    throw error;
  }
  return payload;
}

export async function requestAuthedFlowStudioApi(path, options = {}) {
  const token = readAuthToken();
  if (!token) {
    const error = new Error("请先登录。");
    error.status = 401;
    throw error;
  }
  try {
    return await requestFlowStudioApi(path, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    if (error?.status === 401) clearAuthSession();
    throw error;
  }
}

export async function listApiKeys() {
  const result = await requestAuthedFlowStudioApi("/api/api-keys");
  updateProviderModelCatalog(result.apiKeys || []);
  return {
    ...result,
    apiKeys: Array.isArray(result.apiKeys) ? result.apiKeys.map(normalizeApiKeyRecord) : [],
  };
}

export async function saveApiKey(payload) {
  const result = await requestAuthedFlowStudioApi("/api/api-keys", {
    method: "POST",
    body: JSON.stringify(apiKeySavePayload(payload)),
  });
  return {
    ...result,
    apiKey: result.apiKey ? normalizeApiKeyRecord(result.apiKey) : result.apiKey,
  };
}

export function deleteApiKey(id) {
  return requestAuthedFlowStudioApi(`/api/api-keys/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

function apiKeySavePayload(payload = {}) { return payload; }
function normalizeApiKeyRecord(record = {}) { return record; }
export function listProviderCatalog() { return requestAuthedFlowStudioApi("/api/provider-catalog"); }

export function listWorkflows() {
  return requestAuthedFlowStudioApi("/api/workflows");
}

export function listWorkflowSummaries() {
  return requestAuthedFlowStudioApi("/api/workflows/summary");
}

export function getWorkflow(workflowId) {
  return requestAuthedFlowStudioApi(`/api/workflows/${encodeURIComponent(workflowId)}`);
}

export function createWorkflow(payload) {
  return requestAuthedFlowStudioApi("/api/workflows", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateWorkflow(id, payload) {
  return requestAuthedFlowStudioApi(`/api/workflows/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function deleteWorkflow(id) {
  return requestAuthedFlowStudioApi(`/api/workflows/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function getWorkflowRun(runId) {
  return requestAuthedFlowStudioApi(`/api/workflows/runs/${encodeURIComponent(runId)}`);
}

export function createWorkflowRun(workflowId, payload = {}) {
  return requestAuthedFlowStudioApi(`/api/workflows/${encodeURIComponent(workflowId)}/runs`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateWorkflowRun(runId, payload = {}) {
  return requestAuthedFlowStudioApi(`/api/workflows/runs/${encodeURIComponent(runId)}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function confirmWorkflowTopics(runId, payload = {}, options = {}) {
  return requestAuthedFlowStudioApi(`/api/workflows/runs/${encodeURIComponent(runId)}/topics/confirm`, {
    ...options,
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getWorkflowTopicConfirmationStatus(runId, options = {}) {
  return requestAuthedFlowStudioApi(`/api/workflows/runs/${encodeURIComponent(runId)}/topics/status`, options);
}

export function executeWorkflowTopics(runId, payload = {}, options = {}) {
  return requestAuthedFlowStudioApi(`/api/workflows/runs/${encodeURIComponent(runId)}/topics/execute`, {
    ...options,
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function queueWorkflowNode(runId, nodeId, payload = {}) {
  return requestAuthedFlowStudioApi(`/api/workflows/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/queue`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function createImageZipJob(payload = {}) {
  return requestAuthedFlowStudioApi("/api/tools/image-zip/jobs", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getImageZipJob(jobId) {
  return requestAuthedFlowStudioApi(`/api/tools/image-zip/jobs/${encodeURIComponent(jobId)}`);
}

export function deleteImageZipJob(jobId) {
  return requestAuthedFlowStudioApi(`/api/tools/image-zip/jobs/${encodeURIComponent(jobId)}`, {
    method: "DELETE",
  });
}

export function createFileZipJob(payload = {}) {
  return requestAuthedFlowStudioApi("/api/tools/file-zip/jobs", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getFileZipJob(jobId) {
  return requestAuthedFlowStudioApi(`/api/tools/file-zip/jobs/${encodeURIComponent(jobId)}`);
}

export function deleteFileZipJob(jobId) {
  return requestAuthedFlowStudioApi(`/api/tools/file-zip/jobs/${encodeURIComponent(jobId)}`, {
    method: "DELETE",
  });
}

export async function downloadImageZipJob(downloadPath) {
  const token = readAuthToken();
  const response = await fetch(`${API_BASE_URL}${downloadPath}`, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.message || `图片压缩包下载失败：${response.status}`);
  }
  const disposition = response.headers.get("content-disposition") || "";
  const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/)?.[1];
  const plainName = disposition.match(/filename="?([^";]+)"?/)?.[1];
  return {
    blob: await response.blob(),
    fileName: encodedName ? decodeURIComponent(encodedName) : plainName || "分镜图片.zip",
  };
}

export function buildImageZipDownloadUrl(downloadPath) {
  if (!downloadPath) return "";
  const token = readAuthToken();
  const separator = String(downloadPath).includes("?") ? "&" : "?";
  return `${API_BASE_URL}${downloadPath}${token ? `${separator}authToken=${encodeURIComponent(token)}` : ""}`;
}

export async function downloadToolImage(payload = {}) {
  const token = readAuthToken();
  const response = await fetch(`${API_BASE_URL}/api/tools/image-download`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const errorPayload = await response.json().catch(() => ({}));
    throw new Error(errorPayload.message || `图片下载失败：${response.status}`);
  }
  const disposition = response.headers.get("content-disposition") || "";
  const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/)?.[1];
  const plainName = disposition.match(/filename="?([^";]+)"?/)?.[1];
  return {
    blob: await response.blob(),
    fileName: encodedName ? decodeURIComponent(encodedName) : plainName || payload.fileName || "generated-image.png",
  };
}

export function watermarkToolImage(payload = {}) {
  return requestAuthedFlowStudioApi("/api/tools/image-watermark", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function buildToolImageDownloadUrl(payload = {}) {
  const search = new URLSearchParams();
  const token = readAuthToken();
  if (payload.url) search.set("url", payload.url);
  if (payload.fileName) search.set("fileName", payload.fileName);
  if (token) search.set("authToken", token);
  return `${API_BASE_URL}/api/tools/image-download?${search.toString()}`;
}

export async function downloadToolFile(payload = {}) {
  const token = readAuthToken();
  const response = await fetch(`${API_BASE_URL}/api/tools/file-download`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const errorPayload = await response.json().catch(() => ({}));
    throw new Error(errorPayload.message || `文件下载失败：${response.status}`);
  }
  return {
    blob: await response.blob(),
    fileName: responseDownloadFileName(response, payload.fileName || "download.bin"),
  };
}

export async function downloadToolFileZip(payload = {}) {
  const token = readAuthToken();
  const response = await fetch(`${API_BASE_URL}/api/tools/file-zip`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const errorPayload = await response.json().catch(() => ({}));
    throw new Error(errorPayload.message || `压缩包下载失败：${response.status}`);
  }
  return {
    blob: await response.blob(),
    fileName: responseDownloadFileName(response, payload.fileName || "files.zip"),
  };
}

function responseDownloadFileName(response, fallbackName) {
  const disposition = response.headers.get("content-disposition") || "";
  const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/)?.[1];
  const plainName = disposition.match(/filename="?([^";]+)"?/)?.[1];
  return encodedName ? decodeURIComponent(encodedName) : plainName || fallbackName;
}

export function executeWorkflowNode(runId, nodeId, payload = {}) {
  return requestAuthedFlowStudioApi(`/api/workflows/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/execute`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function listJobs(params = {}) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value) search.set(key, value);
  });
  const suffix = search.toString() ? `?${search.toString()}` : "";
  return requestAuthedFlowStudioApi(`/api/jobs${suffix}`);
}

export function listAdminUsers() {
  return requestAuthedFlowStudioApi("/api/admin/users");
}

export function approveAdminUser(userId, payload = {}) {
  return requestAuthedFlowStudioApi(`/api/admin/users/${encodeURIComponent(userId)}/approve`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function rejectAdminUser(userId) {
  return requestAuthedFlowStudioApi(`/api/admin/users/${encodeURIComponent(userId)}/reject`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function updateAdminMembership(userId, payload = {}) {
  return requestAuthedFlowStudioApi(`/api/admin/users/${encodeURIComponent(userId)}/membership`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function listAdminRunLogs(params = {}) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") search.set(key, value);
  });
  const suffix = search.toString() ? `?${search.toString()}` : "";
  return requestAuthedFlowStudioApi(`/api/admin/run-logs${suffix}`);
}

export function listAdminAudit(params = {}) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") search.set(key, value);
  });
  const suffix = search.toString() ? `?${search.toString()}` : "";
  return requestAuthedFlowStudioApi(`/api/admin/audit${suffix}`);
}

export function getAdminDeploymentCheck() {
  return requestAuthedFlowStudioApi("/api/admin/deployment-check");
}

export function getAdminSystemStatus() {
  return requestAuthedFlowStudioApi("/api/admin/system");
}

export function listAdminTeams() {
  return requestAuthedFlowStudioApi("/api/admin/teams");
}

export function updateAdminTeam(teamId, payload = {}) {
  return requestAuthedFlowStudioApi(`/api/admin/teams/${encodeURIComponent(teamId)}`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getTeamContext() {
  return requestAuthedFlowStudioApi("/api/team");
}

export function createTeam(payload = {}) {
  return requestAuthedFlowStudioApi("/api/team", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function joinTeam(inviteCode) {
  return requestAuthedFlowStudioApi("/api/team/join", {
    method: "POST",
    body: JSON.stringify({ inviteCode }),
  });
}

export function leaveTeam() {
  return requestAuthedFlowStudioApi("/api/team/leave", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function removeTeamMember(userId) {
  return requestAuthedFlowStudioApi(`/api/team/members/${encodeURIComponent(userId)}`, {
    method: "DELETE",
  });
}

export function listTeamReviewAssets() {
  return requestAuthedFlowStudioApi("/api/team/reviews");
}

export function approveTeamAsset(assetId) {
  return requestAuthedFlowStudioApi(`/api/team/reviews/${encodeURIComponent(assetId)}/approve`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function rejectTeamAsset(assetId) {
  return requestAuthedFlowStudioApi(`/api/team/reviews/${encodeURIComponent(assetId)}/reject`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function listAssets(type) {
  return requestAuthedFlowStudioApi(`/api/assets/${encodeURIComponent(type)}`);
}

export function saveAsset(type, payload) {
  return requestAuthedFlowStudioApi(`/api/assets/${encodeURIComponent(type)}`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function queueScriptAssetVideoAnalysis(payload) {
  return requestAuthedFlowStudioApi("/api/assets/script/video-analysis-jobs", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function queueWritingStyleAnalysis(payload) {
  return requestAuthedFlowStudioApi("/api/assets/writing-style/analysis-jobs", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function queueRoleAssetImageGeneration(payload) {
  return requestAuthedFlowStudioApi("/api/assets/role/image-generation-jobs", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function deleteAsset(type, id) {
  return requestAuthedFlowStudioApi(`/api/assets/${encodeURIComponent(type)}/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function listToolTasks() {
  return listAssets("tool-task");
}

export function saveToolTask(task) {
  return saveAsset("tool-task", {
    id: task.id,
    name: task.name || "自由创作任务",
    createdAt: task.createdAt,
    payload: task,
  });
}

export function deleteToolTask(id) {
  return deleteAsset("tool-task", id);
}

export function generateImages(payload) {
  return requestAuthedFlowStudioApi("/api/tools/images", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function generateText(payload) {
  return requestAuthedFlowStudioApi("/api/tools/llm", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function createVideoToolTask(payload) {
  return requestAuthedFlowStudioApi("/api/tools/videos", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function queueWorkflowVideoTasks(runId, payload) {
  return requestAuthedFlowStudioApi(`/api/workflows/runs/${encodeURIComponent(runId)}/videos/queue`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function generateAudio(payload) {
  return requestAuthedFlowStudioApi("/api/tools/audio", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function transcribeAudio(payload) {
  return requestAuthedFlowStudioApi("/api/tools/audio/transcribe", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function queryVideoToolTask(apiKeyId, taskId) {
  return requestAuthedFlowStudioApi(`/api/tools/tasks/${encodeURIComponent(taskId)}?apiKeyId=${encodeURIComponent(apiKeyId)}`);
}

export function saveAssetGroup(type, payload) {
  return requestAuthedFlowStudioApi(`/api/assets/${encodeURIComponent(type)}/groups`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function deleteAssetGroup(type, id) {
  return requestAuthedFlowStudioApi(`/api/assets/${encodeURIComponent(type)}/groups/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function uploadAssetFiles(files) {
  const formData = new FormData();
  Array.from(files || []).forEach((file) => formData.append("files", file));
  return requestAuthedFlowStudioApi("/api/assets/upload", {
    method: "POST",
    body: formData,
  });
}

export function resolveFlowStudioFileUrl(url) {
  const value = String(url || "").trim();
  if (!value || value.startsWith("data:") || value.startsWith("blob:") || /^https?:\/\//i.test(value)) return value;
  if (value.startsWith("/")) return `${API_BASE_URL.replace(/\/+$/g, "")}${value}`;
  return value;
}

export function persistAuthSession(result) {
  if (!result?.token || !result?.user || typeof window === "undefined") return;
  const expiresAt = normalizeSessionExpiry(result.session?.expiresAt);
  localStorage.setItem("flowstudio-auth-token", result.token);
  localStorage.setItem(AUTH_SESSION_META_KEY, JSON.stringify({
    expiresAt,
    savedAt: new Date().toISOString(),
    singleBrowserOnly: true,
  }));
  persistAuthenticatedUser(result.user);
  window.dispatchEvent(new CustomEvent(AUTH_SESSION_UPDATED_EVENT));
}

export function persistAuthenticatedUser(user) {
  if (!user || typeof window === "undefined") return;
  localStorage.setItem("flowstudio-auth-user", JSON.stringify(user));
  localStorage.setItem("flowstudio-user-id", user.id);
  localStorage.setItem("flowstudio-user-email", user.email);
}

export function readStoredAuthUser() {
  if (typeof window === "undefined") return null;
  if (!readAuthToken()) return null;
  try {
    const raw = localStorage.getItem("flowstudio-auth-user");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function readAuthToken() {
  if (typeof window === "undefined") return "";
  const token = localStorage.getItem("flowstudio-auth-token") || "";
  if (!token) return "";
  if (isStoredSessionExpired()) {
    clearAuthSession();
    return "";
  }
  return token;
}

export function clearAuthSession() {
  updateProviderModelCatalog([]);
  if (typeof window === "undefined") return;
  localStorage.removeItem("flowstudio-auth-token");
  localStorage.removeItem("flowstudio-auth-user");
  localStorage.removeItem(AUTH_SESSION_META_KEY);
  localStorage.removeItem("flowstudio-user-id");
  localStorage.removeItem("flowstudio-user-email");
  window.dispatchEvent(new CustomEvent(AUTH_SESSION_CLEARED_EVENT));
}

export function authStateLabel(user, language = "zh") {
  const isEnglish = language === "en";
  if (!user) return isEnglish ? "Signed out" : "未登录";
  if (user.approvalStatus === "pending") return isEnglish ? "Pending manual review" : "等待人工审批";
  if (user.approvalStatus === "rejected") return isEnglish ? "Approval rejected" : "审批未通过";
  const membership = user.membership || {};
  if (membership.endsAt && Date.parse(membership.endsAt) <= Date.now()) return isEnglish ? "Membership expired" : "会员已到期";
  if (membership.status === "active") return isEnglish ? `Active · ${formatShortDate(membership.endsAt, language)}` : `会员有效 · ${formatShortDate(membership.endsAt, language)}`;
  return isEnglish ? "Membership inactive" : "会员未激活";
}

function formatShortDate(value, language = "zh") {
  const emptyLabel = language === "en" ? "No expiry set" : "未设置期限";
  if (!value) return emptyLabel;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return emptyLabel;
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`;
}

function normalizeSessionExpiry(value) {
  const fromServer = Date.parse(value || "");
  if (Number.isFinite(fromServer)) return new Date(fromServer).toISOString();
  return new Date(Date.now() + LOCAL_SESSION_TTL_MS).toISOString();
}

function isStoredSessionExpired() {
  try {
    const raw = localStorage.getItem(AUTH_SESSION_META_KEY);
    if (!raw) return false;
    const expiresAt = JSON.parse(raw)?.expiresAt;
    const expiresMs = Date.parse(expiresAt || "");
    return Number.isFinite(expiresMs) && expiresMs <= Date.now();
  } catch {
    return false;
  }
}
