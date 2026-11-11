import crypto from "node:crypto";
import { httpError } from "../http.js";
import { withPgClient } from "../db/postgres.js";
import { ensureTeamAccountSchema } from "../storage/postgres-repositories.js";
import { getStoreDriver, readStore, writeStore } from "../storage/store.js";

const ACTIVE = "active";

export async function getUserTeamContext(config, userId) {
  if (isPostgresStore(config)) return await getUserTeamContextPg(config, userId);
  const store = readStore(config);
  ensureTeamCollections(store);
  const membership = activeMemberForUser(store, userId);
  if (!membership) return emptyContext();
  const team = store.teams.find((item) => item.id === membership.teamId && item.status === ACTIVE);
  if (!team) return emptyContext();
  return contextFromTeam(store, team, membership.role, userId);
}

export async function createTeam(config, user, input = {}) {
  assertCanCreateTeam(user);
  const name = requiredText(input.name || user.displayName || "我的团队", "请填写团队名称。");
  const seatLimit = createTeamSeatLimit(user, input);
  if (isPostgresStore(config)) return await createTeamPg(config, user, { name, seatLimit });
  const store = readStore(config);
  ensureTeamCollections(store);
  if (activeMemberForUser(store, user.id)) throw httpError(409, "你已经加入了一个团队。");
  const now = new Date().toISOString();
  const team = {
    id: `team_${crypto.randomUUID()}`,
    name,
    ownerUserId: user.id,
    inviteCode: uniqueInviteCode(store),
    seatLimit,
    status: ACTIVE,
    createdAt: now,
    updatedAt: now,
  };
  store.teams.unshift(team);
  store.teamMembers.unshift({
    id: `tm_${crypto.randomUUID()}`,
    teamId: team.id,
    userId: user.id,
    role: "owner",
    status: ACTIVE,
    joinedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  writeStore(config, store);
  return contextFromTeam(store, team, "owner", user.id);
}

export async function joinTeam(config, user, input = {}) {
  const inviteCode = normalizeInviteCode(input.inviteCode);
  if (!inviteCode) throw httpError(400, "请输入邀请码。");
  if (isPostgresStore(config)) return await joinTeamPg(config, user, inviteCode);
  const store = readStore(config);
  ensureTeamCollections(store);
  if (activeMemberForUser(store, user.id)) throw httpError(409, "一个用户只能加入一个团队。");
  const team = store.teams.find((item) => normalizeInviteCode(item.inviteCode) === inviteCode && item.status === ACTIVE);
  if (!team) throw httpError(404, "邀请码无效或团队不存在。");
  const activeMembers = store.teamMembers.filter((item) => item.teamId === team.id && item.status === ACTIVE);
  if (activeMembers.length >= Number(team.seatLimit || 1)) throw httpError(403, "团队席位已满，请联系团队所有者增加席位。");
  const now = new Date().toISOString();
  const previousIndex = store.teamMembers.findIndex((item) => item.teamId === team.id && item.userId === user.id);
  const member = {
    id: previousIndex >= 0 ? store.teamMembers[previousIndex].id : `tm_${crypto.randomUUID()}`,
    teamId: team.id,
    userId: user.id,
    role: "member",
    status: ACTIVE,
    joinedAt: previousIndex >= 0 ? store.teamMembers[previousIndex].joinedAt || now : now,
    leftAt: "",
    createdAt: previousIndex >= 0 ? store.teamMembers[previousIndex].createdAt || now : now,
    updatedAt: now,
  };
  if (previousIndex >= 0) store.teamMembers[previousIndex] = member;
  else store.teamMembers.unshift(member);
  writeStore(config, store);
  return contextFromTeam(store, team, "member", user.id);
}

export async function leaveTeam(config, user) {
  if (isPostgresStore(config)) return await leaveTeamPg(config, user);
  const store = readStore(config);
  ensureTeamCollections(store);
  const member = activeMemberForUser(store, user.id);
  if (!member) throw httpError(404, "你还没有加入团队。");
  if (member.role === "owner") throw httpError(403, "团队所有者不能离开团队。");
  member.status = "left";
  member.leftAt = new Date().toISOString();
  member.updatedAt = member.leftAt;
  writeStore(config, store);
  return emptyContext();
}

export async function removeTeamMember(config, user, memberUserId) {
  const memberId = String(memberUserId || "").trim();
  if (!memberId) throw httpError(400, "缺少成员 ID。");
  if (memberId === user.id) throw httpError(400, "不能移除团队所有者。");
  if (isPostgresStore(config)) return await removeTeamMemberPg(config, user, memberId);
  const store = readStore(config);
  ensureTeamCollections(store);
  const ownerContext = await getUserTeamContext(config, user.id);
  assertOwnerContext(ownerContext);
  const member = store.teamMembers.find((item) => item.teamId === ownerContext.team.id && item.userId === memberId && item.status === ACTIVE);
  if (!member) throw httpError(404, "团队成员不存在。");
  if (member.role === "owner") throw httpError(403, "不能移除团队所有者。");
  member.status = "left";
  member.leftAt = new Date().toISOString();
  member.updatedAt = member.leftAt;
  writeStore(config, store);
  return contextFromTeam(store, store.teams.find((item) => item.id === ownerContext.team.id), "owner", user.id);
}

export async function listTeamReviewAssets(config, user) {
  const context = await getUserTeamContext(config, user.id);
  assertOwnerContext(context);
  if (isPostgresStore(config)) return await listTeamReviewAssetsPg(config, context.team.id);
  const store = readStore(config);
  ensureTeamCollections(store);
  return {
    assets: (store.assets || [])
      .filter((asset) => asset.teamId === context.team.id && asset.reviewStatus === "pending")
      .sort((left, right) => String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || "")))
      .map((asset) => publicReviewAsset(asset, store)),
  };
}

