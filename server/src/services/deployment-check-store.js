import { getStoreStatus } from "../storage/store.js";
import { getObjectStorageStatus } from "../storage/object-storage.js";

export function getDeploymentChecklist(config) {
  const storage = getStoreStatus(config);
  const objectStorage = getObjectStorageStatus(config);
  const checks = [
    check(
      "node_env",
      "运行环境",
      config.env === "production" ? "pass" : "warn",
      config.env === "production" ? "已切换生产环境。" : "当前仍是开发环境，上线前需要设置 NODE_ENV=production。",
      `当前：${config.env}`,
    ),
    check(
      "app_origin",
      "访问域名",
      config.env !== "production" || (config.appOrigin && config.appOrigin !== "*") ? "pass" : "fail",
      config.appOrigin && config.appOrigin !== "*"
        ? "已限制前端访问来源。"
        : "生产环境不能使用 APP_ORIGIN=*，需要改成你的正式域名。",
      `当前：${config.appOrigin || "未设置"}`,
    ),
    check(
      "database",
      "数据库",
      storage.driver === "postgres" && storage.databaseConfigured ? "pass" : "warn",
      storage.driver === "postgres" && storage.databaseConfigured
        ? "已使用 PostgreSQL。"
        : "正式上线建议使用 PostgreSQL，不建议长期使用本地 JSON 文件。",
      `当前：${storage.driver}${storage.databaseConfigured ? " · 已配置 DATABASE_URL" : ""}`,
    ),
    check(
      "object_storage",
      "对象存储",
      config.env !== "production" || (objectStorage.configured && objectStorage.provider !== "local") ? "pass" : "warn",
      objectStorage.configured && objectStorage.provider !== "local"
        ? "远程对象存储已配置。"
        : "正式上线建议配置 R2/S3/OSS，用于图片、音频、附件等文件。",
      `当前：${objectStorage.provider || "local"}`,
    ),
    check(
      "session_secret",
      "会话密钥",
      strongSecret(config.sessionSecret) ? "pass" : "fail",
      strongSecret(config.sessionSecret)
        ? "会话密钥长度足够。"
        : "SESSION_SECRET 需要设置为 32 位以上随机字符串。",
      config.sessionSecret ? "已设置" : "未设置",
    ),
    check(
      "api_key_encryption",
      "API Key 加密密钥",
      validBase64Key(config.apiKeyEncryptionKey) ? "pass" : "fail",
      validBase64Key(config.apiKeyEncryptionKey)
        ? "API Key 加密密钥格式可用。"
        : "API_KEY_ENCRYPTION_KEY 需要是 32 字节 base64 字符串。",
      config.apiKeyEncryptionKey ? "已设置" : "未设置",
    ),
    check(
      "bootstrap_admin",
      "初始管理员",
      config.bootstrapAdmin?.email && strongSecret(config.bootstrapAdmin?.password) ? "pass" : "warn",
      config.bootstrapAdmin?.email && strongSecret(config.bootstrapAdmin?.password)
        ? "初始管理员入口已配置。"
        : "建议配置 BOOTSTRAP_ADMIN_EMAIL 和 8 位以上强密码，方便首次进入后台。",
      config.bootstrapAdmin?.email ? `邮箱：${config.bootstrapAdmin.email}` : "未设置",
    ),
    check(
      "worker",
      "后台任务 Worker",
      config.worker?.enabled ? "pass" : "warn",
      config.worker?.enabled ? "后台任务 Worker 已启用。" : "Worker 已关闭，工作流节点不会自动后台执行。",
      `批量：${Number(config.worker?.batchSize || 0)} · 轮询：${Number(config.worker?.pollMs || 0)}ms`,
    ),
  ];
  const counts = checks.reduce((acc, item) => {
    acc[item.status] = Number(acc[item.status] || 0) + 1;
    return acc;
  }, { pass: 0, warn: 0, fail: 0 });
  return {
    ready: counts.fail === 0,
    counts,
    checks,
    generatedAt: new Date().toISOString(),
  };
}

function check(id, title, status, message, detail = "") {
  return { id, title, status, message, detail };
}

function strongSecret(value) {
  return String(value || "").trim().length >= 8;
}

function validBase64Key(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  try {
    return Buffer.from(text, "base64").length >= 32;
  } catch {
    return false;
  }
}
