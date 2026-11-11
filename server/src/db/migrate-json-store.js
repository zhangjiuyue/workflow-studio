import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { requireDatabaseUrl } from "./postgres.js";
import { runMigrations } from "./migrate.js";
import {
  createSessionPg,
  upsertApiKeyPg,
  upsertAssetGroupPg,
  upsertAssetPg,
  upsertJobPg,
  recordAdminAuditEventPg,
  recordBackendRequestLogPg,
  upsertUsageEventPg,
  upsertUserPg,
  upsertWorkflowPg,
  upsertWorkflowRunPg,
  upsertWorkflowVideoTasksPg,
} from "../storage/postgres-repositories.js";

const currentFile = fileURLToPath(import.meta.url);

const JOB_STATUSES = new Set(["queued", "running", "done", "error", "canceled"]);
const RUN_STATUSES = new Set(["waiting", "queued", "running", "done", "error", "cancelled", "canceled", "deleted"]);
const RUN_KINDS = new Set(["main", "child", "topic-seed", "topic-child"]);

export async function migrateJsonStoreToPostgres(config = loadConfig(), options = {}) {
  const store = readJsonStoreForMigration(config);
  const summary = createSummary(store);
  const warnings = [];
  const dryRun = Boolean(options.dryRun);

  if (dryRun) {
    return { dryRun, storePath: getJsonStorePath(config), summary, warnings };
  }

  requireDatabaseUrl(config);
  await runMigrations(config);

  const users = buildUsers(store);
  const userIds = new Set(users.map((user) => user.id));
  const referencedUserIds = collectReferencedUserIds(store);
  for (const userId of referencedUserIds) {
    if (!userIds.has(userId)) {
      const placeholder = buildPlaceholderUser(userId);
      users.push(placeholder);
      userIds.add(userId);
      warnings.push(`已为缺失用户 ${userId} 创建迁移占位账号。`);
    }
  }

  for (const user of users) {
    await upsertUserPg(config, user);
    summary.migrated.users += 1;
  }

  for (const session of store.sessions || []) {
    if (!session?.id || !session?.userId || !session?.tokenHash || !userIds.has(session.userId)) {
      summary.skipped.sessions += 1;
      continue;
    }
    await createSessionPg(config, session);
    summary.migrated.sessions += 1;
  }

  for (const apiKey of store.apiKeys || []) {
    if (!apiKey?.id || !apiKey?.userId || !apiKey?.encryptedApiKey || !userIds.has(apiKey.userId)) {
      summary.skipped.apiKeys += 1;
      continue;
    }
    await upsertApiKeyPg(config, apiKey);
    summary.migrated.apiKeys += 1;
  }

  const groupIds = new Set();
  for (const group of store.assetGroups || []) {
    if (!group?.id || !group?.userId || !group?.type || !userIds.has(group.userId)) {
      summary.skipped.assetGroups += 1;
      continue;
    }
    await upsertAssetGroupPg(config, group);
    groupIds.add(group.id);
    summary.migrated.assetGroups += 1;
  }

  for (const asset of store.assets || []) {
    if (!asset?.id || !asset?.userId || !asset?.type || !userIds.has(asset.userId)) {
      summary.skipped.assets += 1;
      continue;
    }
    const normalized = {
      ...asset,
      groupId: asset.groupId && groupIds.has(asset.groupId) ? asset.groupId : "",
    };
    if (asset.groupId && !groupIds.has(asset.groupId)) {
      warnings.push(`资产 ${asset.id} 引用了不存在的分组，已迁移为未分组。`);
    }
    await upsertAssetPg(config, normalized);
    summary.migrated.assets += 1;
  }

  const workflowIds = new Set();
  for (const workflow of store.workflows || []) {
    if (!workflow?.id || !workflow?.userId || !userIds.has(workflow.userId)) {
      summary.skipped.workflows += 1;
      continue;
    }
    await upsertWorkflowPg(config, normalizeWorkflow(workflow));
    workflowIds.add(workflow.id);
    summary.migrated.workflows += 1;
  }

  const runResult = await migrateWorkflowRuns(
    config,
    store.workflowRuns || [],
    store.workflowVideoTasks || [],
    workflowIds,
    userIds,
  );
  summary.migrated.workflowRuns = runResult.migrated;
  summary.skipped.workflowRuns = runResult.skipped;
  summary.migrated.workflowVideoTasks = runResult.videoTasksMigrated;
  summary.skipped.workflowVideoTasks = runResult.videoTasksSkipped;
  warnings.push(...runResult.warnings);

  for (const job of store.jobs || []) {
    if (!job?.id || !job?.userId || !userIds.has(job.userId)) {
      summary.skipped.jobs += 1;
      continue;
    }
    await upsertJobPg(config, normalizeJob(job));
    summary.migrated.jobs += 1;
  }

  for (const event of store.usageEvents || []) {
    const normalized = normalizeUsageEvent(event);
    if (!normalized?.id || !normalized?.userId || !userIds.has(normalized.userId)) {
      summary.skipped.usageEvents += 1;
      continue;
    }
    await upsertUsageEventPg(config, normalized);
    summary.migrated.usageEvents += 1;
  }

  for (const event of store.backendRequestLogs || []) {
    const normalized = normalizeBackendRequestLog(event);
    if (!normalized?.id || !normalized?.userId || !userIds.has(normalized.userId)) {
      summary.skipped.backendRequestLogs += 1;
      continue;
    }
    await recordBackendRequestLogPg(config, normalized);
    summary.migrated.backendRequestLogs += 1;
  }

  for (const event of store.adminAuditEvents || []) {
    const normalized = normalizeAdminAuditEvent(event);
    if (!normalized?.id) {
      summary.skipped.adminAuditEvents += 1;
      continue;
    }
    await recordAdminAuditEventPg(config, normalized);
    summary.migrated.adminAuditEvents += 1;
  }

  return { dryRun, storePath: getJsonStorePath(config), summary, warnings };
}

