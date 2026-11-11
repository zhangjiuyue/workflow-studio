import crypto from "node:crypto";
import { httpError } from "../http.js";
import { readStore, writeStore, getStoreDriver } from "../storage/store.js";
import {
  createSessionPg,
  getSessionByTokenHashPg,
  getUserByEmailPg,
  getUserByIdPg,
  listUsersPg,
  revokeSessionByTokenHashPg,
  revokeSessionsByUserIdPg,
  upsertUserPg,
} from "../storage/postgres-repositories.js";
import { membershipPlanDefaults } from "../lib/membership-plans.mjs";

const DEV_USER_ID = "dev-user";
const SESSION_DAYS = 7;
const PRO_PLAN_DEFAULTS = membershipPlanDefaults("pro");

export async function resolveRequestUser(req, config) {
  const auth = String(req.headers.authorization || "");
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : String(url.searchParams.get("authToken") || "").trim();
  if (token) {
    if (isPostgresStore(config)) {
      const found = await getSessionByTokenHashPg(config, hashToken(token));
      if (!found?.session) throw httpError(401, "登录已失效，请重新登录。");
      if (found.session.revokedAt) throw httpError(401, "登录已失效，请重新登录。");
      if (Date.parse(found.session.expiresAt) <= Date.now()) throw httpError(401, "登录已过期，请重新登录。");
      ensureLoginAllowed(found.user);
      return found.user;
    }
    const store = readStore(config);
    const session = store.sessions.find((item) => item.token === token && !item.revokedAt);
    if (!session) throw httpError(401, "登录已失效，请重新登录。");
    if (Date.parse(session.expiresAt) <= Date.now()) throw httpError(401, "登录已过期，请重新登录。");
    const user = store.users.find((item) => item.id === session.userId);
    if (!user) throw httpError(401, "账号不存在，请重新登录。");
    ensureLoginAllowed(user);
    return user;
  }

  if (config.env === "production") {
    throw httpError(401, "请先登录。");
  }

  const id = String(req.headers["x-flowstudio-user-id"] || DEV_USER_ID).trim() || DEV_USER_ID;
  const email = String(req.headers["x-flowstudio-user-email"] || "dev@flowstudio.local").trim();
  return ensureUserAsync(config, {
    id,
    email,
    displayName: id === DEV_USER_ID ? "本地开发用户" : email.split("@")[0],
  });
}

export async function ensureUserAsync(config, input) {
  if (!isPostgresStore(config)) return ensureUser(config, input);
  const now = new Date().toISOString();
  const existing = await getUserByIdPg(config, input.id) || await getUserByEmailPg(config, input.email);
  if (existing) {
    if (existing.id === DEV_USER_ID && existing.role !== "admin") {
      existing.role = "admin";
      existing.updatedAt = now;
      await upsertUserPg(config, existing);
    }
    return existing;
  }
  const user = createDevUser(input, now);
  await upsertUserPg(config, user);
  return user;
}

export function ensureUser(config, input) {
  const store = readStore(config);
  const now = new Date().toISOString();
  const existing = store.users.find((user) => user.id === input.id || user.email === input.email);
  if (existing) {
    if (existing.id === DEV_USER_ID && existing.role !== "admin") {
      existing.role = "admin";
      existing.updatedAt = now;
      writeStore(config, store);
    }
    return existing;
  }
  const user = createDevUser(input, now);
  store.users.push(user);
  writeStore(config, store);
  return user;
}

export async function registerUser(config, input) {
  const email = normalizeEmail(input.email);
  const password = String(input.password || "");
  if (!email) throw httpError(400, "请输入邮箱。");
  if (password.length < 8) throw httpError(400, "密码至少需要 8 位。");
  if (isPostgresStore(config)) {
    if (await getUserByEmailPg(config, email)) throw httpError(409, "这个邮箱已经注册。");
    const user = createRegisteredUser(input, email, password);
    await upsertUserPg(config, user);
    return { user: publicUser(user) };
  }
  const store = readStore(config);
  if (store.users.some((user) => normalizeEmail(user.email) === email)) {
    throw httpError(409, "这个邮箱已经注册。");
  }
  const user = createRegisteredUser(input, email, password);
  store.users.push(user);
  writeStore(config, store);
  return { user: publicUser(user) };
}