export async function reviewTeamAsset(config, user, assetId, decision) {
  const normalizedDecision = decision === "approve" ? "approve" : "reject";
  const context = await getUserTeamContext(config, user.id);
  assertOwnerContext(context);
  const id = String(assetId || "").trim();
  if (!id) throw httpError(400, "缺少资产 ID。");
  if (isPostgresStore(config)) return await reviewTeamAssetPg(config, context.team.id, user.id, id, normalizedDecision);
  const store = readStore(config);
  ensureTeamCollections(store);
  const asset = (store.assets || []).find((item) => item.id === id && item.teamId === context.team.id && item.reviewStatus === "pending");
  if (!asset) throw httpError(404, "待审核资产不存在。");
  applyAssetReview(asset, user.id, normalizedDecision);
  writeStore(config, store);
  return { asset: publicReviewAsset(asset, store) };
}

export async function listAdminTeams(config) {
  if (isPostgresStore(config)) return await listAdminTeamsPg(config);
  const store = readStore(config);
  ensureTeamCollections(store);
  return {
    teams: store.teams
      .map((team) => publicAdminTeam(team, store))
      .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || ""))),
  };
}

export async function updateAdminTeam(config, teamId, input = {}) {
  const id = String(teamId || "").trim();
  if (!id) throw httpError(400, "缺少团队 ID。");
  const patch = {
    seatLimit: input.seatLimit !== undefined ? normalizeSeatLimit(input.seatLimit) : undefined,
    status: input.status === "deleted" ? "deleted" : input.status === ACTIVE ? ACTIVE : undefined,
  };
  if (isPostgresStore(config)) return await updateAdminTeamPg(config, id, patch);
  const store = readStore(config);
  ensureTeamCollections(store);
  const team = store.teams.find((item) => item.id === id);
  if (!team) throw httpError(404, "团队不存在。");
  if (patch.seatLimit !== undefined) team.seatLimit = patch.seatLimit;
  if (patch.status) team.status = patch.status;
  team.updatedAt = new Date().toISOString();
  writeStore(config, store);
  return { team: publicAdminTeam(team, store) };
}

export function assertTeamOwnerContext(context) {
  assertOwnerContext(context);
}

function emptyContext() {
  return { team: null, role: "none", isOwner: false, isMember: false, canManageTeam: false };
}

