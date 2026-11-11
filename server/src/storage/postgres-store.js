export const postgresStoreStatus = {
  implemented: true,
  connectionLayer: true,
  migrationRunner: true,
  repositories: ["users", "sessions", "apiKeys", "assets", "jobs", "workflows", "workflowRuns", "usageEvents", "backendRequestLogs", "adminAuditEvents"],
  requiredPackage: "pg",
  targetTables: ["users", "sessions", "api_keys", "asset_groups", "assets", "jobs", "workflows", "workflow_runs", "usage_events", "backend_request_logs", "admin_audit_events"],
};

export function assertPostgresStoreAvailable(operation) {
  throw new Error(
    `PostgreSQL 模式下不应直接调用 ${operation}。请通过对应的异步业务服务或 PostgreSQL 仓库函数读写数据。`,
  );
}