export async function loginUser(config, input) {
  const email = normalizeEmail(input.email);
  const password = String(input.password || "");
  if (isPostgresStore(config)) {
    const existingUser = await getUserByEmailPg(config, email);
    const user = await ensureBootstrapAdminPg(config, existingUser, email, password) || existingUser;
    if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
      throw httpError(401, "邮箱或密码不正确。");
    }
    if (user.disabledAt) throw httpError(403, "账号已停用，请联系管理员。");
    ensureLoginAllowed(user);
    await revokeSessionsByUserIdPg(config, user.id);
    const session = await createPgSession(config, user.id);
    user.lastLoginAt = new Date().toISOString();
    user.updatedAt = user.lastLoginAt;
    await upsertUserPg(config, user);
    return loginResult(user, session);
  }
  const store = readStore(config);
  const existingUser = store.users.find((item) => normalizeEmail(item.email) === email);
  const user = ensureBootstrapAdmin(store, config, existingUser, email, password) || existingUser;
  if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
    throw httpError(401, "邮箱或密码不正确。");
  }
  if (user.disabledAt) throw httpError(403, "账号已停用，请联系管理员。");
  ensureLoginAllowed(user);
  revokeSessionsByUserId(store, user.id);
  const session = createSession(store, user.id);
  user.lastLoginAt = new Date().toISOString();
  user.updatedAt = user.lastLoginAt;
  writeStore(config, store);
  return loginResult(user, session);
}

async function ensureBootstrapAdminPg(config, existingUser, email, password) {
  const user = ensureBootstrapAdminUser(config, existingUser, email, password);
  if (!user) return null;
  await upsertUserPg(config, user);
  return user;
}

function ensureBootstrapAdmin(store, config, existingUser, email, password) {
  const user = ensureBootstrapAdminUser(config, existingUser, email, password);
  if (!user) return null;
  if (!existingUser) store.users.push(user);
  return user;
}

function ensureBootstrapAdminUser(config, existingUser, email, password) {
  const bootstrapEmail = normalizeEmail(config.bootstrapAdmin?.email);
  const bootstrapPassword = String(config.bootstrapAdmin?.password || "");
  if (!bootstrapEmail || !bootstrapPassword || email !== bootstrapEmail || password !== bootstrapPassword) {
    return null;
  }
  if (existingUser) {
    const now = new Date().toISOString();
    existingUser.passwordHash = hashPassword(password);
    existingUser.role = "admin";
    existingUser.approvalStatus = "approved";
    existingUser.membership = {
      status: "active",
      plan: "pro",
      startsAt: existingUser.membership?.startsAt || now,
      endsAt: "2099-12-31T23:59:59.000Z",
      workflowLimit: Math.max(Number(existingUser.membership?.workflowLimit || existingUser.membership?.dailyQuota || 0), PRO_PLAN_DEFAULTS.workflowLimit),
      dailyQuota: Math.max(Number(existingUser.membership?.dailyQuota || 0), 10000),
      concurrentJobs: Math.max(Number(existingUser.membership?.concurrentJobs || 0), 10),
      assetLimitPerType: Math.max(Number(existingUser.membership?.assetLimitPerType || 0), PRO_PLAN_DEFAULTS.assetLimitPerType),
      teamSeatLimit: Math.max(Number(existingUser.membership?.teamSeatLimit || 0), 1),
    };
    existingUser.updatedAt = now;
    return existingUser;
  }
  const now = new Date().toISOString();
  const user = {
    id: `admin_${crypto.randomUUID()}`,
    email,
    displayName: "初始管理员",
    passwordHash: hashPassword(password),
    role: "admin",
    approvalStatus: "approved",
    membership: {
      status: "active",
      plan: "pro",
      startsAt: now,
      endsAt: "2099-12-31T23:59:59.000Z",
      workflowLimit: PRO_PLAN_DEFAULTS.workflowLimit,
      dailyQuota: 10000,
      concurrentJobs: 10,
      assetLimitPerType: PRO_PLAN_DEFAULTS.assetLimitPerType,
      teamSeatLimit: 1,
    },
    createdAt: now,
    updatedAt: now,
  };
  return user;
}

export async function logoutUser(config, token) {
  if (!token) return;
  if (isPostgresStore(config)) {
    await revokeSessionByTokenHashPg(config, hashToken(token));
    return;
  }
  const store = readStore(config);
  const session = store.sessions.find((item) => item.token === token && !item.revokedAt);
  if (session) {
    session.revokedAt = new Date().toISOString();
    writeStore(config, store);
  }
}

export async function listUsers(config) {
  if (isPostgresStore(config)) return (await listUsersPg(config)).map(publicUser);
  return readStore(config).users.map(publicUser);
}

export async function getUserById(config, userId) {
  if (isPostgresStore(config)) {
    const user = await getUserByIdPg(config, userId);
    if (!user) throw httpError(404, "用户不存在。");
    ensureLoginAllowed(user);
    return user;
  }
  const user = readStore(config).users.find((item) => item.id === userId);
  if (!user) throw httpError(404, "用户不存在。");
  ensureLoginAllowed(user);
  return user;
}

