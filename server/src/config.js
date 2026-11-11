export function loadConfig() {
  const env = process.env.NODE_ENV || "development";
  const appOrigin = process.env.APP_ORIGIN || "*";
  const llmProxyTimeoutMs = Number(process.env.LLM_PROXY_TIMEOUT_MS || 20 * 60 * 1000);
  const aiDirectorLlmNodeTimeoutMs = Number(
    process.env.WORKFLOW_AI_DIRECTOR_LLM_NODE_TIMEOUT_MS
    || Math.max(25 * 60 * 1000, llmProxyTimeoutMs + 5 * 60 * 1000),
  );
  const apiKeyEncryptionKey =
    process.env.API_KEY_ENCRYPTION_KEY ||
    (env === "production" ? "" : Buffer.from("flowstudio-local-dev-key-0000010").toString("base64"));
  return {
    env,
    host: process.env.HOST || "127.0.0.1",
    port: Number(process.env.PORT || 8787),
    appOrigin,
    appOrigins: parseAppOrigins(process.env.APP_ORIGINS || appOrigin),
    publicApiBaseUrl: process.env.API_PUBLIC_BASE_URL || process.env.PUBLIC_API_BASE_URL || "",
    databaseUrl: process.env.DATABASE_URL || "",
    dataDir: process.env.DATA_DIR || "./data",
    store: {
      driver: process.env.STORE_DRIVER || "json",
    },
    worker: {
      enabled: process.env.WORKER_ENABLED !== "false",
      pollMs: Number(process.env.WORKER_POLL_MS || 1500),
      batchSize: Number(process.env.WORKER_BATCH_SIZE || 8),
      videoSubmissionBatchSize: Number(process.env.WORKFLOW_VIDEO_SUBMISSION_BATCH_SIZE || 1),
      imageConcurrency: Number(process.env.WORKFLOW_IMAGE_CONCURRENCY || 3),
      llmNodeTimeoutMs: Number(process.env.WORKFLOW_LLM_NODE_TIMEOUT_MS || 20 * 60 * 1000),
      aiDirectorLlmNodeTimeoutMs,
      imageNodeTimeoutMs: Number(process.env.WORKFLOW_IMAGE_NODE_TIMEOUT_MS || 20 * 60 * 1000),
      imageHeartbeatMs: Number(process.env.WORKFLOW_IMAGE_HEARTBEAT_MS || 30 * 1000),
      imageHeartbeatTimeoutMs: Number(process.env.WORKFLOW_IMAGE_HEARTBEAT_TIMEOUT_MS || 3 * 60 * 1000),
      imageNoProgressTimeoutMs: Number(process.env.WORKFLOW_IMAGE_NO_PROGRESS_TIMEOUT_MS || 45 * 60 * 1000),
      imageQueuedTimeoutMs: Number(process.env.WORKFLOW_IMAGE_QUEUED_TIMEOUT_MS || 5 * 60 * 1000),
      imageWatchdogPollMs: Number(process.env.WORKFLOW_IMAGE_WATCHDOG_POLL_MS || 60 * 1000),
      serviceHeartbeatTimeoutMs: Number(process.env.WORKER_HEARTBEAT_TIMEOUT_MS || 90 * 1000),
      audioNodeTimeoutMs: Number(process.env.WORKFLOW_AUDIO_NODE_TIMEOUT_MS || 15 * 60 * 1000),
      audioRunStaleTimeoutMs: Number(process.env.WORKFLOW_AUDIO_RUN_STALE_TIMEOUT_MS || 30 * 60 * 1000),
      audioWatchdogPollMs: Number(process.env.WORKFLOW_AUDIO_WATCHDOG_POLL_MS || 60 * 1000),
      draftNodeTimeoutMs: Number(process.env.WORKFLOW_DRAFT_NODE_TIMEOUT_MS || 150 * 60 * 1000),
    },
    requestLogs: {
      retentionDays: Number(process.env.REQUEST_LOG_RETENTION_DAYS || 30),
    },
    modelProxy: {
      adapterTimeoutMs: Number(process.env.PROVIDER_ADAPTER_TIMEOUT_MS || 120000),
      llmTimeoutMs: llmProxyTimeoutMs,
      llmMaxTimeoutMs: Number(process.env.LLM_PROXY_MAX_TIMEOUT_MS || 45 * 60 * 1000),
    },
    sessionSecret: process.env.SESSION_SECRET || "",
    bootstrapAdmin: {
      email: process.env.BOOTSTRAP_ADMIN_EMAIL || "",
      password: process.env.BOOTSTRAP_ADMIN_PASSWORD || "",
    },
    apiKeyEncryptionKey,
    storage: {
      provider: process.env.STORAGE_PROVIDER || "local",
      bucket: process.env.STORAGE_BUCKET || "",
      region: process.env.STORAGE_REGION || "",
      endpoint: process.env.STORAGE_ENDPOINT || "",
      publicBaseUrl: process.env.STORAGE_PUBLIC_BASE_URL || "",
      accessKeyId: process.env.STORAGE_ACCESS_KEY_ID || "",
      secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY || "",
      sessionToken: process.env.STORAGE_SESSION_TOKEN || "",
    },
  };
}

function parseAppOrigins(value) {
  const origins = String(value || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return origins.length ? origins : ["*"];
}
