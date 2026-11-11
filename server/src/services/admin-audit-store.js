import crypto from "node:crypto";
import { readStore, writeStore, getStoreDriver } from "../storage/store.js";
import { listAdminAuditEventsPg, recordAdminAuditEventPg } from "../storage/postgres-repositories.js";

export async function recordAdminAuditEvent(config, event = {}) {
  const now = new Date().toISOString();
  const actor = event.actorUser || {};
  const record = {
    id: event.id || `audit_${crypto.randomUUID()}`,
    actorUserId: actor.id || event.actorUserId || "",
    actorEmail: actor.email || event.actorEmail || "",
    action: String(event.action || "").trim(),
    targetUserId: event.targetUserId || "",
    targetEmail: event.targetEmail || "",
    details: event.details && typeof event.details === "object" ? event.details : {},
    createdAt: event.createdAt || now,
  };
  if (!record.action) return record;
  if (getStoreDriver(config) === "postgres") return recordAdminAuditEventPg(config, record);
  const store = readStore(config);
  store.adminAuditEvents = Array.isArray(store.adminAuditEvents) ? store.adminAuditEvents : [];
  store.adminAuditEvents.unshift(record);
  store.adminAuditEvents = store.adminAuditEvents.slice(0, 1000);
  writeStore(config, store);
  return record;
}

export async function listAdminAuditEvents(config, filters = {}) {
  const normalized = {
    targetUserId: String(filters.targetUserId || "").trim(),
    action: String(filters.action || "").trim(),
    limit: Math.max(1, Math.min(Number(filters.limit || 80), 200)),
  };
  if (getStoreDriver(config) === "postgres") return listAdminAuditEventsPg(config, normalized);
  const store = readStore(config);
  return (store.adminAuditEvents || [])
    .filter((event) => !normalized.targetUserId || event.targetUserId === normalized.targetUserId)
    .filter((event) => !normalized.action || event.action === normalized.action)
    .slice(0, normalized.limit);
}