export function assertAdmin(user) {
  if (!user || user.role !== "admin") {
    throw httpError(403, "需要管理员权限。");
  }
}

export async function approveUser(config, userId, input = {}) {
  if (isPostgresStore(config)) {
    const user = await getUserByIdPg(config, userId);
    if (!user) throw httpError(404, "用户不存在。");
    applyApproval(user, input);
    await upsertUserPg(config, user);
    return publicUser(user);
  }
  const store = readStore(config);
  const user = findUser(store, userId);
  applyApproval(user, input);
  writeStore(config, store);
  return publicUser(user);
}

export async function rejectUser(config, userId) {
  if (isPostgresStore(config)) {
    const user = await getUserByIdPg(config, userId);
    if (!user) throw httpError(404, "用户不存在。");
    applyRejection(user);
    await upsertUserPg(config, user);
    return publicUser(user);
  }
  const store = readStore(config);
  const user = findUser(store, userId);
  applyRejection(user);
  writeStore(config, store);
  return publicUser(user);
}

export async function setUserMembership(config, userId, input = {}) {
  if (isPostgresStore(config)) {
    const user = await getUserByIdPg(config, userId);
    if (!user) throw httpError(404, "用户不存在。");
    applyMembership(user, input);
    await upsertUserPg(config, user);
    return publicUser(user);
  }
  const store = readStore(config);
  const user = findUser(store, userId);
  applyMembership(user, input);
  writeStore(config, store);
  return publicUser(user);
}

function createRegisteredUser(input, email, password) {
  const now = new Date().toISOString();
  return {
    id: `user_${crypto.randomUUID()}`,
    email,
    displayName: String(input.displayName || email.split("@")[0]).trim(),
    passwordHash: hashPassword(password),
    role: "user",
    approvalStatus: "pending",
    membership: {
      status: "inactive",
      plan: "basic",
      startsAt: null,
      endsAt: null,
      workflowLimit: 10,
      dailyQuota: 0,
      concurrentJobs: 1,
      assetLimitPerType: 10,
      teamSeatLimit: 1,
    },
    createdAt: now,
    updatedAt: now,
  };
}

function createDevUser(input, now) {
  return {
    id: input.id,
    email: input.email,
    displayName: input.displayName || "",
    role: input.id === DEV_USER_ID ? "admin" : "user",
    approvalStatus: "approved",
    membership: {
      status: "active",
      plan: input.id === DEV_USER_ID ? "pro" : "basic",
      startsAt: now,
      endsAt: "2099-12-31T23:59:59.000Z",
      workflowLimit: input.id === DEV_USER_ID ? PRO_PLAN_DEFAULTS.workflowLimit : 10,
      dailyQuota: 1000,
      concurrentJobs: 3,
      assetLimitPerType: input.id === DEV_USER_ID ? PRO_PLAN_DEFAULTS.assetLimitPerType : 10,
      teamSeatLimit: 1,
    },
    createdAt: now,
    updatedAt: now,
  };
}

function applyApproval(user, input = {}) {
  const now = new Date().toISOString();
  user.approvalStatus = "approved";
  user.membership = {
    status: "active",
    plan: normalizeMembershipPlan(input.plan || user.membership?.plan),
    startsAt: input.startsAt || user.membership?.startsAt || now,
    endsAt: input.endsAt || user.membership?.endsAt || addDays(now, 30),
    workflowLimit: Number(input.workflowLimit || user.membership?.workflowLimit || user.membership?.dailyQuota || 10),
    dailyQuota: Number(input.dailyQuota || user.membership?.dailyQuota || 200),
    concurrentJobs: Number(input.concurrentJobs || user.membership?.concurrentJobs || 2),
    assetLimitPerType: Number(input.assetLimitPerType || user.membership?.assetLimitPerType || 10),
    teamSeatLimit: Number(input.teamSeatLimit || user.membership?.teamSeatLimit || 1),
  };
  user.updatedAt = now;
}

function applyRejection(user) {
  user.approvalStatus = "rejected";
  user.membership = {
    ...(user.membership || {}),
    status: "inactive",
  };
  user.updatedAt = new Date().toISOString();
}

function applyMembership(user, input = {}) {
  const now = new Date().toISOString();
  if ((input.status || user.membership?.status || "active") === "active") {
    user.approvalStatus = "approved";
  }
  user.membership = {
    status: input.status || user.membership?.status || "active",
    plan: normalizeMembershipPlan(input.plan || user.membership?.plan),
    startsAt: input.startsAt || user.membership?.startsAt || now,
    endsAt: input.endsAt || user.membership?.endsAt || addDays(now, 30),
    workflowLimit: Number(input.workflowLimit || user.membership?.workflowLimit || user.membership?.dailyQuota || 10),
    dailyQuota: Number(input.dailyQuota || user.membership?.dailyQuota || 200),
    concurrentJobs: Number(input.concurrentJobs || user.membership?.concurrentJobs || 2),
    assetLimitPerType: Number(input.assetLimitPerType || user.membership?.assetLimitPerType || 10),
    teamSeatLimit: Number(input.teamSeatLimit || user.membership?.teamSeatLimit || 1),
  };
  user.updatedAt = now;
}

