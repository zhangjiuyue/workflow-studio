import crypto from "node:crypto";
import { readStore, writeStore, getStoreDriver } from "../storage/store.js";
import {
  deleteBackendRequestLogsBeforePg,
  listBackendRequestLogsPg,
  recordBackendRequestLogPg,
  summarizeBackendRequestLogsPg,
} from "../storage/postgres-repositories.js";

const DEFAULT_RETENTION_DAYS = 30;
const MAX_JSON_LOGS = 5000;

export async function recordBackendRequestLog(config, input = {}) {
  const record = normalizeBackendRequestLog(input);
  if (!record.userId) return null;
  if (getStoreDriver(config) === "postgres") {
    await cleanupBackendRequestLogs(config);
    return recordBackendRequestLogPg(config, record);
  }
  const store = readStore(config);
  store.backendRequestLogs = Array.isArray(store.backendRequestLogs) ? store.backendRequestLogs : [];
  store.backendRequestLogs.unshift(record);
  store.backendRequestLogs = pruneJsonRequestLogs(store.backendRequestLogs, config);
  writeStore(config, store);
  return record;
}

export async function listBackendRequestLogs(config, filters = {}) {
  const normalized = normalizeFilters(config, filters);
  if (getStoreDriver(config) === "postgres") return listBackendRequestLogsPg(config, normalized);
  const store = readStore(config);
  return (store.backendRequestLogs || [])
    .filter((event) => !normalized.userId || event.userId === normalized.userId)
    .filter((event) => !normalized.taskType || event.taskType === normalized.taskType)
    .filter((event) => !normalized.provider || event.provider === normalized.provider)
    .filter((event) => !normalized.model || event.model === normalized.model)
    .filter((event) => !normalized.status || statusFilterMatches(event, normalized.status))
    .filter((event) => inDateRange(event, normalized))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, normalized.limit);
}

export async function summarizeBackendRequestLogs(config, filters = {}) {
  const normalized = normalizeFilters(config, filters);
  if (getStoreDriver(config) === "postgres") return summarizeBackendRequestLogsPg(config, normalized);
  const events = await listBackendRequestLogs(config, { ...normalized, limit: 100000 });
  return summarizeEvents(events);
}

export async function cleanupBackendRequestLogs(config) {
  const before = retentionCutoff(config);
  if (!before) return 0;
  if (getStoreDriver(config) === "postgres") return deleteBackendRequestLogsBeforePg(config, before);
  const store = readStore(config);
  const current = Array.isArray(store.backendRequestLogs) ? store.backendRequestLogs : [];
  const next = current.filter((event) => new Date(event.createdAt || 0).getTime() >= before.getTime());
  if (next.length !== current.length) {
    store.backendRequestLogs = next.slice(0, MAX_JSON_LOGS);
    writeStore(config, store);
  }
  return current.length - next.length;
}

function normalizeBackendRequestLog(input) {
  const user = input.user || {};
  const statusCode = Number(input.statusCode || 0);
  const now = new Date().toISOString();
  return {
    id: input.id || `reqlog_${crypto.randomUUID()}`,
    requestId: String(input.requestId || crypto.randomUUID()).trim(),
    userId: String(input.userId || user.id || "").trim(),
    userEmail: String(input.userEmail || user.email || "").trim(),
    endpointPath: String(input.endpointPath || "").trim(),
    method: String(input.method || "POST").trim().toUpperCase(),
    statusCode: Number.isFinite(statusCode) ? statusCode : 0,
    durationMs: Math.max(0, Math.round(Number(input.durationMs || 0))),
    provider: String(input.provider || "").trim(),
    model: String(input.model || "").trim(),
    taskType: String(input.taskType || "").trim(),
    upstreamRequestId: String(input.upstreamRequestId || "").trim(),
    errorMessage: sanitizeErrorMessage(input.errorMessage || input.error || ""),
    requestSummary: sanitizeSummary(input.requestSummary),
    responseSummary: sanitizeSummary(input.responseSummary),
    createdAt: input.createdAt || now,
  };
}

