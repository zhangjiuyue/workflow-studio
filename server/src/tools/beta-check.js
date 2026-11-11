import { loadConfig } from "../config.js";
import { checkPgConnection } from "../db/postgres.js";

const config = loadConfig();
const baseUrl = `http://${config.host}:${config.port}`;
const stamp = Date.now();
const testPassword = `FlowStudio_${stamp}!`;
const adminEmail = config.bootstrapAdmin?.email || "";
const adminPassword = config.bootstrapAdmin?.password || "";
const checks = [];

await check("PostgreSQL 数据库连接", async () => {
  const result = await checkPgConnection(config);
  if (!result.ok) throw new Error(result.message);
  return pass("数据库可连接。");
});

let adminToken = "";
let approvedUser = null;
let approvedToken = "";

await check("管理员登录", async () => {
  if (!adminEmail || !adminPassword) return skip("未配置初始管理员，跳过。");
  const data = await fetchJson("/api/auth/login", {
    method: "POST",
    body: { email: adminEmail, password: adminPassword },
  });
  adminToken = data.token;
  if (!adminToken || data.user?.role !== "admin") throw new Error("管理员登录未返回有效身份。");
  return pass(`管理员登录成功：${data.user.email}`);
});

await check("待审批账号拦截", async () => {
  const email = `flowstudio-beta-pending-${stamp}@example.test`;
  await fetchJson("/api/auth/register", {
    method: "POST",
    body: { displayName: "内测待审批", email, password: testPassword },
  });
  const blocked = await expectFetchError("/api/auth/login", {
    method: "POST",
    body: { email, password: testPassword },
  });
  if (blocked.status !== 403) throw new Error(`待审批账号应禁止登录，实际状态：${blocked.status}`);
  return pass("待审批账号无法登录。");
});

await check("审批通过与会员有效期", async () => {
  const email = `flowstudio-beta-approved-${stamp}@example.test`;
  const registered = await fetchJson("/api/auth/register", {
    method: "POST",
    body: { displayName: "内测通过", email, password: testPassword },
  });
  const userId = registered.user?.id;
  if (!userId) throw new Error("注册后没有拿到用户 ID。");
  const membership = buildMembership({ endsAt: addMinutes(60) });
  await fetchJson(`/api/admin/users/${userId}/approve`, {
    token: adminToken,
    method: "POST",
    body: membership,
  });
  const login = await fetchJson("/api/auth/login", {
    method: "POST",
    body: { email, password: testPassword },
  });
  if (!login.token) throw new Error("审批通过账号登录失败。");
  approvedUser = login.user;
  approvedToken = login.token;
  return pass(`审批通过账号可登录：${approvedUser.email}`);
});

await check("会员到期拦截", async () => {
  if (!approvedUser?.id) return skip("没有审批通过账号，跳过。");
  await fetchJson(`/api/admin/users/${approvedUser.id}/membership`, {
    token: adminToken,
    method: "POST",
    body: buildMembership({ endsAt: addMinutes(-5) }),
  });
  const blocked = await expectFetchError("/api/auth/login", {
    method: "POST",
    body: { email: approvedUser.email, password: testPassword },
  });
  if (blocked.status !== 403) throw new Error(`会员到期应禁止登录，实际状态：${blocked.status}`);
  await fetchJson(`/api/admin/users/${approvedUser.id}/membership`, {
    token: adminToken,
    method: "POST",
    body: buildMembership({ endsAt: addMinutes(60) }),
  });
  const relogin = await fetchJson("/api/auth/login", {
    method: "POST",
    body: { email: approvedUser.email, password: testPassword },
  });
  approvedToken = relogin.token;
  return pass("会员到期会被拦截，恢复有效期后可重新登录。");
});

await check("审批拒绝拦截", async () => {
  const email = `flowstudio-beta-rejected-${stamp}@example.test`;
  const registered = await fetchJson("/api/auth/register", {
    method: "POST",
    body: { displayName: "内测拒绝", email, password: testPassword },
  });
  await fetchJson(`/api/admin/users/${registered.user.id}/reject`, {
    token: adminToken,
    method: "POST",
  });
  const blocked = await expectFetchError("/api/auth/login", {
    method: "POST",
    body: { email, password: testPassword },
  });
  if (blocked.status !== 403) throw new Error(`审批拒绝应禁止登录，实际状态：${blocked.status}`);
  return pass("审批拒绝账号无法登录。");
});

