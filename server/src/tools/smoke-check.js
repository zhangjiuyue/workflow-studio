import { loadConfig } from "../config.js";
import { checkPgConnection } from "../db/postgres.js";

const config = loadConfig();
const baseUrl = `http://${config.host}:${config.port}`;
const checks = [];

await check("PostgreSQL 数据库连接", async () => {
  if (config.store.driver !== "postgres") return skip("当前不是 PostgreSQL 模式。");
  await checkPgConnection(config);
  return pass("数据库可以连接。");
});

await check("API 健康检查", async () => {
  const response = await fetchJson("/health");
  if (!response.ok) throw new Error(response.body?.message || `HTTP ${response.status}`);
  return pass("API 服务已响应。");
});

await check("管理员登录链路", async () => {
  const email = String(config.bootstrapAdmin?.email || "");
  const password = String(config.bootstrapAdmin?.password || "");
  if (!email || !password || email === "admin@example.com" || password.startsWith("replace-with")) {
    return skip("未配置真实 BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD。");
  }
  const login = await fetchJson("/api/auth/login", {
    method: "POST",
    body: { email, password },
  });
  if (!login.ok) throw new Error(login.body?.message || `HTTP ${login.status}`);
  const token = login.body?.token;
  if (!token) throw new Error("登录成功响应缺少 token。");
  const me = await fetchJson("/api/auth/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!me.ok) throw new Error(me.body?.message || `HTTP ${me.status}`);
  return pass(`已登录，角色：${me.body?.user?.role || "未知"}`);
});

await check("上线体检接口", async () => {
  const email = String(config.bootstrapAdmin?.email || "");
  const password = String(config.bootstrapAdmin?.password || "");
  if (!email || !password || email === "admin@example.com" || password.startsWith("replace-with")) {
    return skip("未配置真实管理员账号，跳过需管理员权限的接口。");
  }
  const login = await fetchJson("/api/auth/login", {
    method: "POST",
    body: { email, password },
  });
  if (!login.ok) throw new Error(login.body?.message || `HTTP ${login.status}`);
  const token = login.body?.token;
  const deployment = await fetchJson("/api/admin/deployment-check", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!deployment.ok) throw new Error(deployment.body?.message || `HTTP ${deployment.status}`);
  const counts = deployment.body?.counts || {};
  return pass(`体检项：通过 ${counts.pass || 0}，提醒 ${counts.warn || 0}，失败 ${counts.fail || 0}`);
});

printSummary();

function pass(message) {
  return { status: "通过", message };
}

function skip(message) {
  return { status: "跳过", message };
}

async function check(name, callback) {
  try {
    const result = await callback();
    checks.push({ name, ...result });
  } catch (error) {
    checks.push({ name, status: "失败", message: error.message || "未知错误" });
  }
}

async function fetchJson(path, options = {}) {
  const headers = {
    Accept: "application/json",
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(options.headers || {}),
  };
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let body = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  return { ok: response.ok && body?.ok !== false, status: response.status, body };
}

function printSummary() {
  const icon = {
    "通过": "OK",
    "跳过": "--",
    "失败": "!!",
  };
  console.log("\nFlowStudio 本地体检结果");
  console.log("--------------------------------");
  for (const item of checks) {
    console.log(`[${icon[item.status] || "??"}] ${item.name}: ${item.status}`);
    if (item.message) console.log(`     ${item.message}`);
  }
  const failed = checks.filter((item) => item.status === "失败").length;
  console.log("--------------------------------");
  if (failed) {
    console.log(`发现 ${failed} 个问题，需要先处理。`);
    process.exit(1);
  }
  console.log("基础体检通过。");
  process.exit(0);
}
