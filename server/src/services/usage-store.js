import crypto from "node:crypto";
import { readStore, writeStore, getStoreDriver } from "../storage/store.js";
import { listUsageEventsPg, summarizeUsageEventsPg, upsertUsageEventPg } from "../storage/postgres-repositories.js";

export async function recordUsageEvent(config, event) {
  const record = normalizeUsageEvent(event);
  if (!record.userId) return null;
  if (getStoreDriver(config) === "postgres") return await upsertUsageEventPg(config, record);
  const store = readStore(config);
  store.usageEvents = Array.isArray(store.usageEvents) ? store.usageEvents : [];
  const index = store.usageEvents.findIndex((item) => item.id === record.id);
  if (index >= 0) store.usageEvents[index] = record;
  else store.usageEvents.unshift(record);
  writeStore(config, store);
  return record;
}

export async function listUsageEvents(config, userId, filters = {}) {
  if (getStoreDriver(config) === "postgres") return await listUsageEventsPg(config, userId, filters);
  const store = readStore(config);
  return (store.usageEvents || [])
    .filter((event) => event.userId === userId)
    .filter((event) => !filters.taskType || event.taskType === filters.taskType)
    .filter((event) => !filters.provider || event.provider === filters.provider)
    .filter((event) => !filters.model || event.model === filters.model)
    .filter((event) => inDateRange(event, filters))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, clampLimit(filters.limit));
}

export async function summarizeUsageEvents(config, userId, filters = {}) {
  if (getStoreDriver(config) === "postgres") return await summarizeUsageEventsPg(config, userId, filters);
  const events = await listUsageEvents(config, userId, { ...filters, limit: 100000 });
  const summary = {
    totalRequests: events.length,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalCostUnits: 0,
    byTaskType: {},
    byProvider: {},
    byModel: {},
  };
  for (const event of events) {
    const promptTokens = Number(event.tokensPrompt || 0);
    const completionTokens = Number(event.tokensCompletion || 0);
    const costUnits = Number(event.costUnits || 0);
    summary.totalPromptTokens += promptTokens;
    summary.totalCompletionTokens += completionTokens;
    summary.totalCostUnits += costUnits;
    addBucket(summary.byTaskType, event.taskType || "unknown", promptTokens, completionTokens, costUnits);
    addBucket(summary.byProvider, event.provider || "unknown", promptTokens, completionTokens, costUnits);
    addBucket(summary.byModel, event.model || "unknown", promptTokens, completionTokens, costUnits);
  }
  summary.totalCostUnits = roundNumber(summary.totalCostUnits);
  return summary;
}

function normalizeUsageEvent(event) {
  return {
    id: event.id || crypto.randomUUID(),
    userId: String(event.userId || "").trim(),
    provider: String(event.provider || "").trim(),
    model: String(event.model || "").trim(),
    taskType: String(event.taskType || event.type || "").trim(),
    requestId: String(event.requestId || "").trim(),
    tokensPrompt: Number(event.tokensPrompt || event.promptTokens || 0),
    tokensCompletion: Number(event.tokensCompletion || event.completionTokens || 0),
    costUnits: roundNumber(event.costUnits || event.cost || 0),
    raw: event.raw && typeof event.raw === "object" ? event.raw : {},
    createdAt: event.createdAt || new Date().toISOString(),
  };
}

function inDateRange(event, filters = {}) {
  const createdAt = new Date(event.createdAt || 0).getTime();
  if (filters.from && createdAt < new Date(filters.from).getTime()) return false;
  if (filters.to && createdAt > new Date(filters.to).getTime()) return false;
  return true;
}

function clampLimit(limit) {
  return Math.max(1, Math.min(500, Number(limit || 100)));
}

function addBucket(target, key, promptTokens, completionTokens, costUnits) {
  target[key] ||= {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    costUnits: 0,
  };
  target[key].requests += 1;
  target[key].promptTokens += promptTokens;
  target[key].completionTokens += completionTokens;
  target[key].costUnits = roundNumber(target[key].costUnits + costUnits);
}

function roundNumber(value) {
  return Math.round(Number(value || 0) * 1000000) / 1000000;
}