async function migrateWorkflowRuns(config, runs, storedVideoTasks, workflowIds, userIds) {
  const warnings = [];
  const migratedRunIds = new Set();
  const pending = [];
  let migrated = 0;
  let skipped = 0;
  let videoTasksMigrated = 0;
  let videoTasksSkipped = 0;

  for (const run of runs) {
    if (!run?.id || !run?.workflowId || !run?.userId || !workflowIds.has(run.workflowId) || !userIds.has(run.userId)) {
      skipped += 1;
      continue;
    }
    pending.push(normalizeWorkflowRun(run));
  }

  while (pending.length > 0) {
    let progressed = false;
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const run = pending[index];
      if (run.parentRunId && !migratedRunIds.has(run.parentRunId)) continue;
      await upsertWorkflowRunPg(config, run);
      const embeddedVideos = Array.isArray(run.result?.videoResults) ? run.result.videoResults : [];
      if (embeddedVideos.length) {
        const saved = await upsertWorkflowVideoTasksPg(config, {
          userId: run.userId,
          workflowId: run.workflowId,
          runId: run.id,
          videos: embeddedVideos,
        });
        videoTasksMigrated += saved.length;
        videoTasksSkipped += embeddedVideos.length - saved.length;
      }
      migratedRunIds.add(run.id);
      pending.splice(index, 1);
      migrated += 1;
      progressed = true;
    }
    if (!progressed) {
      skipped += pending.length;
      warnings.push(`有 ${pending.length} 条工作流运行记录找不到父任务，已跳过。`);
      break;
    }
  }

  for (const task of storedVideoTasks) {
    if (!task?.userId || !task?.workflowId || !task?.runId || !migratedRunIds.has(task.runId) || !task.video) {
      videoTasksSkipped += 1;
      continue;
    }
    const saved = await upsertWorkflowVideoTasksPg(config, {
      userId: task.userId,
      workflowId: task.workflowId,
      runId: task.runId,
      sortOffset: Number(task.sortOrder || 0),
      videos: [task.video],
    });
    videoTasksMigrated += saved.length;
    videoTasksSkipped += saved.length ? 0 : 1;
  }

  return { migrated, skipped, videoTasksMigrated, videoTasksSkipped, warnings };
}

function buildUsers(store) {
  return (store.users || [])
    .filter((user) => user?.id)
    .map((user) => ({
      ...user,
      email: user.email || placeholderEmail(user.id),
      displayName: user.displayName || user.name || user.id,
      role: user.role === "admin" ? "admin" : "user",
      approvalStatus: user.approvalStatus || "approved",
      membership: {
        status: "active",
        plan: "basic",
        workflowLimit: 10,
        concurrentJobs: 2,
        assetLimitPerType: 10,
        ...(user.membership || {}),
      },
    }));
}

function buildPlaceholderUser(userId) {
  const now = new Date().toISOString();
  return {
    id: userId,
    email: placeholderEmail(userId),
    passwordHash: "",
    displayName: userId,
    role: "user",
    approvalStatus: "approved",
    membership: {
      status: "active",
      plan: "basic",
      startsAt: now,
      endsAt: "",
      workflowLimit: 10,
      concurrentJobs: 2,
      assetLimitPerType: 10,
    },
    createdAt: now,
    updatedAt: now,
  };
}

function collectReferencedUserIds(store) {
  const ids = new Set();
  for (const user of store.users || []) addId(ids, user?.id);
  for (const session of store.sessions || []) addId(ids, session?.userId);
  for (const apiKey of store.apiKeys || []) addId(ids, apiKey?.userId);
  for (const group of store.assetGroups || []) addId(ids, group?.userId);
  for (const asset of store.assets || []) addId(ids, asset?.userId);
  for (const workflow of store.workflows || []) addId(ids, workflow?.userId);
  for (const run of store.workflowRuns || []) addId(ids, run?.userId);
  for (const job of store.jobs || []) addId(ids, job?.userId);
  for (const event of store.usageEvents || []) addId(ids, event?.userId);
  for (const event of store.backendRequestLogs || []) addId(ids, event?.userId);
  return ids;
}