await check("创意资产保存链路", async () => {
  if (!approvedToken) return skip("没有可用普通账号，跳过。");
  const group = await fetchJson("/api/assets/prompt/groups", {
    token: approvedToken,
    method: "POST",
    body: { name: `内测分组-${stamp}` },
  });
  const asset = await fetchJson("/api/assets/prompt", {
    token: approvedToken,
    method: "POST",
    body: {
      name: `内测提示词-${stamp}`,
      groupId: group.group.id,
      payload: { content: "这是内测体检提示词，不调用模型。", groupId: group.group.id },
    },
  });
  const listed = await fetchJson("/api/assets/prompt", { token: approvedToken });
  if (!listed.assets?.some((item) => item.id === asset.asset.id)) throw new Error("保存后的提示词资产没有出现在列表。");
  await fetchJson(`/api/assets/prompt/${asset.asset.id}`, { token: approvedToken, method: "DELETE" });
  await fetchJson(`/api/assets/prompt/groups/${group.group.id}`, { token: approvedToken, method: "DELETE" });
  return pass("提示词分组、资产保存、列表读取、删除通过。");
});

await check("工作流保存与删除链路", async () => {
  if (!approvedToken) return skip("没有可用普通账号，跳过。");
  const created = await fetchJson("/api/workflows", {
    token: approvedToken,
    method: "POST",
    body: {
      name: `内测工作流-${stamp}`,
      type: "explain",
      config: {
        track: "内测",
        topicMode: "custom",
        customTopics: ["内测选题，不调用模型"],
      },
    },
  });
  const workflowId = created.workflow?.id;
  if (!workflowId) throw new Error("工作流保存后没有返回 ID。");
  const listed = await fetchJson("/api/workflows", { token: approvedToken });
  if (!listed.workflows?.some((item) => item.id === workflowId)) throw new Error("保存后的工作流没有出现在列表。");
  await fetchJson(`/api/workflows/${workflowId}`, { token: approvedToken, method: "DELETE" });
  const afterDelete = await fetchJson("/api/workflows", { token: approvedToken });
  if (afterDelete.workflows?.some((item) => item.id === workflowId)) throw new Error("工作流删除后仍出现在列表。");
  return pass("工作流保存、列表读取、删除通过。");
});

printSummary();

function buildMembership(overrides = {}) {
  return {
    status: "active",
    plan: "basic",
    startsAt: addMinutes(-1),
    endsAt: addMinutes(60),
    workflowLimit: 10,
    concurrentJobs: 2,
    assetLimitPerType: 10,
    ...overrides,
  };
}

function addMinutes(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

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
    checks.push({ name, status: "失败", message: error.message || String(error) });
  }
}

async function fetchJson(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok || data.ok === false) {
    throw new Error(data.message || `HTTP ${response.status}`);
  }
  return data.data || data;
}

async function expectFetchError(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (response.ok && data.ok !== false) {
    throw new Error("请求应该失败，但实际成功了。");
  }
  return {
    status: response.status,
    message: data.message || "",
    data,
  };
}

function printSummary() {
  const failed = checks.filter((item) => item.status === "失败");
  const skipped = checks.filter((item) => item.status === "跳过");
  console.log("\nFlowStudio 内测链路体检结果");
  console.log("--------------------------------");
  for (const item of checks) {
    const label = item.status === "通过" ? "OK" : item.status === "跳过" ? "--" : "!!";
    console.log(`[${label}] ${item.name}：${item.status}`);
    console.log(`     ${item.message}`);
  }
  console.log("--------------------------------");
  console.log(`体检项：通过 ${checks.length - failed.length - skipped.length}，跳过 ${skipped.length}，失败 ${failed.length}`);
  if (failed.length) {
    console.log("内测链路体检未通过，请先处理失败项。");
    process.exit(1);
  }
  console.log("内测链路体检通过。");
}