function assertCanCreateTeam(user) {
  if (user?.membership?.plan !== "team") {
    throw httpError(403, "需要开通团队套餐后才能创建团队。");
  }
}

function createTeamSeatLimit(user) {
  return normalizeSeatLimit(user?.membership?.teamSeatLimit || 1);
}

function assertOwnerContext(context) {
  if (!context?.team || context.role !== "owner") throw httpError(403, "需要团队所有者权限。");
}

function ensureTeamCollections(store) {
  store.teams = Array.isArray(store.teams) ? store.teams : [];
  store.teamMembers = Array.isArray(store.teamMembers) ? store.teamMembers : [];
}

function activeMemberForUser(store, userId) {
  return (store.teamMembers || []).find((item) => item.userId === userId && item.status === ACTIVE) || null;
}

function contextFromTeam(store, team, role, currentUserId) {
  const members = (store.teamMembers || [])
    .filter((item) => item.teamId === team.id && item.status === ACTIVE)
    .map((member) => publicMember(member, store))
    .sort((left, right) => roleRank(left.role) - roleRank(right.role) || String(left.joinedAt || "").localeCompare(String(right.joinedAt || "")));
  const owner = userSummary(store, team.ownerUserId);
  return {
    team: {
      id: team.id,
      name: team.name,
      ownerUserId: team.ownerUserId,
      owner,
      inviteCode: team.inviteCode,
      seatLimit: Number(team.seatLimit || 1),
      seatUsed: members.length,
      status: team.status || ACTIVE,
      createdAt: team.createdAt,
      updatedAt: team.updatedAt,
      members,
    },
    role,
    isOwner: role === "owner",
    isMember: Boolean(role && role !== "none"),
    canManageTeam: role === "owner",
    currentUserId,
  };
}

function publicMember(member, store) {
  const user = userSummary(store, member.userId);
  return {
    id: member.id,
    userId: member.userId,
    role: member.role || "member",
    joinedAt: member.joinedAt || member.createdAt || "",
    user,
  };
}

function userSummary(store, userId) {
  const user = (store.users || []).find((item) => item.id === userId) || {};
  return {
    id: user.id || userId || "",
    email: user.email || "",
    displayName: user.displayName || "",
  };
}

function publicAdminTeam(team, store) {
  const members = (store.teamMembers || []).filter((member) => member.teamId === team.id && member.status === ACTIVE);
  return {
    id: team.id,
    name: team.name,
    ownerUserId: team.ownerUserId,
    owner: userSummary(store, team.ownerUserId),
    inviteCode: team.inviteCode,
    seatLimit: Number(team.seatLimit || 1),
    seatUsed: members.length,
    status: team.status || ACTIVE,
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
  };
}

function publicReviewAsset(asset, storeOrUsers = {}) {
  const payload = normalizeObject(asset.payload);
  const submitter = Array.isArray(storeOrUsers.users)
    ? userSummary(storeOrUsers, asset.submittedByUserId || asset.userId)
    : {
        id: asset.submitterUserId || asset.submittedByUserId || asset.userId || "",
        email: asset.submitterEmail || "",
        displayName: asset.submitterDisplayName || "",
      };
  return {
    id: asset.id,
    type: asset.type,
    name: asset.name || payload.name || "",
    desc: payload.desc || "",
    prompt: payload.prompt || "",
    reviewStatus: asset.reviewStatus || "pending",
    submittedByUserId: asset.submittedByUserId || asset.userId || "",
    submitter,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
  };
}

function applyAssetReview(asset, reviewerUserId, decision) {
  const now = new Date().toISOString();
  const payload = normalizeObject(asset.payload);
  if (decision === "approve") {
    asset.scope = "team";
    asset.reviewStatus = "approved";
    payload.shared = true;
    payload.teamReviewStatus = "approved";
  } else {
    asset.scope = "personal";
    asset.teamId = "";
    asset.reviewStatus = "rejected";
    payload.shared = false;
    payload.teamReviewStatus = "rejected";
  }
  asset.reviewedByUserId = reviewerUserId;
  asset.reviewedAt = now;
  asset.updatedAt = now;
  payload.updatedAt = now;
  asset.payload = payload;
}