export function assertUserCanUseModels(user) {
  if (!user) throw httpError(401, "请先登录。");
  if (user.approvalStatus !== "approved") {
    throw httpError(403, "账号还在人工审批中，暂时不能调用模型。");
  }
  if (user.membership?.status !== "active") {
    throw httpError(403, "会员状态未激活，暂时不能调用模型。");
  }
  if (user.membership?.endsAt && Date.parse(user.membership.endsAt) <= Date.now()) {
    throw httpError(403, "会员期限已到期，请续期后再调用模型。");
  }
}

export function ensureLoginAllowed(user) {
  if (user.approvalStatus === "pending") {
    throw httpError(403, "账号正在人工审批中，审批通过后才能登录。");
  }
  if (user.approvalStatus === "rejected") {
    throw httpError(403, "账号审批未通过，暂时无法登录。");
  }
  if (user.approvalStatus !== "approved") {
    throw httpError(403, "账号状态异常，请联系管理员。");
  }
  if (user.membership?.status !== "active") {
    throw httpError(403, "会员尚未开通，暂时无法登录。");
  }
  if (user.membership?.endsAt && Date.parse(user.membership.endsAt) <= Date.now()) {
    throw httpError(403, "会员期限已到期，请续期后再登录。");
  }
}

export function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    approvalStatus: user.approvalStatus,
    membership: publicMembership(user.membership, user.role),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function publicMembership(membership = {}, role = "user") {
  const plan = normalizeMembershipPlan(membership.plan || (role === "admin" ? "pro" : "basic"));
  const defaults = membershipPlanDefaults(plan);
  return {
    ...membership,
    plan,
    workflowLimit: Number(membership.workflowLimit || defaults.workflowLimit),
    concurrentJobs: Number(membership.concurrentJobs || defaults.concurrentJobs),
    assetLimitPerType: Number(membership.assetLimitPerType || defaults.assetLimitPerType),
    teamSeatLimit: Number(membership.teamSeatLimit || defaults.teamSeatLimit),
  };
}

function createSession(store, userId) {
  const now = Date.now();
  const token = `fs_${crypto.randomBytes(32).toString("hex")}`;
  const expiresAt = new Date(now + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  store.sessions.push({
    id: `session_${crypto.randomUUID()}`,
    userId,
    token,
    createdAt: new Date(now).toISOString(),
    expiresAt,
  });
  return { token, expiresAt };
}

async function createPgSession(config, userId) {
  const now = Date.now();
  const token = `fs_${crypto.randomBytes(32).toString("hex")}`;
  const expiresAt = new Date(now + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await createSessionPg(config, {
    id: `session_${crypto.randomUUID()}`,
    userId,
    tokenHash: hashToken(token),
    createdAt: new Date(now).toISOString(),
    expiresAt,
  });
  return { token, expiresAt };
}

function revokeSessionsByUserId(store, userId) {
  const now = new Date().toISOString();
  store.sessions
    .filter((session) => session.userId === userId && !session.revokedAt)
    .forEach((session) => {
      session.revokedAt = now;
    });
}

function loginResult(user, session) {
  return {
    user: publicUser(user),
    token: session.token,
    session: {
      expiresAt: session.expiresAt,
      singleBrowserOnly: true,
    },
  };
}

function findUser(store, userId) {
  const user = store.users.find((item) => item.id === userId);
  if (!user) throw httpError(404, "用户不存在。");
  return user;
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizeMembershipPlan(plan) {
  return ["basic", "pro", "team"].includes(plan) ? plan : "basic";
}

function isPostgresStore(config) {
  return getStoreDriver(config) === "postgres";
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return `pbkdf2_sha256$120000$${salt}$${hash}`;
}

function verifyPassword(password, encoded) {
  const [algo, iterationsText, salt, expected] = String(encoded || "").split("$");
  if (algo !== "pbkdf2_sha256" || !iterationsText || !salt || !expected) return false;
  const actual = crypto.pbkdf2Sync(password, salt, Number(iterationsText), 32, "sha256");
  const expectedBuffer = Buffer.from(expected, "hex");
  return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
}

function addDays(dateText, days) {
  return new Date(Date.parse(dateText) + days * 24 * 60 * 60 * 1000).toISOString();
}