function normalizeFilters(config, filters = {}) {
  const days = Math.max(1, Math.min(365, Number(filters.days || retentionDays(config))));
  const from = filters.from || new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return {
    userId: String(filters.userId || "").trim(),
    taskType: String(filters.taskType || "").trim(),
    provider: String(filters.provider || "").trim(),
    model: String(filters.model || "").trim(),
    status: String(filters.status || "").trim(),
    from,
    to: filters.to || "",
    limit: Math.max(1, Math.min(500, Number(filters.limit || 100))),
  };
}

function summarizeEvents(events) {
  const summary = {
    totalRequests: events.length,
    successRequests: 0,
    failedRequests: 0,
    averageDurationMs: 0,
    byTaskType: {},
    byStatus: {},
  };
  let totalDuration = 0;
  for (const event of events) {
    const success = Number(event.statusCode || 0) >= 200 && Number(event.statusCode || 0) < 400;
    if (success) summary.successRequests += 1;
    else summary.failedRequests += 1;
    totalDuration += Number(event.durationMs || 0);
    addBucket(summary.byTaskType, event.taskType || "unknown", event);
    addBucket(summary.byStatus, statusBucket(event.statusCode), event);
  }
  summary.averageDurationMs = events.length ? Math.round(totalDuration / events.length) : 0;
  return summary;
}

function addBucket(target, key, event) {
  target[key] ||= {
    requests: 0,
    failed: 0,
    averageDurationMs: 0,
    totalDurationMs: 0,
  };
  target[key].requests += 1;
  if (!(Number(event.statusCode || 0) >= 200 && Number(event.statusCode || 0) < 400)) target[key].failed += 1;
  target[key].totalDurationMs += Number(event.durationMs || 0);
  target[key].averageDurationMs = Math.round(target[key].totalDurationMs / target[key].requests);
}

function sanitizeSummary(value) {
  if (!value || typeof value !== "object") return {};
  return redactSensitiveKeys(value, 0);
}

function redactSensitiveKeys(value, depth) {
  if (depth > 4) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactSensitiveKeys(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (isSensitiveKey(key)) return [key, "[redacted]"];
    return [key, redactSensitiveKeys(item, depth + 1)];
  }));
}

function isSensitiveKey(key) {
  return /api[_-]?key|authorization|token|secret|password|prompt|messages|content|body|raw/i.test(String(key || ""));
}

function sanitizeErrorMessage(value) {
  return String(value || "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9]{12,}/g, "sk-[redacted]")
    .slice(0, 600);
}

function pruneJsonRequestLogs(events, config) {
  const before = retentionCutoff(config);
  return events
    .filter((event) => !before || new Date(event.createdAt || 0).getTime() >= before.getTime())
    .slice(0, MAX_JSON_LOGS);
}

function inDateRange(event, filters = {}) {
  const createdAt = new Date(event.createdAt || 0).getTime();
  if (filters.from && createdAt < new Date(filters.from).getTime()) return false;
  if (filters.to && createdAt > new Date(filters.to).getTime()) return false;
  return true;
}

function statusFilterMatches(event, status) {
  const statusCode = Number(event.statusCode || 0);
  if (status === "success") return statusCode >= 200 && statusCode < 400;
  if (status === "failed") return statusCode < 200 || statusCode >= 400;
  return true;
}

function statusBucket(statusCode) {
  const code = Number(statusCode || 0);
  if (!code) return "network";
  return `${Math.floor(code / 100)}xx`;
}

function retentionCutoff(config) {
  const days = retentionDays(config);
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function retentionDays(config) {
  return Math.max(1, Math.min(365, Number(config.requestLogs?.retentionDays || DEFAULT_RETENTION_DAYS)));
}