function normalizeWorkflow(workflow) {
  return {
    ...workflow,
    name: workflow.name || "未命名工作流",
    type: workflow.type || "commentary",
    config: workflow.config && typeof workflow.config === "object" ? workflow.config : {},
  };
}

function normalizeWorkflowRun(run) {
  return {
    ...run,
    parentRunId: run.parentRunId || "",
    kind: RUN_KINDS.has(run.kind) ? run.kind : "topic-seed",
    serial: run.serial || "",
    topic: run.topic || "",
    status: RUN_STATUSES.has(run.status) ? run.status : "waiting",
    stages: objectOrEmpty(run.stages),
    generatedTopics: arrayOrEmpty(run.generatedTopics),
    confirmedTopics: arrayOrEmpty(run.confirmedTopics),
    confirmedTopicIndexes: arrayOrEmpty(run.confirmedTopicIndexes),
    selectedTopics: arrayOrEmpty(run.selectedTopics),
    result: objectOrEmpty(run.result),
    error: run.error || "",
  };
}

function normalizeJob(job) {
  const status = job.status === "cancelled" ? "canceled" : job.status;
  return {
    ...job,
    runId: job.runId || job.workflowRunId || "",
    status: JOB_STATUSES.has(status) ? status : "queued",
    kind: job.kind || "workflow-node",
    scope: job.scope || "workflow",
    progress: Number(job.progress || 0),
    payload: objectOrEmpty(job.payload),
    result: objectOrEmpty(job.result),
  };
}

function normalizeUsageEvent(event) {
  if (!event) return null;
  return {
    ...event,
    id: event.id || crypto.randomUUID(),
    raw: objectOrEmpty(event.raw),
  };
}

function normalizeBackendRequestLog(event) {
  if (!event) return null;
  return {
    ...event,
    id: event.id || `reqlog_${crypto.randomUUID()}`,
    requestSummary: objectOrEmpty(event.requestSummary),
    responseSummary: objectOrEmpty(event.responseSummary),
  };
}

function normalizeAdminAuditEvent(event) {
  if (!event) return null;
  return {
    ...event,
    id: event.id || `audit_${crypto.randomUUID()}`,
    details: objectOrEmpty(event.details),
  };
}

function createSummary(store) {
  const keys = ["users", "sessions", "apiKeys", "assetGroups", "assets", "workflows", "workflowRuns", "workflowVideoTasks", "jobs", "usageEvents", "backendRequestLogs", "adminAuditEvents"];
  const found = {};
  const migrated = {};
  const skipped = {};
  for (const key of keys) {
    found[key] = Array.isArray(store[key]) ? store[key].length : 0;
    migrated[key] = 0;
    skipped[key] = 0;
  }
  return { found, migrated, skipped };
}

function printResult(result) {
  console.log(`JSON 数据文件：${result.storePath}`);
  if (result.dryRun) {
    console.log("当前为 dry-run，仅统计，不写入 PostgreSQL。");
  }
  printCounts("发现", result.summary.found);
  if (!result.dryRun) {
    printCounts("已迁移", result.summary.migrated);
    printCounts("已跳过", result.summary.skipped);
  }
  for (const warning of result.warnings) console.warn(`警告：${warning}`);
}

function printCounts(label, counts) {
  const text = Object.entries(counts)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
  console.log(`${label}：${text}`);
}

function parseOptions(argv) {
  return { dryRun: argv.includes("--dry-run") };
}

function addId(ids, value) {
  const id = String(value || "").trim();
  if (id) ids.add(id);
}

function placeholderEmail(userId) {
  const safe = String(userId || "user")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "user";
  const hash = crypto.createHash("sha1").update(String(userId || "user")).digest("hex").slice(0, 8);
  return `${safe}-${hash}@local.flowstudio`;
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function getJsonStorePath(config) {
  return path.resolve(process.cwd(), config.dataDir || "./data", "flowstudio-store.json");
}

function readJsonStoreForMigration(config) {
  const file = getJsonStorePath(config);
  const initial = createInitialStore();
  if (!fs.existsSync(file)) return initial;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  return {
    ...initial,
    ...(parsed && typeof parsed === "object" ? parsed : {}),
  };
}

function createInitialStore() {
  return {
    users: [],
    sessions: [],
    apiKeys: [],
    workflows: [],
    workflowRuns: [],
    workflowVideoTasks: [],
    jobs: [],
    assets: [],
    assetGroups: [],
    usageEvents: [],
    backendRequestLogs: [],
    adminAuditEvents: [],
  };
}

if (process.argv[1] === currentFile) {
  migrateJsonStoreToPostgres(loadConfig(), parseOptions(process.argv.slice(2)))
    .then((result) => {
      printResult(result);
    })
    .catch((error) => {
      console.error(error?.stack || error?.message || String(error));
      process.exitCode = 1;
    });
}