async function getUserTeamContextPg(config, userId) {
  return withTeamPgClient(config, async (client) => {
    const result = await client.query(`
      select t.*, tm.role
      from team_members tm
      join teams t on t.id = tm.team_id
      where tm.user_id = $1 and tm.status = 'active' and t.status = 'active'
      limit 1
    `, [userId]);
    const row = result.rows[0];
    if (!row) return emptyContext();
    return await pgContextForTeam(client, row.id, row.role, userId);
  });
}

async function withTeamPgClient(config, callback) {
  await ensureTeamAccountSchema(config);
  return withPgClient(config, callback);
}

async function createTeamPg(config, user, input) {
  return withTeamPgClient(config, async (client) => {
    await client.query("begin");
    try {
      const existing = await client.query("select 1 from team_members where user_id = $1 and status = 'active' limit 1", [user.id]);
      if (existing.rows[0]) throw httpError(409, "你已经加入了一个团队。");
      const now = new Date().toISOString();
      const team = {
        id: `team_${crypto.randomUUID()}`,
        name: input.name,
        ownerUserId: user.id,
        inviteCode: await uniqueInviteCodePg(client),
        seatLimit: input.seatLimit,
        status: ACTIVE,
        createdAt: now,
        updatedAt: now,
      };
      await client.query(`
        insert into teams (id, name, owner_user_id, invite_code, seat_limit, status, created_at, updated_at)
        values ($1,$2,$3,$4,$5,$6,$7,$8)
      `, [team.id, team.name, team.ownerUserId, team.inviteCode, team.seatLimit, team.status, team.createdAt, team.updatedAt]);
      await client.query(`
        insert into team_members (id, team_id, user_id, role, status, joined_at, created_at, updated_at)
        values ($1,$2,$3,'owner','active',$4,$4,$4)
      `, [`tm_${crypto.randomUUID()}`, team.id, user.id, now]);
      await client.query("commit");
      return await pgContextForTeam(client, team.id, "owner", user.id);
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

async function joinTeamPg(config, user, inviteCode) {
  return withTeamPgClient(config, async (client) => {
    await client.query("begin");
    try {
      const existing = await client.query("select 1 from team_members where user_id = $1 and status = 'active' limit 1", [user.id]);
      if (existing.rows[0]) throw httpError(409, "一个用户只能加入一个团队。");
      const teamResult = await client.query("select * from teams where upper(invite_code) = $1 and status = 'active' limit 1", [inviteCode]);
      const team = teamResult.rows[0];
      if (!team) throw httpError(404, "邀请码无效或团队不存在。");
      const countResult = await client.query("select count(*)::int as count from team_members where team_id = $1 and status = 'active'", [team.id]);
      if (Number(countResult.rows[0]?.count || 0) >= Number(team.seat_limit || 1)) {
        throw httpError(403, "团队席位已满，请联系团队所有者增加席位。");
      }
      const now = new Date().toISOString();
      await client.query(`
        insert into team_members (id, team_id, user_id, role, status, joined_at, left_at, created_at, updated_at)
        values ($1,$2,$3,'member','active',$4,null,$4,$4)
        on conflict (team_id, user_id) do update set
          role = 'member',
          status = 'active',
          left_at = null,
          updated_at = excluded.updated_at
      `, [`tm_${crypto.randomUUID()}`, team.id, user.id, now]);
      await client.query("commit");
      return await pgContextForTeam(client, team.id, "member", user.id);
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

async function leaveTeamPg(config, user) {
  return withTeamPgClient(config, async (client) => {
    const current = await client.query("select * from team_members where user_id = $1 and status = 'active' limit 1", [user.id]);
    const member = current.rows[0];
    if (!member) throw httpError(404, "你还没有加入团队。");
    if (member.role === "owner") throw httpError(403, "团队所有者不能离开团队。");
    await client.query("update team_members set status = 'left', left_at = now(), updated_at = now() where id = $1", [member.id]);
    return emptyContext();
  });
}

async function removeTeamMemberPg(config, user, memberUserId) {
  return withTeamPgClient(config, async (client) => {
    const ownerContext = await pgContextForUserInClient(client, user.id);
    assertOwnerContext(ownerContext);
    const result = await client.query(`
      update team_members
      set status = 'left', left_at = now(), updated_at = now()
      where team_id = $1 and user_id = $2 and role <> 'owner' and status = 'active'
      returning *
    `, [ownerContext.team.id, memberUserId]);
    if (!result.rows[0]) throw httpError(404, "团队成员不存在。");
    return await pgContextForTeam(client, ownerContext.team.id, "owner", user.id);
  });
}

async function listTeamReviewAssetsPg(config, teamId) {
  return withTeamPgClient(config, async (client) => {
    const result = await client.query(`
      select a.*, u.email as submitter_email, u.display_name as submitter_display_name
      from assets a
      left join users u on u.id = coalesce(a.submitted_by_user_id, a.user_id)
      where a.team_id = $1 and a.review_status = 'pending'
      order by a.updated_at desc
    `, [teamId]);
    return { assets: result.rows.map(rowToReviewAsset).map((asset) => publicReviewAsset(asset)) };
  });
}

async function reviewTeamAssetPg(config, teamId, reviewerUserId, assetId, decision) {
  return withTeamPgClient(config, async (client) => {
    await client.query("begin");
    try {
      const result = await client.query("select * from assets where id = $1 and team_id = $2 and review_status = 'pending' limit 1", [assetId, teamId]);
      const row = result.rows[0];
      if (!row) throw httpError(404, "待审核资产不存在。");
      const asset = rowToReviewAsset(row);
      applyAssetReview(asset, reviewerUserId, decision);
      await client.query(`
        update assets
        set team_id = $2,
            scope = $3,
            review_status = $4,
            reviewed_by_user_id = $5,
            reviewed_at = $6,
            payload = $7,
            updated_at = $8
        where id = $1
      `, [
        asset.id,
        asset.teamId || null,
        asset.scope,
        asset.reviewStatus,
        asset.reviewedByUserId || null,
        toDateOrNull(asset.reviewedAt),
        asset.payload,
        toDateOrNull(asset.updatedAt),
      ]);
      await client.query("commit");
      return { asset: publicReviewAsset(asset) };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

async function listAdminTeamsPg(config) {
  return withTeamPgClient(config, async (client) => {
    const result = await client.query(`
      select t.*,
             u.email as owner_email,
             u.display_name as owner_display_name,
             count(tm.id) filter (where tm.status = 'active')::int as seat_used
      from teams t
      left join users u on u.id = t.owner_user_id
      left join team_members tm on tm.team_id = t.id
      group by t.id, u.email, u.display_name
      order by t.created_at desc
    `);
    return { teams: result.rows.map(rowToAdminTeam) };
  });
}

async function updateAdminTeamPg(config, teamId, patch) {
  return withTeamPgClient(config, async (client) => {
    const result = await client.query(`
      update teams
      set seat_limit = coalesce($2, seat_limit),
          status = coalesce($3, status),
          updated_at = now()
      where id = $1
      returning *
    `, [teamId, patch.seatLimit ?? null, patch.status || null]);
    if (!result.rows[0]) throw httpError(404, "团队不存在。");
    const detail = await client.query(`
      select t.*,
             u.email as owner_email,
             u.display_name as owner_display_name,
             count(tm.id) filter (where tm.status = 'active')::int as seat_used
      from teams t
      left join users u on u.id = t.owner_user_id
      left join team_members tm on tm.team_id = t.id
      where t.id = $1
      group by t.id, u.email, u.display_name
      limit 1
    `, [teamId]);
    return { team: rowToAdminTeam(detail.rows[0] || result.rows[0]) };
  });
}

async function pgContextForUserInClient(client, userId) {
  const result = await client.query(`
    select t.*, tm.role
    from team_members tm
    join teams t on t.id = tm.team_id
    where tm.user_id = $1 and tm.status = 'active' and t.status = 'active'
    limit 1
  `, [userId]);
  const row = result.rows[0];
  if (!row) return emptyContext();
  return await pgContextForTeam(client, row.id, row.role, userId);
}

async function pgContextForTeam(client, teamId, role, currentUserId) {
  const teamResult = await client.query(`
    select t.*, u.email as owner_email, u.display_name as owner_display_name
    from teams t
    left join users u on u.id = t.owner_user_id
    where t.id = $1
    limit 1
  `, [teamId]);
  const team = teamResult.rows[0];
  if (!team) return emptyContext();
  const membersResult = await client.query(`
    select tm.*, u.email, u.display_name
    from team_members tm
    left join users u on u.id = tm.user_id
    where tm.team_id = $1 and tm.status = 'active'
    order by case when tm.role = 'owner' then 0 else 1 end, tm.joined_at asc
  `, [teamId]);
  const members = membersResult.rows.map(rowToMember);
  return {
    team: {
      id: team.id,
      name: team.name,
      ownerUserId: team.owner_user_id,
      owner: {
        id: team.owner_user_id,
        email: team.owner_email || "",
        displayName: team.owner_display_name || "",
      },
      inviteCode: team.invite_code,
      seatLimit: Number(team.seat_limit || 1),
      seatUsed: members.length,
      status: team.status || ACTIVE,
      createdAt: toIso(team.created_at),
      updatedAt: toIso(team.updated_at),
      members,
    },
    role,
    isOwner: role === "owner",
    isMember: Boolean(role && role !== "none"),
    canManageTeam: role === "owner",
    currentUserId,
  };
}

function rowToMember(row) {
  return {
    id: row.id,
    userId: row.user_id,
    role: row.role || "member",
    joinedAt: toIso(row.joined_at),
    user: {
      id: row.user_id,
      email: row.email || "",
      displayName: row.display_name || "",
    },
  };
}

function rowToAdminTeam(row) {
  return {
    id: row.id,
    name: row.name,
    ownerUserId: row.owner_user_id,
    owner: {
      id: row.owner_user_id,
      email: row.owner_email || "",
      displayName: row.owner_display_name || "",
    },
    inviteCode: row.invite_code,
    seatLimit: Number(row.seat_limit || 1),
    seatUsed: Number(row.seat_used || 0),
    status: row.status || ACTIVE,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function rowToReviewAsset(row) {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    name: row.name,
    payload: normalizeObject(row.payload),
    teamId: row.team_id || "",
    scope: row.scope || "personal",
    reviewStatus: row.review_status || "approved",
    submittedByUserId: row.submitted_by_user_id || row.user_id || "",
    reviewedByUserId: row.reviewed_by_user_id || "",
    reviewedAt: toIso(row.reviewed_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    submitterUserId: row.submitted_by_user_id || row.user_id || "",
    submitterEmail: row.submitter_email || "",
    submitterDisplayName: row.submitter_display_name || "",
  };
}

function uniqueInviteCode(store) {
  let code = randomInviteCode();
  const existing = new Set((store.teams || []).map((team) => normalizeInviteCode(team.inviteCode)));
  while (existing.has(code)) code = randomInviteCode();
  return code;
}

async function uniqueInviteCodePg(client) {
  let code = randomInviteCode();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await client.query("select 1 from teams where upper(invite_code) = $1 limit 1", [code]);
    if (!result.rows[0]) return code;
    code = randomInviteCode();
  }
  return `${randomInviteCode()}${String(Math.floor(Math.random() * 90) + 10)}`;
}

function randomInviteCode() {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

function normalizeInviteCode(value) {
  return String(value || "").replace(/\s+/g, "").trim().toUpperCase();
}

function normalizeSeatLimit(value) {
  return Math.max(1, Math.min(500, Number(value || 1)));
}

function requiredText(value, message) {
  const text = String(value || "").trim();
  if (!text) throw httpError(400, message);
  return text;
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function roleRank(role) {
  return role === "owner" ? 0 : 1;
}

function toIso(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function toDateOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isPostgresStore(config) {
  return getStoreDriver(config) === "postgres";
}
