import { withPgClient } from "../db/postgres.js";
import { workflowVideoResultStorageKey } from "../lib/workflow-video-results.mjs";
import { mergeWorkflowVideoTaskRecord, workflowVideoProviderTaskId } from "../lib/workflow-video-task-record.mjs";

const backendRequestLogsSchemaReady = new Set();
const membershipTeamSchemaReady = new Set();
const teamAccountSchemaReady = new Set();
const teamAccountSchemaPromises = new Map();

export async function listUsersPg(config) {
  await ensureMembershipTeamSchema(config);
  return withPgClient(config, async (client) => {
    const result = await client.query(`
      select u.*, m.status as membership_status, m.plan, m.starts_at, m.ends_at,
             m.workflow_limit, m.concurrent_jobs, m.asset_limit_per_type, m.team_seat_limit
      from users u
      left join memberships m on m.user_id = u.id
      order by u.created_at desc
    `);
    return result.rows.map(rowToUser);
  });
}

export async function getUserByEmailPg(config, email) {
  await ensureMembershipTeamSchema(config);
  return withPgClient(config, async (client) => {
    const result = await client.query(`
      select u.*, m.status as membership_status, m.plan, m.starts_at, m.ends_at,
             m.workflow_limit, m.concurrent_jobs, m.asset_limit_per_type, m.team_seat_limit
      from users u
      left join memberships m on m.user_id = u.id
      where lower(u.email) = lower($1)
      limit 1
    `, [email]);
    return result.rows[0] ? rowToUser(result.rows[0]) : null;
  });
}

export async function getUserByIdPg(config, userId) {
  await ensureMembershipTeamSchema(config);
  return withPgClient(config, async (client) => {
    const result = await client.query(`
      select u.*, m.status as membership_status, m.plan, m.starts_at, m.ends_at,
             m.workflow_limit, m.concurrent_jobs, m.asset_limit_per_type, m.team_seat_limit
      from users u
      left join memberships m on m.user_id = u.id
      where u.id = $1
      limit 1
    `, [userId]);
    return result.rows[0] ? rowToUser(result.rows[0]) : null;
  });
}

export async function upsertUserPg(config, user) {
  await ensureMembershipTeamSchema(config);
  return withPgClient(config, async (client) => {
    await client.query("begin");
    try {
      await client.query(`
        insert into users (
          id, email, password_hash, display_name, role, approval_status,
          disabled_at, last_login_at, created_at, updated_at
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        on conflict (id) do update set
          email = excluded.email,
          password_hash = excluded.password_hash,
          display_name = excluded.display_name,
          role = excluded.role,
          approval_status = excluded.approval_status,
          disabled_at = excluded.disabled_at,
          last_login_at = excluded.last_login_at,
          updated_at = excluded.updated_at
      `, [
        user.id,
        user.email,
        user.passwordHash || null,
        user.displayName || "",
        user.role || "user",
        user.approvalStatus || "pending",
        toDateOrNull(user.disabledAt),
        toDateOrNull(user.lastLoginAt),
        toDateOrNow(user.createdAt),
        toDateOrNow(user.updatedAt),
      ]);

      await upsertMembershipWithClient(client, user.id, user.membership || {});
      await client.query("commit");
      return user;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

async function ensureMembershipTeamSchema(config) {
  const key = config.databaseUrl || "default";
  if (membershipTeamSchemaReady.has(key)) return;
  await ensureTeamAccountSchema(config);
  membershipTeamSchemaReady.add(key);
}

export async function ensureTeamAccountSchema(config) {
  const key = config.databaseUrl || "default";
  if (teamAccountSchemaReady.has(key)) return;
  const pending = teamAccountSchemaPromises.get(key);
  if (pending) return await pending;
  const promise = ensureTeamAccountSchemaInternal(config, key)
    .finally(() => {
      teamAccountSchemaPromises.delete(key);
    });
  teamAccountSchemaPromises.set(key, promise);
  return await promise;
}

async function ensureTeamAccountSchemaInternal(config, key) {
  await withPgClient(config, async (client) => {
    await client.query("alter table memberships add column if not exists team_seat_limit integer not null default 1");
    await client.query("update memberships set plan = 'basic' where plan not in ('basic', 'pro', 'team')");
    await client.query("alter table memberships drop constraint if exists memberships_plan_check");
    await client.query(`
      alter table memberships
      add constraint memberships_plan_check
      check (plan in ('basic', 'pro', 'team'))
    `);

    await client.query(`
      create table if not exists teams (
        id text primary key,
        name text not null,
        owner_user_id text not null references users(id) on delete cascade,
        invite_code text not null unique,
        seat_limit integer not null default 1,
        status text not null default 'active',
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `);
    await client.query("alter table teams add column if not exists name text not null default ''");
    await client.query("alter table teams add column if not exists owner_user_id text references users(id) on delete cascade");
    await client.query("alter table teams add column if not exists invite_code text");
    await client.query("alter table teams add column if not exists seat_limit integer not null default 1");
    await client.query("alter table teams add column if not exists status text not null default 'active'");
    await client.query("alter table teams add column if not exists created_at timestamptz not null default now()");
    await client.query("alter table teams add column if not exists updated_at timestamptz not null default now()");
    await client.query("update teams set status = 'active' where status not in ('active', 'deleted')");
    await client.query("alter table teams drop constraint if exists teams_status_check");
    await client.query("alter table teams add constraint teams_status_check check (status in ('active', 'deleted'))");
    await client.query("create unique index if not exists idx_teams_invite_code_unique on teams(invite_code)");
    await client.query("create index if not exists idx_teams_owner on teams(owner_user_id)");

    await client.query(`
      create table if not exists team_members (
        id text primary key,
        team_id text not null references teams(id) on delete cascade,
        user_id text not null references users(id) on delete cascade,
        role text not null default 'member',
        status text not null default 'active',
        joined_at timestamptz not null default now(),
        left_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `);
    await client.query("alter table team_members add column if not exists team_id text references teams(id) on delete cascade");
    await client.query("alter table team_members add column if not exists user_id text references users(id) on delete cascade");
    await client.query("alter table team_members add column if not exists role text not null default 'member'");
    await client.query("alter table team_members add column if not exists status text not null default 'active'");
    await client.query("alter table team_members add column if not exists joined_at timestamptz not null default now()");
    await client.query("alter table team_members add column if not exists left_at timestamptz");
    await client.query("alter table team_members add column if not exists created_at timestamptz not null default now()");
    await client.query("alter table team_members add column if not exists updated_at timestamptz not null default now()");
    await client.query("update team_members set role = 'member' where role not in ('owner', 'member')");
    await client.query("update team_members set status = 'left' where status not in ('active', 'left')");
    await client.query("alter table team_members drop constraint if exists team_members_role_check");
    await client.query("alter table team_members add constraint team_members_role_check check (role in ('owner', 'member'))");
    await client.query("alter table team_members drop constraint if exists team_members_status_check");
    await client.query("alter table team_members add constraint team_members_status_check check (status in ('active', 'left'))");
    await client.query("create unique index if not exists idx_team_members_team_user on team_members(team_id, user_id)");
    await client.query("create unique index if not exists idx_team_members_one_active_team on team_members(user_id) where status = 'active'");
    await client.query("create index if not exists idx_team_members_team_active on team_members(team_id, status)");

    await client.query("alter table api_keys add column if not exists team_id text references teams(id) on delete cascade");
    await client.query("create index if not exists idx_api_keys_team_type on api_keys(team_id, service_type) where team_id is not null");

    await client.query("alter table assets add column if not exists team_id text references teams(id) on delete set null");
    await client.query("alter table assets add column if not exists scope text not null default 'personal'");
    await client.query("alter table assets add column if not exists review_status text not null default 'approved'");
    await client.query("alter table assets add column if not exists submitted_by_user_id text references users(id) on delete set null");
    await client.query("alter table assets add column if not exists reviewed_by_user_id text references users(id) on delete set null");
    await client.query("alter table assets add column if not exists reviewed_at timestamptz");
    await client.query("update assets set scope = 'personal' where scope is null or scope not in ('personal', 'team')");
    await client.query("update assets set review_status = 'approved' where review_status is null or review_status not in ('approved', 'pending', 'rejected')");
    await client.query("alter table assets drop constraint if exists assets_scope_check");
    await client.query("alter table assets add constraint assets_scope_check check (scope in ('personal', 'team'))");
    await client.query("alter table assets drop constraint if exists assets_review_status_check");
    await client.query("alter table assets add constraint assets_review_status_check check (review_status in ('approved', 'pending', 'rejected'))");
    await client.query("create index if not exists idx_assets_team_type_status on assets(team_id, type, review_status) where team_id is not null");
  });
  teamAccountSchemaReady.add(key);
  membershipTeamSchemaReady.add(key);
}

export async function recordAdminAuditEventPg(config, event) {
  return withPgClient(config, async (client) => {
    await client.query(`
      insert into admin_audit_events (
        id, actor_user_id, actor_email, action, target_user_id,
        target_email, details, created_at
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8)
      on conflict (id) do update set
        actor_user_id = excluded.actor_user_id,
        actor_email = excluded.actor_email,
        action = excluded.action,
        target_user_id = excluded.target_user_id,
        target_email = excluded.target_email,
        details = excluded.details
    `, [
      event.id,
      event.actorUserId || null,
      event.actorEmail || "",
      event.action || "",
      event.targetUserId || null,
      event.targetEmail || "",
      toJsonParam(event.details, {}),
      toDateOrNow(event.createdAt),
    ]);
    return event;
  });
}

export async function listAdminAuditEventsPg(config, filters = {}) {
  return withPgClient(config, async (client) => {
    const result = await client.query(`
      select *
      from admin_audit_events
      where ($1::text = '' or target_user_id = $1)
        and ($2::text = '' or action = $2)
      order by created_at desc
      limit $3
    `, [
      filters.targetUserId || "",
      filters.action || "",
      Math.max(1, Math.min(Number(filters.limit || 80), 200)),
    ]);
    return result.rows.map(rowToAdminAuditEvent);
  });
}

export async function createSessionPg(config, session) {
  return withPgClient(config, async (client) => {
    await client.query(`
      insert into sessions (id, user_id, token_hash, revoked_at, expires_at, created_at)
      values ($1,$2,$3,$4,$5,$6)
      on conflict (id) do update set
        token_hash = excluded.token_hash,
        revoked_at = excluded.revoked_at,
        expires_at = excluded.expires_at
    `, [
      session.id,
      session.userId,
      session.tokenHash,
      toDateOrNull(session.revokedAt),
      toDateOrNow(session.expiresAt),
      toDateOrNow(session.createdAt),
    ]);
    return session;
  });
}

export async function getSessionByTokenHashPg(config, tokenHash) {
  await ensureMembershipTeamSchema(config);
  return withPgClient(config, async (client) => {
    const result = await client.query(`
      select s.*, u.email, u.password_hash, u.display_name, u.role, u.approval_status,
             u.disabled_at, u.last_login_at, u.created_at as user_created_at, u.updated_at as user_updated_at,
             m.status as membership_status, m.plan, m.starts_at, m.ends_at,
             m.workflow_limit, m.concurrent_jobs, m.asset_limit_per_type, m.team_seat_limit
      from sessions s
      join users u on u.id = s.user_id
      left join memberships m on m.user_id = u.id
      where s.token_hash = $1
      limit 1
    `, [tokenHash]);
    if (!result.rows[0]) return null;
    const row = result.rows[0];
    return {
      session: rowToSession(row),
      user: rowToUser({
        id: row.user_id,
        email: row.email,
        password_hash: row.password_hash,
        display_name: row.display_name,
        role: row.role,
        approval_status: row.approval_status,
        disabled_at: row.disabled_at,
        last_login_at: row.last_login_at,
        created_at: row.user_created_at,
        updated_at: row.user_updated_at,
        membership_status: row.membership_status,
        plan: row.plan,
        starts_at: row.starts_at,
        ends_at: row.ends_at,
        workflow_limit: row.workflow_limit,
        concurrent_jobs: row.concurrent_jobs,
        asset_limit_per_type: row.asset_limit_per_type,
        team_seat_limit: row.team_seat_limit,
      }),
    };
  });
}

export async function revokeSessionByTokenHashPg(config, tokenHash) {
  return withPgClient(config, async (client) => {
    await client.query(`
      update sessions
      set revoked_at = now()
      where token_hash = $1 and revoked_at is null
    `, [tokenHash]);
  });
}

export async function revokeSessionsByUserIdPg(config, userId) {
  return withPgClient(config, async (client) => {
    await client.query(`
      update sessions
      set revoked_at = now()
      where user_id = $1 and revoked_at is null
    `, [userId]);
  });
}

export async function listApiKeysPg(config, userId, teamId = "") {
  await ensureTeamAccountSchema(config);
  return withPgClient(config, async (client) => {
    const result = await client.query(`
      select *
      from api_keys
      where (user_id = $1 and team_id is null)
        or ($2::text <> '' and team_id = $2)
      order by created_at desc
    `, [userId, teamId || ""]);
    return result.rows.map(rowToApiKey);
  });
}

export async function getApiKeyPg(config, userId, id, teamId = "") {
  await ensureTeamAccountSchema(config);
  return withPgClient(config, async (client) => {
    const result = await client.query(`
      select *
      from api_keys
      where id = $1
        and (
          (user_id = $2 and team_id is null)
          or ($3::text <> '' and team_id = $3)
        )
      limit 1
    `, [id, userId, teamId || ""]);
    return result.rows[0] ? rowToApiKey(result.rows[0]) : null;
  });
}

export async function upsertApiKeyPg(config, record) {
  await ensureTeamAccountSchema(config);
  return withPgClient(config, async (client) => {
    const result = await client.query(`
      insert into api_keys (
        id, user_id, service_type, channel, encrypted_api_key,
        endpoint, model, auth_type, protocol, team_id, created_at, updated_at
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      on conflict (id) do update set
        service_type = excluded.service_type,
        channel = excluded.channel,
        encrypted_api_key = excluded.encrypted_api_key,
        endpoint = excluded.endpoint,
        model = excluded.model,
        auth_type = excluded.auth_type,
        protocol = excluded.protocol,
        team_id = excluded.team_id,
        updated_at = excluded.updated_at
      where api_keys.user_id = excluded.user_id
      returning *
    `, [
      record.id,
      record.userId,
      record.serviceType,
      record.channel,
      record.encryptedApiKey,
      record.endpoint || "",
      record.model || "",
      record.authType || "Bearer",
      record.protocol || "",
      record.teamId || null,
      toDateOrNow(record.createdAt),
      toDateOrNow(record.updatedAt),
    ]);
    return result.rows[0] ? rowToApiKey(result.rows[0]) : null;
  });
}

export async function deleteApiKeyPg(config, userId, id, teamId = "") {
  await ensureTeamAccountSchema(config);
  return withPgClient(config, async (client) => {
    const result = await client.query(`
      delete from api_keys
      where id = $1
        and (
          (user_id = $2 and team_id is null)
          or ($3::text <> '' and team_id = $3 and user_id = $2)
        )
    `, [id, userId, teamId || ""]);
    return result.rowCount > 0;
  });
}

export async function listAssetsPg(config, userId, type, teamId = "") {
  await ensureTeamAccountSchema(config);
  return withPgClient(config, async (client) => {
    const [groups, assets] = await Promise.all([
      client.query(`
        select *
        from asset_groups
        where user_id = $1 and type = $2
        order by created_at asc
      `, [userId, type]),
      client.query(`
        select *
        from assets
        where type = $2
          and (
            (user_id = $1 and coalesce(team_id, '') = '')
            or ($3::text <> '' and team_id = $3 and review_status = 'approved')
            or ($3::text <> '' and user_id = $1 and team_id = $3 and review_status in ('pending', 'rejected'))
          )
        order by created_at desc
      `, [userId, type, teamId || ""]),
    ]);
    return {
      groups: groups.rows.map(rowToAssetGroup),
      assets: assets.rows.map(rowToAsset),
    };
  });
}

export async function countAssetsPg(config, userId, type) {
  await ensureTeamAccountSchema(config);
  return withPgClient(config, async (client) => {
    const result = await client.query(`
      select count(*)::integer as count
      from assets
      where user_id = $1 and type = $2
    `, [userId, type]);
    return Number(result.rows[0]?.count || 0);
  });
}

export async function getAssetPg(config, userId, type, id, teamId = "") {
  await ensureTeamAccountSchema(config);
  return withPgClient(config, async (client) => {
    const result = await client.query(`
      select *
      from assets
      where id = $1 and type = $3
        and (
          user_id = $2
          or ($4::text <> '' and team_id = $4)
        )
      limit 1
    `, [id, userId, type, teamId || ""]);
    return result.rows[0] ? rowToAsset(result.rows[0]) : null;
  });
}

export async function upsertAssetPg(config, asset) {
  await ensureTeamAccountSchema(config);
  return withPgClient(config, async (client) => {
    const result = await client.query(`
      insert into assets (
        id, user_id, type, group_id, name, payload, file_url,
        file_key, mime_type, size_bytes, team_id, scope, review_status,
        submitted_by_user_id, reviewed_by_user_id, reviewed_at, created_at, updated_at
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      on conflict (id) do update set
        group_id = excluded.group_id,
        name = excluded.name,
        payload = excluded.payload,
        file_url = excluded.file_url,
        file_key = excluded.file_key,
        mime_type = excluded.mime_type,
        size_bytes = excluded.size_bytes,
        team_id = excluded.team_id,
        scope = excluded.scope,
        review_status = excluded.review_status,
        submitted_by_user_id = excluded.submitted_by_user_id,
        reviewed_by_user_id = excluded.reviewed_by_user_id,
        reviewed_at = excluded.reviewed_at,
        updated_at = excluded.updated_at
      where assets.user_id = excluded.user_id and assets.type = excluded.type
      returning *
    `, [
      asset.id,
      asset.userId,
      asset.type,
      asset.groupId || null,
      asset.name,
      toJsonParam(asset.payload, {}),
      asset.fileUrl || "",
      asset.fileKey || "",
      asset.mimeType || "",
      Number(asset.sizeBytes || 0),
      asset.teamId || null,
      asset.scope || "personal",
      asset.reviewStatus || "approved",
      asset.submittedByUserId || null,
      asset.reviewedByUserId || null,
      toDateOrNull(asset.reviewedAt),
      toDateOrNow(asset.createdAt),
      toDateOrNow(asset.updatedAt),
    ]);
    return result.rows[0] ? rowToAsset(result.rows[0]) : null;
  });
}

export async function deleteAssetPg(config, userId, type, id, teamId = "") {
  await ensureTeamAccountSchema(config);
  return withPgClient(config, async (client) => {
    const result = await client.query(`
      delete from assets
      where id = $1 and type = $3
        and (
          user_id = $2
          or ($4::text <> '' and team_id = $4)
        )
    `, [id, userId, type, teamId || ""]);
    return { id, deleted: result.rowCount > 0 };
  });
}

export async function getAssetGroupPg(config, userId, type, id) {
  return withPgClient(config, async (client) => {
    const result = await client.query(`
      select *
      from asset_groups
      where id = $1 and user_id = $2 and type = $3
      limit 1
    `, [id, userId, type]);
    return result.rows[0] ? rowToAssetGroup(result.rows[0]) : null;
  });
}

export async function upsertAssetGroupPg(config, group) {
  return withPgClient(config, async (client) => {
    const result = await client.query(`
      insert into asset_groups (id, user_id, type, name, description, created_at, updated_at)
      values ($1,$2,$3,$4,$5,$6,$7)
      on conflict (id) do update set
        name = excluded.name,
        description = excluded.description,
        updated_at = excluded.updated_at
      where asset_groups.user_id = excluded.user_id and asset_groups.type = excluded.type
      returning *
    `, [
      group.id,
      group.userId,
      group.type,
      group.name,
      group.desc || "",
      toDateOrNow(group.createdAt),
      toDateOrNow(group.updatedAt),
    ]);
    return result.rows[0] ? rowToAssetGroup(result.rows[0]) : null;
  });
}

export async function deleteAssetGroupPg(config, userId, type, id) {
  return withPgClient(config, async (client) => {
    await client.query("begin");
    try {
      const result = await client.query(`
        delete from asset_groups
        where id = $1 and user_id = $2 and type = $3
      `, [id, userId, type]);
      await client.query(`
        update assets
        set group_id = null, updated_at = now()
        where user_id = $1 and type = $2 and group_id = $3
      `, [userId, type, id]);
      await client.query("commit");
      return { id, deleted: result.rowCount > 0 };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export async function listWorkflowsPg(config, userId) {
  return withPgClient(config, async (client) => {
    const result = await client.query(`
      select *
      from workflows
      where user_id = $1
      order by created_at desc
    `, [userId]);
    return result.rows.map(rowToWorkflow);
  });
}

export async function countWorkflowsPg(config, userId) {
  return withPgClient(config, async (client) => {
    const result = await client.query(`
      select count(*)::integer as count
      from workflows
      where user_id = $1
    `, [userId]);
    return Number(result.rows[0]?.count || 0);
  });
}

export async function getWorkflowPg(config, userId, workflowId) {
  return withPgClient(config, async (client) => {
    const result = await client.query(`
      select *
      from workflows
      where id = $1 and user_id = $2
      limit 1
    `, [workflowId, userId]);
    return result.rows[0] ? rowToWorkflow(result.rows[0]) : null;
  });
}

export async function upsertWorkflowPg(config, workflow) {
  return withPgClient(config, async (client) => {
    const result = await client.query(`
      insert into workflows (id, user_id, name, type, config, created_at, updated_at)
      values ($1,$2,$3,$4,$5,$6,$7)
      on conflict (id) do update set
        name = excluded.name,
        type = excluded.type,
        config = excluded.config,
        updated_at = excluded.updated_at
      where workflows.user_id = excluded.user_id
      returning *
    `, [
      workflow.id,
      workflow.userId,
      workflow.name,
      workflow.type,
      toJsonParam(workflow.config, {}),
      toDateOrNow(workflow.createdAt),
      toDateOrNow(workflow.updatedAt),
    ]);
    return result.rows[0] ? rowToWorkflow(result.rows[0]) : null;
  });
}

export async function deleteWorkflowPg(config, userId, workflowId) {
  return withPgClient(config, async (client) => {
    const result = await client.query(`
      delete from workflows
      where id = $1 and user_id = $2
    `, [workflowId, userId]);
    return result.rowCount > 0;
  });
}

export async function listWorkflowRunsPg(config, userId, workflowId = "") {
  return withPgClient(config, async (client) => {
    const result = await client.query(`
      select *
      from workflow_runs
      where user_id = $1
        and ($2::text = '' or workflow_id = $2)
      order by created_at asc
    `, [userId, workflowId || ""]);
    return result.rows.map(rowToWorkflowRun);
  });
}

export async function listWorkflowRunSummariesPg(config, userId) {
  return withPgClient(config, async (client) => {
    const result = await client.query(`
      select
        id, workflow_id, user_id, parent_run_id, kind, serial, topic, status,
        stages, generated_topics, confirmed_topics, confirmed_topic_indexes,
        selected_topics, topic_generation_status, topic_generation_error,
        jsonb_strip_nulls(jsonb_build_object(
          'scriptOutput', left(coalesce(result->>'scriptOutput', result->>'script', result->>'content', ''), 260),
          'scriptCharCount', char_length(coalesce(result->>'scriptOutput', result->>'script', result->>'content', '')),
          'shotOutput', left(coalesce(result->>'shotOutput', ''), 180),
          'shotCount', case when jsonb_typeof(result->'shots') = 'array' then jsonb_array_length(result->'shots') else 0 end,
          'shots', coalesce((
            select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
              'id', shot->'id',
              'shotId', shot->'shotId',
              'title', shot->'title',
              'imageUrl', shot->'imageUrl',
              'fileUrl', shot->'fileUrl',
              'url', shot->'url',
              'imageStatus', shot->'imageStatus',
              'imageError', shot->'imageError',
              'videoPrompt', shot->'videoPrompt'
            )))
            from jsonb_array_elements(
              case when jsonb_typeof(result->'shots') = 'array' then result->'shots' else '[]'::jsonb end
            ) as shot
          ), '[]'::jsonb),
          'audioUrl', coalesce(result->'audioUrl', result->'audio'->'audio_url', result->'audio'->'audioUrl', result->'audio'->'url'),
          'audioSegmentCount', case
            when jsonb_typeof(result->'audioSegments') = 'array' then jsonb_array_length(result->'audioSegments')
            when jsonb_typeof(result->'audio'->'segments') = 'array' then jsonb_array_length(result->'audio'->'segments')
            else 0
          end,
          'audioTrackCount', case when jsonb_typeof(result->'audioTracks') = 'array' then jsonb_array_length(result->'audioTracks') else 0 end,
          'videoTimeline', coalesce((
            select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
              'id', item->'id',
              'timelineItemId', item->'timelineItemId',
              'title', item->'title',
              'shotIds', item->'shotIds',
              'startIndex', item->'startIndex',
              'endIndex', item->'endIndex',
              'videoPrompt', item->'videoPrompt'
            )))
            from jsonb_array_elements(
              case when jsonb_typeof(result->'videoTimeline') = 'array' then result->'videoTimeline' else '[]'::jsonb end
            ) as item
          ), '[]'::jsonb),
          'videoResults', coalesce((
            select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
              'id', video->'id',
              'taskId', coalesce(video->'taskId', video->'task_id'),
              'timelineItemId', video->'timelineItemId',
              'title', video->'title',
              'status', coalesce(video->'status', video->'state'),
              'state', coalesce(video->'state', video->'status')
            )))
            from jsonb_array_elements(
              case when jsonb_typeof(result->'videoResults') = 'array' then result->'videoResults' else '[]'::jsonb end
            ) as video
          ), '[]'::jsonb),
          'videoResultTombstones', result->'videoResultTombstones',
          'videoStatus', result->'videoStatus',
          'videoPackageStatus', coalesce(result->'videoPackageStatus', result->'videoPackage'->'status'),
          'draftUrl', coalesce(result->'draftUrl', result->'draft'->'draft_url', result->'draft'->'url'),
          'draftStatus', coalesce(result->'draftStatus', result->'draft'->'status'),
          'backendJobs', jsonb_strip_nulls(jsonb_build_object(
            'source', case when result->'backendJobs'->'source' is not null then jsonb_build_object('status', result->'backendJobs'->'source'->'status') end,
            'script', case when result->'backendJobs'->'script' is not null then jsonb_build_object('status', result->'backendJobs'->'script'->'status') end,
            'audio', case when result->'backendJobs'->'audio' is not null then jsonb_build_object('status', result->'backendJobs'->'audio'->'status') end,
            'shot', case when result->'backendJobs'->'shot' is not null then jsonb_build_object('status', result->'backendJobs'->'shot'->'status') end,
            'image', case when result->'backendJobs'->'image' is not null then jsonb_build_object('status', result->'backendJobs'->'image'->'status') end,
            'video', case when result->'backendJobs'->'video' is not null then jsonb_build_object('status', result->'backendJobs'->'video'->'status') end
          ))
        )) as result,
        error, created_at, started_at, completed_at, updated_at
      from workflow_runs
      where user_id = $1
      order by created_at asc
    `, [userId]);
    return result.rows.map(rowToWorkflowRun);
  });
}

export async function listWorkflowRunsWithActiveImagesPg(config, limit = 100) {
  return withPgClient(config, async (client) => {
    const result = await client.query(`
      select *
      from workflow_runs
      where status <> 'deleted'
        and (
          stages->>'image' = 'running'
          or coalesce(result->'backendJobs'->'image'->>'status', '') in ('queued', 'running')
          or exists (
            select 1
            from jsonb_array_elements(
              case when jsonb_typeof(result->'shots') = 'array' then result->'shots' else '[]'::jsonb end
            ) as shot
            where coalesce(shot->>'imageUrl', '') = ''
              and coalesce(shot->>'imageStatus', '') in ('queued', 'running')
          )
        )
      order by updated_at asc
      limit $1
    `, [Math.max(1, Number(limit || 100))]);
    return result.rows.map(rowToWorkflowRun);
  });
}

export async function listWorkflowRunsWithActiveAudioPg(config, limit = 100) {
  return withPgClient(config, async (client) => {
    const result = await client.query(`
      select *
      from workflow_runs
      where status <> 'deleted'
        and (
          stages->>'audio' = 'running'
          or coalesce(result->>'audioStatus', '') = 'running'
        )
      order by updated_at asc
      limit $1
    `, [Math.max(1, Number(limit || 100))]);
    return result.rows.map(rowToWorkflowRun);
  });
}

export async function markWorkflowAudioRunTimedOutPg(config, userId, runId, input = {}) {
  const staleBefore = toDateOrNull(input.staleBefore);
  if (!staleBefore) return null;
  const message = String(input.message || "音频生成超时，已自动结束，请重试。");
  const timedOutAt = toDateOrNow(input.timedOutAt);
  return withPgClient(config, async (client) => {
    const result = await client.query(`
      update workflow_runs
      set status = 'error',
          stages = jsonb_set(coalesce(stages, '{}'::jsonb), '{audio}', '"error"'::jsonb, true),
          result = jsonb_set(
            jsonb_set(
              jsonb_set(
                coalesce(result, '{}'::jsonb),
                '{audioStatus}',
                '"error"'::jsonb,
                true
              ),
              '{audioError}',
              to_jsonb($4::text),
              true
            ),
            '{audioProgress}',
            case
              when jsonb_typeof(coalesce(result, '{}'::jsonb)->'audioProgress') = 'object'
                then coalesce(result, '{}'::jsonb)->'audioProgress'
              else '{}'::jsonb
            end || jsonb_build_object(
              'status', 'error',
              'timedOutAt', $5::timestamptz,
              'message', $4::text
            ),
            true
          ),
          error = $4,
          completed_at = null,
          updated_at = $5
      where id = $1
        and user_id = $2
        and updated_at <= $3
        and status <> 'deleted'
        and (
          stages->>'audio' = 'running'
          or coalesce(result->>'audioStatus', '') = 'running'
        )
      returning *
    `, [runId, userId, staleBefore, message, timedOutAt]);
    return result.rows[0] ? rowToWorkflowRun(result.rows[0]) : null;
  });
}

export async function listWorkflowChildRunsPg(config, userId, parentRunId) {
  return withPgClient(config, async (client) => {
    const result = await client.query(`
      select *
      from workflow_runs
      where user_id = $1
        and parent_run_id = $2
      order by created_at asc
    `, [userId, parentRunId]);
    return result.rows.map(rowToWorkflowRun);
  });
}

export async function listWorkflowChildRunSummariesPg(config, userId, parentRunId) {
  return withPgClient(config, async (client) => {
    const result = await client.query(`
      select
        id, workflow_id, user_id, parent_run_id, kind, serial, topic, status,
        stages, generated_topics, confirmed_topics, confirmed_topic_indexes,
        selected_topics, topic_generation_status, topic_generation_error,
        '{}'::jsonb as result, error, created_at, started_at, completed_at, updated_at
      from workflow_runs
      where user_id = $1
        and parent_run_id = $2
      order by created_at asc
    `, [userId, parentRunId]);
    return result.rows.map(rowToWorkflowRun);
  });
}

export async function getWorkflowRunPg(config, userId, runId) {
  return withPgClient(config, async (client) => {
    const result = await client.query(`
      select *
      from workflow_runs
      where id = $1 and user_id = $2
      limit 1
    `, [runId, userId]);
    return result.rows[0] ? rowToWorkflowRun(result.rows[0]) : null;
  });
}

export async function getWorkflowRunSummaryPg(config, userId, runId) {
  return withPgClient(config, async (client) => {
    const result = await client.query(`
      select
        id, workflow_id, user_id, parent_run_id, kind, serial, topic, status,
        stages, generated_topics, confirmed_topics, confirmed_topic_indexes,
        selected_topics, topic_generation_status, topic_generation_error,
        '{}'::jsonb as result, error, created_at, started_at, completed_at, updated_at
      from workflow_runs
      where id = $1 and user_id = $2
      limit 1
    `, [runId, userId]);
    return result.rows[0] ? rowToWorkflowRun(result.rows[0]) : null;
  });
}

export async function listWorkflowVideoTasksPg(config, userId, runIds = []) {
  const normalizedRunIds = [...new Set((Array.isArray(runIds) ? runIds : [runIds])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
  if (!normalizedRunIds.length) return [];
  return withPgClient(config, async (client) => {
    const result = await client.query(`
      select *
      from workflow_video_tasks
      where user_id = $1
        and workflow_run_id = any($2::text[])
      order by workflow_run_id, sort_order, created_at, id
    `, [userId, normalizedRunIds]);
    return result.rows.map(rowToWorkflowVideoTask);
  });
}

export async function upsertWorkflowVideoTasksPg(config, input = {}) {
  const videos = Array.isArray(input.videos) ? input.videos : [];
  if (!videos.length) return [];
  return withPgClient(config, async (client) => {
    await client.query("begin");
    try {
      const saved = [];
      for (let index = 0; index < videos.length; index += 1) {
        const task = await upsertWorkflowVideoTaskWithClient(client, input, videos[index], index);
        if (task) saved.push(task);
      }
      await client.query("commit");
      return saved;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export async function deleteWorkflowVideoTasksPg(config, userId, runId, videos = []) {
  const resultKeys = [...new Set((Array.isArray(videos) ? videos : [])
    .map(workflowVideoResultStorageKey)
    .filter(Boolean))];
  if (!resultKeys.length) return 0;
  return withPgClient(config, async (client) => {
    const result = await client.query(`
      delete from workflow_video_tasks
      where user_id = $1
        and workflow_run_id = $2
        and result_key = any($3::text[])
    `, [userId, runId, resultKeys]);
    return result.rowCount;
  });
}

async function upsertWorkflowVideoTaskWithClient(client, input, video, index) {
  const userId = String(input.userId || "").trim();
  const workflowId = String(input.workflowId || "").trim();
  const runId = String(input.runId || "").trim();
  const resultKey = workflowVideoResultStorageKey(video);
  if (!userId || !workflowId || !runId || !resultKey) return null;
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [`${runId}:${resultKey}`]);
  const selected = await client.query(`
    select *
    from workflow_video_tasks
    where user_id = $1 and workflow_run_id = $2 and result_key = $3
    limit 1
    for update
  `, [userId, runId, resultKey]);
  const existing = selected.rows[0] ? rowToWorkflowVideoTask(selected.rows[0]) : null;
  const mergedVideo = existing ? mergeWorkflowVideoTaskRecord(existing.video, video) : { ...video };
  const providerTaskId = workflowVideoProviderTaskId(mergedVideo);
  const sortOrder = existing ? existing.sortOrder : Number(input.sortOffset || 0) + index;

  if (existing) {
    const updated = await client.query(`
      update workflow_video_tasks
      set timeline_item_id = $4,
          submission_job_id = $5,
          provider_task_id = $6,
          status = $7,
          submission_state = $8,
          payload = $9::jsonb,
          updated_at = now()
      where user_id = $1 and workflow_run_id = $2 and result_key = $3
      returning *
    `, [
      userId,
      runId,
      resultKey,
      String(mergedVideo.timelineItemId || "").trim(),
      String(mergedVideo.submissionJobId || "").trim(),
      providerTaskId,
      String(mergedVideo.status || "queued").trim(),
      String(mergedVideo.submissionState || "queued").trim(),
      toJsonParam(mergedVideo, {}),
    ]);
    return updated.rows[0] ? rowToWorkflowVideoTask(updated.rows[0]) : existing;
  }

  const inserted = await client.query(`
    insert into workflow_video_tasks (
      user_id, workflow_id, workflow_run_id, result_key, timeline_item_id,
      submission_job_id, provider_task_id, status, submission_state,
      sort_order, payload, created_at, updated_at
    )
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,now(),now())
    returning *
  `, [
    userId,
    workflowId,
    runId,
    resultKey,
    String(mergedVideo.timelineItemId || "").trim(),
    String(mergedVideo.submissionJobId || "").trim(),
    providerTaskId,
    String(mergedVideo.status || "queued").trim(),
    String(mergedVideo.submissionState || "queued").trim(),
    sortOrder,
    toJsonParam(mergedVideo, {}),
  ]);
  return inserted.rows[0] ? rowToWorkflowVideoTask(inserted.rows[0]) : null;
}

export async function patchWorkflowRunImageShotPg(config, userId, runId, input = {}) {
  return withPgClient(config, async (client) => {
    await client.query("begin");
    try {
      const selected = await client.query(`
        select *
        from workflow_runs
        where id = $1 and user_id = $2
        limit 1
        for update
      `, [runId, userId]);
      if (!selected.rows[0]) {
        await client.query("commit");
        return null;
      }

      const run = rowToWorkflowRun(selected.rows[0]);
      const result = run.result && typeof run.result === "object" ? run.result : {};
      const shots = Array.isArray(result.shots) ? result.shots : [];
      const shotId = String(input.shotId || "").trim();
      const shotIndex = shots.findIndex((shot) => workflowImageShotId(shot) === shotId);
      const shot = shotIndex >= 0 ? shots[shotIndex] : null;
      if (!shot || !workflowImageShotPatchMatches(shot, input)) {
        await client.query("commit");
        return { run, shot, updated: false };
      }

      const nextShot = {
        ...shot,
        ...(input.patch && typeof input.patch === "object" ? input.patch : {}),
      };
      const nextShots = shots.map((item, index) => index === shotIndex ? nextShot : item);
      const nextResult = {
        ...result,
        shots: nextShots,
      };
      const updated = await client.query(`
        update workflow_runs
        set result = $3::jsonb,
            updated_at = now()
        where id = $1 and user_id = $2
        returning *
      `, [runId, userId, toJsonParam(nextResult, {})]);
      await client.query("commit");
      const updatedRun = updated.rows[0] ? rowToWorkflowRun(updated.rows[0]) : run;
      return {
        run: updatedRun,
        shot: nextShot,
        updated: Boolean(updated.rows[0]),
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export async function patchWorkflowRunBackendJobPg(config, userId, runId, input = {}) {
  const nodeId = String(input.nodeId || "").trim();
  if (!nodeId) return null;
  const job = input.job && typeof input.job === "object" ? input.job : {};
  const stages = input.stages && typeof input.stages === "object" && !Array.isArray(input.stages) ? input.stages : {};
  const runPatch = input.runPatch && typeof input.runPatch === "object" && !Array.isArray(input.runPatch) ? input.runPatch : {};
  const hasStatus = Object.hasOwn(runPatch, "status");
  const hasError = Object.hasOwn(runPatch, "error");
  const hasStartedAt = Object.hasOwn(runPatch, "startedAt");
  const hasCompletedAt = Object.hasOwn(runPatch, "completedAt");
  return withPgClient(config, async (client) => {
    const result = await client.query(`
      update workflow_runs
      set status = case when $6::boolean then $7 else status end,
          stages = coalesce(stages, '{}'::jsonb) || $5::jsonb,
          result = jsonb_set(
            jsonb_set(
              coalesce(result, '{}'::jsonb),
              '{backendJobs}',
              case
                when jsonb_typeof(coalesce(result, '{}'::jsonb)->'backendJobs') = 'object'
                  then coalesce(result, '{}'::jsonb)->'backendJobs'
                else '{}'::jsonb
              end,
              true
            ),
            array['backendJobs', $3::text],
            $4::jsonb,
            true
          ),
          error = case when $8::boolean then $9 else error end,
          started_at = case when $10::boolean then $11 else started_at end,
          completed_at = case when $12::boolean then $13 else completed_at end,
          updated_at = now()
      where id = $1 and user_id = $2
      returning *
    `, [
      runId,
      userId,
      nodeId,
      toJsonParam(job, {}),
      toJsonParam(stages, {}),
      hasStatus,
      String(runPatch.status || "").trim(),
      hasError,
      String(runPatch.error || ""),
      hasStartedAt,
      toDateOrNull(runPatch.startedAt),
      hasCompletedAt,
      toDateOrNull(runPatch.completedAt),
    ]);
    return result.rows[0] ? rowToWorkflowRun(result.rows[0]) : null;
  });
}

export async function upsertWorkflowRunPg(config, run) {
  return withPgClient(config, async (client) => {
    const result = await client.query(`
      insert into workflow_runs (
        id, workflow_id, user_id, parent_run_id, kind, serial, topic, status,
        stages, generated_topics, confirmed_topics, confirmed_topic_indexes,
        selected_topics, topic_generation_status, topic_generation_error,
        result, error, created_at, started_at, completed_at, updated_at
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      on conflict (id) do update set
        parent_run_id = excluded.parent_run_id,
        kind = excluded.kind,
        serial = excluded.serial,
        topic = excluded.topic,
        status = excluded.status,
        stages = excluded.stages,
        generated_topics = excluded.generated_topics,
        confirmed_topics = excluded.confirmed_topics,
        confirmed_topic_indexes = excluded.confirmed_topic_indexes,
        selected_topics = excluded.selected_topics,
        topic_generation_status = excluded.topic_generation_status,
        topic_generation_error = excluded.topic_generation_error,
        result = excluded.result,
        error = excluded.error,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        updated_at = excluded.updated_at
      where workflow_runs.user_id = excluded.user_id
        and workflow_runs.workflow_id = excluded.workflow_id
      returning *
    `, workflowRunToParams(run));
    return result.rows[0] ? rowToWorkflowRun(result.rows[0]) : null;
  });
}

export async function upsertJobPg(config, job) {
  return withPgClient(config, async (client) => {
    await upsertJobWithClient(client, job);
    return job;
  });
}

export async function createOrReuseActiveJobPg(config, job) {
  return withPgClient(config, async (client) => {
    await client.query("begin");
    try {
      await client.query(
        "select pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        [`${job.userId}:${job.runId}`, `${job.kind}:${job.nodeId}`],
      );
      const existing = await client.query(`
        select *
        from jobs
        where user_id = $1
          and workflow_run_id = $2
          and node_id = $3
          and kind = $4
          and status in ('queued', 'running')
        order by created_at desc
        limit 1
      `, [job.userId, job.runId || null, job.nodeId || "", job.kind || "workflow-node"]);
      if (existing.rows[0]) {
        await client.query("commit");
        return { job: rowToJob(existing.rows[0]), reused: true };
      }
      await upsertJobWithClient(client, job);
      await client.query("commit");
      return { job, reused: false };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export async function touchWorkerHeartbeatPg(config, heartbeat) {
  return withPgClient(config, async (client) => {
    const result = await client.query(`
      insert into worker_heartbeats (name, heartbeat_at, metadata)
      values ($1, $2, $3)
      on conflict (name) do update set
        heartbeat_at = excluded.heartbeat_at,
        metadata = excluded.metadata
      returning *
    `, [heartbeat.name, toDateOrNow(heartbeat.heartbeatAt), toJsonParam(heartbeat.metadata, {})]);
    return rowToWorkerHeartbeat(result.rows[0]);
  });
}

export async function getWorkerHeartbeatPg(config, name) {
  return withPgClient(config, async (client) => {
    const result = await client.query(`
      select *
      from worker_heartbeats
      where name = $1
      limit 1
    `, [name]);
    return result.rows[0] ? rowToWorkerHeartbeat(result.rows[0]) : null;
  });
}

async function upsertJobWithClient(client, job) {
  await client.query(`
      insert into jobs (
        id, user_id, workflow_id, workflow_run_id, node_id, kind, scope, title,
        status, progress, payload, result, attempts, priority, error,
        queued_at, started_at, completed_at, created_at
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      on conflict (id) do update set
        workflow_id = excluded.workflow_id,
        workflow_run_id = excluded.workflow_run_id,
        node_id = excluded.node_id,
        kind = excluded.kind,
        scope = excluded.scope,
        title = excluded.title,
        status = excluded.status,
        progress = excluded.progress,
        payload = excluded.payload,
        result = excluded.result,
        attempts = excluded.attempts,
        priority = excluded.priority,
        error = excluded.error,
        queued_at = excluded.queued_at,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at
  `, jobToParams(job));
}

export async function upsertUsageEventPg(config, event) {
  return withPgClient(config, async (client) => {
    await client.query(`
      insert into usage_events (
        id, user_id, provider, model, task_type, request_id,
        tokens_prompt, tokens_completion, cost_units, raw, created_at
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      on conflict (id) do update set
        user_id = excluded.user_id,
        provider = excluded.provider,
        model = excluded.model,
        task_type = excluded.task_type,
        request_id = excluded.request_id,
        tokens_prompt = excluded.tokens_prompt,
        tokens_completion = excluded.tokens_completion,
        cost_units = excluded.cost_units,
        raw = excluded.raw
    `, usageEventToParams(event));
    return event;
  });
}

export async function listUsageEventsPg(config, userId, filters = {}) {
  return withPgClient(config, async (client) => {
    const result = await client.query(`
      select *
      from usage_events
      where user_id = $1
        and ($2::text = '' or task_type = $2)
        and ($3::text = '' or provider = $3)
        and ($4::text = '' or model = $4)
        and ($5::timestamptz is null or created_at >= $5)
        and ($6::timestamptz is null or created_at <= $6)
      order by created_at desc
      limit $7
    `, [
      userId,
      filters.taskType || "",
      filters.provider || "",
      filters.model || "",
      toDateOrNull(filters.from),
      toDateOrNull(filters.to),
      Math.max(1, Math.min(500, Number(filters.limit || 100))),
    ]);
    return result.rows.map(rowToUsageEvent);
  });
}

export async function summarizeUsageEventsPg(config, userId, filters = {}) {
  return withPgClient(config, async (client) => {
    const params = [
      userId,
      filters.taskType || "",
      filters.provider || "",
      filters.model || "",
      toDateOrNull(filters.from),
      toDateOrNull(filters.to),
    ];
    const total = await client.query(`
      select
        count(*)::int as requests,
        coalesce(sum(tokens_prompt), 0)::int as prompt_tokens,
        coalesce(sum(tokens_completion), 0)::int as completion_tokens,
        coalesce(sum(cost_units), 0)::float8 as cost_units
      from usage_events
      where user_id = $1
        and ($2::text = '' or task_type = $2)
        and ($3::text = '' or provider = $3)
        and ($4::text = '' or model = $4)
        and ($5::timestamptz is null or created_at >= $5)
        and ($6::timestamptz is null or created_at <= $6)
    `, params);
    const byTaskType = await summarizeUsageBucket(client, "task_type", params);
    const byProvider = await summarizeUsageBucket(client, "provider", params);
    const byModel = await summarizeUsageBucket(client, "model", params);
    return {
      totalRequests: Number(total.rows[0]?.requests || 0),
      totalPromptTokens: Number(total.rows[0]?.prompt_tokens || 0),
      totalCompletionTokens: Number(total.rows[0]?.completion_tokens || 0),
      totalCostUnits: Number(total.rows[0]?.cost_units || 0),
      byTaskType,
      byProvider,
      byModel,
    };
  });
}

export async function recordBackendRequestLogPg(config, event) {
  return withBackendRequestLogsTable(config, async (client) => {
    await client.query(`
      insert into backend_request_logs (
        id, request_id, user_id, user_email, endpoint_path, method,
        status_code, duration_ms, provider, model, task_type,
        upstream_request_id, error_message, request_summary, response_summary, created_at
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      on conflict (id) do update set
        request_id = excluded.request_id,
        user_id = excluded.user_id,
        user_email = excluded.user_email,
        endpoint_path = excluded.endpoint_path,
        method = excluded.method,
        status_code = excluded.status_code,
        duration_ms = excluded.duration_ms,
        provider = excluded.provider,
        model = excluded.model,
        task_type = excluded.task_type,
        upstream_request_id = excluded.upstream_request_id,
        error_message = excluded.error_message,
        request_summary = excluded.request_summary,
        response_summary = excluded.response_summary
    `, backendRequestLogToParams(event));
    return event;
  });
}

export async function listBackendRequestLogsPg(config, filters = {}) {
  return withBackendRequestLogsTable(config, async (client) => {
    const result = await client.query(`
      select *
      from backend_request_logs
      where ($1::text = '' or user_id = $1)
        and ($2::text = '' or task_type = $2)
        and ($3::text = '' or provider = $3)
        and ($4::text = '' or model = $4)
        and (
          $5::text = ''
          or ($5 = 'success' and status_code >= 200 and status_code < 400)
          or ($5 = 'failed' and (status_code < 200 or status_code >= 400))
        )
        and ($6::timestamptz is null or created_at >= $6)
        and ($7::timestamptz is null or created_at <= $7)
      order by created_at desc
      limit $8
    `, [
      filters.userId || "",
      filters.taskType || "",
      filters.provider || "",
      filters.model || "",
      filters.status || "",
      toDateOrNull(filters.from),
      toDateOrNull(filters.to),
      Math.max(1, Math.min(500, Number(filters.limit || 100))),
    ]);
    return result.rows.map(rowToBackendRequestLog);
  });
}

export async function summarizeBackendRequestLogsPg(config, filters = {}) {
  return withBackendRequestLogsTable(config, async (client) => {
    const params = [
      filters.userId || "",
      filters.taskType || "",
      filters.provider || "",
      filters.model || "",
      filters.status || "",
      toDateOrNull(filters.from),
      toDateOrNull(filters.to),
    ];
    const total = await client.query(`
      select
        count(*)::int as requests,
        coalesce(sum(case when status_code >= 200 and status_code < 400 then 1 else 0 end), 0)::int as success_requests,
        coalesce(sum(case when status_code < 200 or status_code >= 400 then 1 else 0 end), 0)::int as failed_requests,
        coalesce(avg(duration_ms), 0)::float8 as average_duration_ms
      from backend_request_logs
      where ($1::text = '' or user_id = $1)
        and ($2::text = '' or task_type = $2)
        and ($3::text = '' or provider = $3)
        and ($4::text = '' or model = $4)
        and (
          $5::text = ''
          or ($5 = 'success' and status_code >= 200 and status_code < 400)
          or ($5 = 'failed' and (status_code < 200 or status_code >= 400))
        )
        and ($6::timestamptz is null or created_at >= $6)
        and ($7::timestamptz is null or created_at <= $7)
    `, params);
    const byTaskType = await summarizeBackendRequestBucket(client, "task_type", params);
    const byStatus = await summarizeBackendStatusBucket(client, params);
    return {
      totalRequests: Number(total.rows[0]?.requests || 0),
      successRequests: Number(total.rows[0]?.success_requests || 0),
      failedRequests: Number(total.rows[0]?.failed_requests || 0),
      averageDurationMs: Math.round(Number(total.rows[0]?.average_duration_ms || 0)),
      byTaskType,
      byStatus,
    };
  });
}

export async function deleteBackendRequestLogsBeforePg(config, before) {
  return withBackendRequestLogsTable(config, async (client) => {
    const result = await client.query("delete from backend_request_logs where created_at < $1", [before]);
    return Number(result.rowCount || 0);
  });
}

async function withBackendRequestLogsTable(config, callback) {
  return withPgClient(config, async (client) => {
    await ensureBackendRequestLogsTable(config, client);
    try {
      return await callback(client);
    } catch (error) {
      if (!isBackendRequestLogsMissingError(error)) throw error;
      backendRequestLogsSchemaReady.delete(backendRequestLogsSchemaKey(config));
      await ensureBackendRequestLogsTable(config, client);
      return callback(client);
    }
  });
}

async function ensureBackendRequestLogsTable(config, client) {
  const schemaKey = backendRequestLogsSchemaKey(config);
  if (backendRequestLogsSchemaReady.has(schemaKey)) return;
  await client.query(`
    create table if not exists backend_request_logs (
      id text primary key,
      request_id text not null,
      user_id text not null references users(id) on delete cascade,
      user_email text not null default '',
      endpoint_path text not null default '',
      method text not null default 'POST',
      status_code integer not null default 0,
      duration_ms integer not null default 0,
      provider text not null default '',
      model text not null default '',
      task_type text not null default '',
      upstream_request_id text not null default '',
      error_message text not null default '',
      request_summary jsonb not null default '{}'::jsonb,
      response_summary jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    )
  `);
  await client.query("create index if not exists idx_backend_request_logs_user_created on backend_request_logs(user_id, created_at desc)");
  await client.query("create index if not exists idx_backend_request_logs_created on backend_request_logs(created_at desc)");
  await client.query("create index if not exists idx_backend_request_logs_status on backend_request_logs(status_code, created_at desc)");
  await client.query("create index if not exists idx_backend_request_logs_task_type on backend_request_logs(task_type, created_at desc)");
  backendRequestLogsSchemaReady.add(schemaKey);
}

function backendRequestLogsSchemaKey(config) {
  return String(config.databaseUrl || "default");
}

function isBackendRequestLogsMissingError(error) {
  return error?.code === "42P01" && /backend_request_logs/i.test(String(error?.message || ""));
}

async function summarizeBackendRequestBucket(client, column, params) {
  const result = await client.query(`
    select
      ${column} as key,
      count(*)::int as requests,
      coalesce(sum(case when status_code < 200 or status_code >= 400 then 1 else 0 end), 0)::int as failed,
      coalesce(avg(duration_ms), 0)::float8 as average_duration_ms
    from backend_request_logs
    where ($1::text = '' or user_id = $1)
      and ($2::text = '' or task_type = $2)
      and ($3::text = '' or provider = $3)
      and ($4::text = '' or model = $4)
      and (
        $5::text = ''
        or ($5 = 'success' and status_code >= 200 and status_code < 400)
        or ($5 = 'failed' and (status_code < 200 or status_code >= 400))
      )
      and ($6::timestamptz is null or created_at >= $6)
      and ($7::timestamptz is null or created_at <= $7)
    group by ${column}
    order by requests desc
  `, params);
  return Object.fromEntries(result.rows.map((row) => [
    row.key || "unknown",
    {
      requests: Number(row.requests || 0),
      failed: Number(row.failed || 0),
      averageDurationMs: Math.round(Number(row.average_duration_ms || 0)),
    },
  ]));
}

async function summarizeBackendStatusBucket(client, params) {
  const result = await client.query(`
    select
      case when status_code = 0 then 'network' else floor(status_code / 100)::int::text || 'xx' end as key,
      count(*)::int as requests,
      coalesce(sum(case when status_code < 200 or status_code >= 400 then 1 else 0 end), 0)::int as failed,
      coalesce(avg(duration_ms), 0)::float8 as average_duration_ms
    from backend_request_logs
    where ($1::text = '' or user_id = $1)
      and ($2::text = '' or task_type = $2)
      and ($3::text = '' or provider = $3)
      and ($4::text = '' or model = $4)
      and (
        $5::text = ''
        or ($5 = 'success' and status_code >= 200 and status_code < 400)
        or ($5 = 'failed' and (status_code < 200 or status_code >= 400))
      )
      and ($6::timestamptz is null or created_at >= $6)
      and ($7::timestamptz is null or created_at <= $7)
    group by key
    order by requests desc
  `, params);
  return Object.fromEntries(result.rows.map((row) => [
    row.key || "unknown",
    {
      requests: Number(row.requests || 0),
      failed: Number(row.failed || 0),
      averageDurationMs: Math.round(Number(row.average_duration_ms || 0)),
    },
  ]));
}

async function summarizeUsageBucket(client, column, params) {
  const result = await client.query(`
    select
      ${column} as key,
      count(*)::int as requests,
      coalesce(sum(tokens_prompt), 0)::int as prompt_tokens,
      coalesce(sum(tokens_completion), 0)::int as completion_tokens,
      coalesce(sum(cost_units), 0)::float8 as cost_units
    from usage_events
    where user_id = $1
      and ($2::text = '' or task_type = $2)
      and ($3::text = '' or provider = $3)
      and ($4::text = '' or model = $4)
      and ($5::timestamptz is null or created_at >= $5)
      and ($6::timestamptz is null or created_at <= $6)
    group by ${column}
    order by requests desc
  `, params);
  return Object.fromEntries(result.rows.map((row) => [
    row.key || "unknown",
    {
      requests: Number(row.requests || 0),
      promptTokens: Number(row.prompt_tokens || 0),
      completionTokens: Number(row.completion_tokens || 0),
      costUnits: Number(row.cost_units || 0),
    },
  ]));
}

export async function listJobsPg(config, userId, filters = {}) {
  return withPgClient(config, async (client) => {
    const result = await client.query(`
      select *
      from jobs
      where user_id = $1
        and ($2::text = '' or status = $2)
        and ($3::text = '' or kind = $3)
        and ($4::text = '' or scope = $4)
        and ($5::text = '' or workflow_id = $5)
        and ($6::text = '' or workflow_run_id = $6)
      order by created_at desc
    `, [
      userId,
      filters.status || "",
      filters.kind || "",
      filters.scope || "",
      filters.workflowId || "",
      filters.runId || "",
    ]);
    return result.rows.map(rowToJob);
  });
}

export async function listStaleRunningJobsPg(config, filters = {}) {
  return withPgClient(config, async (client) => {
    const result = await client.query(`
      select *
      from jobs
      where status = 'running'
        and completed_at is null
        and ($1::text = '' or kind = $1)
        and ($2::text = '' or scope = $2)
        and ($3::text = '' or node_id = $3)
        and coalesce(nullif(result->>'heartbeatAt', '')::timestamptz, started_at, queued_at, created_at) < $4::timestamptz
      order by coalesce(nullif(result->>'heartbeatAt', '')::timestamptz, started_at, queued_at, created_at) asc
      limit $5
    `, [
      filters.kind || "",
      filters.scope || "",
      filters.nodeId || "",
      toDateOrNull(filters.before) || new Date(0),
      Math.max(1, Number(filters.limit || 50)),
    ]);
    return result.rows.map(rowToJob);
  });
}

export async function getJobPg(config, jobId, userId = "") {
  return withPgClient(config, async (client) => {
    const result = await client.query(`
      select *
      from jobs
      where id = $1 and ($2::text = '' or user_id = $2)
      limit 1
    `, [jobId, userId || ""]);
    return result.rows[0] ? rowToJob(result.rows[0]) : null;
  });
}

export async function updateJobPg(config, jobId, input) {
  const existing = await getJobPg(config, jobId);
  if (!existing) return null;
  const updated = applyPgJobPatch(existing, input);
  await upsertJobPg(config, updated);
  return updated;
}

export async function updateJobIfStatusPg(config, jobId, expectedStatuses, input) {
  return withPgClient(config, async (client) => {
    await client.query("begin");
    try {
      const result = await client.query(`
        select *
        from jobs
        where id = $1
        for update
      `, [jobId]);
      if (!result.rows[0] || !expectedStatuses.includes(result.rows[0].status)) {
        await client.query("commit");
        return null;
      }
      const updated = applyPgJobPatch(rowToJob(result.rows[0]), input);
      await upsertJobWithClient(client, updated);
      await client.query("commit");
      return updated;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export async function claimQueuedJobPg(config, jobId) {
  return withPgClient(config, async (client) => {
    const result = await client.query(`
      update jobs
      set status = 'running',
          started_at = now()
      where id = $1 and status = 'queued'
      returning *
    `, [jobId]);
    return result.rows[0] ? rowToJob(result.rows[0]) : null;
  });
}

export async function requeueInterruptedJobsPg(config, filters = {}) {
  return withPgClient(config, async (client) => {
    const excludedNodeIds = Array.isArray(filters.excludeNodeIds) ? filters.excludeNodeIds : [];
    const result = await client.query(`
      update jobs
      set status = 'queued',
          attempts = attempts + 1,
          error = case when error = '' then '服务重启后自动重新排队。' else error end,
          queued_at = now(),
          started_at = null
      where status = 'running'
        and completed_at is null
        and ($1::text = '' or kind = $1)
        and ($2::text = '' or scope = $2)
        and ($3::text = '' or node_id = $3)
        and not (node_id = any($4::text[]))
      returning *
    `, [filters.kind || "", filters.scope || "", filters.nodeId || "", excludedNodeIds]);
    return result.rows.map(rowToJob);
  });
}

export async function listQueuedJobsPg(config, filters = {}) {
  return withPgClient(config, async (client) => {
    const limit = Math.max(1, Number(filters.limit || 10));
    const result = await client.query(`
      select *
      from jobs
      where status = 'queued'
        and ($1::text = '' or kind = $1)
        and ($2::text = '' or scope = $2)
        and ($3::text = '' or node_id = $3)
      order by priority desc, queued_at asc
      limit $4
    `, [filters.kind || "", filters.scope || "", filters.nodeId || "", limit]);
    return result.rows.map(rowToJob);
  });
}

function applyPgJobPatch(job, input) {
  const now = new Date().toISOString();
  const next = { ...job };
  if (input.kind !== undefined) next.kind = String(input.kind || "").trim();
  if (input.scope !== undefined) next.scope = String(input.scope || "").trim();
  if (input.workflowId !== undefined) next.workflowId = String(input.workflowId || "").trim();
  if (input.runId !== undefined) next.runId = String(input.runId || "").trim();
  if (input.nodeId !== undefined) next.nodeId = String(input.nodeId || "").trim();
  if (input.title !== undefined) next.title = String(input.title || "").trim();
  if (input.priority !== undefined) next.priority = Number(input.priority || 0);
  if (input.attempts !== undefined) next.attempts = Number(input.attempts || 0);
  if (input.progress !== undefined) next.progress = Number(input.progress || 0);
  if (input.payload !== undefined) next.payload = input.payload && typeof input.payload === "object" ? input.payload : {};
  if (input.result !== undefined) next.result = input.result && typeof input.result === "object" ? input.result : {};
  if (input.error !== undefined) next.error = String(input.error || "");
  if (input.status !== undefined) {
    const previousStatus = next.status;
    next.status = String(input.status || "").trim();
    if (next.status === "running" && previousStatus !== "running") next.startedAt = now;
    if (["done", "error", "canceled"].includes(next.status)) next.completedAt = now;
    if (next.status === "queued") {
      next.queuedAt = now;
      next.startedAt = "";
      next.completedAt = "";
    }
  }
  return next;
}

function upsertMembershipWithClient(client, userId, membership) {
  return client.query(`
    insert into memberships (
      user_id, status, plan, starts_at, ends_at, workflow_limit,
      concurrent_jobs, asset_limit_per_type, team_seat_limit
    )
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    on conflict (user_id) do update set
      status = excluded.status,
      plan = excluded.plan,
      starts_at = excluded.starts_at,
      ends_at = excluded.ends_at,
      workflow_limit = excluded.workflow_limit,
      concurrent_jobs = excluded.concurrent_jobs,
      asset_limit_per_type = excluded.asset_limit_per_type,
      team_seat_limit = excluded.team_seat_limit,
      updated_at = now()
  `, [
    userId,
    membership.status || "inactive",
    membership.plan || "basic",
    toDateOrNull(membership.startsAt),
    toDateOrNull(membership.endsAt),
    Number(membership.workflowLimit || 10),
    Number(membership.concurrentJobs || 2),
    Number(membership.assetLimitPerType || 10),
    Number(membership.teamSeatLimit || 1),
  ]);
}

function rowToUser(row) {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash || "",
    displayName: row.display_name || "",
    role: row.role || "user",
    approvalStatus: row.approval_status || "pending",
    disabledAt: toIso(row.disabled_at),
    lastLoginAt: toIso(row.last_login_at),
    membership: {
      status: row.membership_status || "inactive",
      plan: row.plan || "basic",
      startsAt: toIso(row.starts_at),
      endsAt: toIso(row.ends_at),
      workflowLimit: Number(row.workflow_limit || 10),
      concurrentJobs: Number(row.concurrent_jobs || 2),
      assetLimitPerType: Number(row.asset_limit_per_type || 10),
      teamSeatLimit: Number(row.team_seat_limit || 1),
    },
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function rowToSession(row) {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    revokedAt: toIso(row.revoked_at),
    expiresAt: toIso(row.expires_at),
    createdAt: toIso(row.created_at),
  };
}

function rowToApiKey(row) {
  return {
    id: row.id,
    userId: row.user_id,
    teamId: row.team_id || "",
    serviceType: row.service_type,
    channel: row.channel,
    encryptedApiKey: row.encrypted_api_key,
    endpoint: row.endpoint || "",
    model: row.model || "",
    authType: row.auth_type || "Bearer",
    protocol: row.protocol || "",
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function rowToAssetGroup(row) {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    name: row.name,
    desc: row.description || "",
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function rowToAsset(row) {
  return {
    id: row.id,
    userId: row.user_id,
    teamId: row.team_id || "",
    scope: row.scope || "personal",
    reviewStatus: row.review_status || "approved",
    submittedByUserId: row.submitted_by_user_id || "",
    reviewedByUserId: row.reviewed_by_user_id || "",
    reviewedAt: toIso(row.reviewed_at),
    type: row.type,
    groupId: row.group_id || "",
    name: row.name,
    payload: row.payload || {},
    fileUrl: row.file_url || "",
    fileKey: row.file_key || "",
    mimeType: row.mime_type || "",
    sizeBytes: Number(row.size_bytes || 0),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function rowToWorkflow(row) {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    type: row.type,
    config: row.config || {},
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function rowToWorkflowRun(row) {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    userId: row.user_id,
    parentRunId: row.parent_run_id || "",
    kind: row.kind || "topic-seed",
    serial: row.serial || "",
    topic: row.topic || "",
    status: row.status || "waiting",
    stages: row.stages || {},
    generatedTopics: Array.isArray(row.generated_topics) ? row.generated_topics : [],
    confirmedTopics: Array.isArray(row.confirmed_topics) ? row.confirmed_topics : [],
    confirmedTopicIndexes: Array.isArray(row.confirmed_topic_indexes) ? row.confirmed_topic_indexes : [],
    selectedTopics: Array.isArray(row.selected_topics) ? row.selected_topics : [],
    topicGenerationStatus: row.topic_generation_status || "",
    topicGenerationError: row.topic_generation_error || "",
    result: row.result || {},
    error: row.error || "",
    createdAt: toIso(row.created_at),
    startedAt: toIso(row.started_at),
    completedAt: toIso(row.completed_at),
    updatedAt: toIso(row.updated_at),
  };
}

function rowToWorkflowVideoTask(row) {
  const video = row.payload && typeof row.payload === "object" ? { ...row.payload } : {};
  const providerTaskId = String(row.provider_task_id || "").trim();
  return {
    id: row.id,
    userId: row.user_id,
    workflowId: row.workflow_id,
    runId: row.workflow_run_id,
    resultKey: row.result_key,
    sortOrder: Number(row.sort_order || 0),
    video: {
      ...video,
      taskId: providerTaskId || video.taskId || "",
      status: row.status || video.status || "queued",
      submissionState: row.submission_state || video.submissionState || "queued",
    },
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function workflowImageShotId(shot = {}) {
  return String(shot.id || shot.shotId || shot.uuid || "").trim();
}

function workflowImageShotPatchMatches(shot = {}, input = {}) {
  if (input.expectedJobId !== undefined && String(shot.imageJobId || "").trim() !== String(input.expectedJobId || "").trim()) {
    return false;
  }
  if (input.expectedRequestId !== undefined && String(shot.imageRequestId || "").trim() !== String(input.expectedRequestId || "").trim()) {
    return false;
  }
  const expectedStatuses = Array.isArray(input.expectedStatuses)
    ? input.expectedStatuses.map((status) => String(status || "").trim()).filter(Boolean)
    : [];
  if (expectedStatuses.length && !expectedStatuses.includes(String(shot.imageStatus || "").trim())) {
    return false;
  }
  if (input.requireMissingImage && String(shot.imageUrl || "").trim()) {
    return false;
  }
  return true;
}

function rowToJob(row) {
  return {
    id: row.id,
    userId: row.user_id,
    workflowId: row.workflow_id || "",
    runId: row.workflow_run_id || "",
    nodeId: row.node_id || "",
    kind: row.kind || "workflow-node",
    scope: row.scope || "workflow",
    title: row.title || "",
    status: row.status || "queued",
    progress: Number(row.progress || 0),
    payload: row.payload || {},
    result: row.result || {},
    attempts: Number(row.attempts || 0),
    priority: Number(row.priority || 0),
    error: row.error || "",
    queuedAt: toIso(row.queued_at),
    startedAt: toIso(row.started_at),
    completedAt: toIso(row.completed_at),
    createdAt: toIso(row.created_at),
  };
}

function rowToWorkerHeartbeat(row) {
  return {
    name: row.name,
    heartbeatAt: toIso(row.heartbeat_at),
    metadata: row.metadata || {},
  };
}

function rowToUsageEvent(row) {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider || "",
    model: row.model || "",
    taskType: row.task_type || "",
    requestId: row.request_id || "",
    tokensPrompt: Number(row.tokens_prompt || 0),
    tokensCompletion: Number(row.tokens_completion || 0),
    costUnits: Number(row.cost_units || 0),
    raw: row.raw || {},
    createdAt: toIso(row.created_at),
  };
}

function rowToBackendRequestLog(row) {
  return {
    id: row.id,
    requestId: row.request_id || "",
    userId: row.user_id || "",
    userEmail: row.user_email || "",
    endpointPath: row.endpoint_path || "",
    method: row.method || "POST",
    statusCode: Number(row.status_code || 0),
    durationMs: Number(row.duration_ms || 0),
    provider: row.provider || "",
    model: row.model || "",
    taskType: row.task_type || "",
    upstreamRequestId: row.upstream_request_id || "",
    errorMessage: row.error_message || "",
    requestSummary: row.request_summary || {},
    responseSummary: row.response_summary || {},
    createdAt: toIso(row.created_at),
  };
}

function rowToAdminAuditEvent(row) {
  return {
    id: row.id,
    actorUserId: row.actor_user_id || "",
    actorEmail: row.actor_email || "",
    action: row.action || "",
    targetUserId: row.target_user_id || "",
    targetEmail: row.target_email || "",
    details: row.details || {},
    createdAt: toIso(row.created_at),
  };
}

function workflowRunToParams(run) {
  return [
    run.id,
    run.workflowId,
    run.userId,
    run.parentRunId || null,
    run.kind || "topic-seed",
    run.serial || "",
    run.topic || "",
    run.status || "waiting",
    toJsonParam(run.stages, {}),
    toJsonParam(Array.isArray(run.generatedTopics) ? run.generatedTopics : [], []),
    toJsonParam(Array.isArray(run.confirmedTopics) ? run.confirmedTopics : [], []),
    toJsonParam(Array.isArray(run.confirmedTopicIndexes) ? run.confirmedTopicIndexes : [], []),
    toJsonParam(Array.isArray(run.selectedTopics) ? run.selectedTopics : [], []),
    run.topicGenerationStatus || "",
    run.topicGenerationError || "",
    toJsonParam(run.result, {}),
    run.error || "",
    toDateOrNow(run.createdAt),
    toDateOrNull(run.startedAt),
    toDateOrNull(run.completedAt),
    toDateOrNow(run.updatedAt),
  ];
}

function jobToParams(job) {
  return [
    job.id,
    job.userId,
    job.workflowId || null,
    job.runId || null,
    job.nodeId || "",
    job.kind || "workflow-node",
    job.scope || "workflow",
    job.title || "",
    job.status || "queued",
    Number(job.progress || 0),
    toJsonParam(job.payload, {}),
    toJsonParam(job.result, {}),
    Number(job.attempts || 0),
    Number(job.priority || 0),
    job.error || "",
    toDateOrNow(job.queuedAt),
    toDateOrNull(job.startedAt),
    toDateOrNull(job.completedAt),
    toDateOrNow(job.createdAt),
  ];
}

function usageEventToParams(event) {
  return [
    event.id,
    event.userId,
    event.provider || "",
    event.model || "",
    event.taskType || event.type || "",
    event.requestId || "",
    Number(event.tokensPrompt || event.promptTokens || 0),
    Number(event.tokensCompletion || event.completionTokens || 0),
    Number(event.costUnits || event.cost || 0),
    toJsonParam(event.raw, {}),
    toDateOrNow(event.createdAt),
  ];
}

function backendRequestLogToParams(event) {
  return [
    event.id,
    event.requestId || "",
    event.userId || null,
    event.userEmail || "",
    event.endpointPath || "",
    event.method || "POST",
    Number(event.statusCode || 0),
    Number(event.durationMs || 0),
    event.provider || "",
    event.model || "",
    event.taskType || "",
    event.upstreamRequestId || "",
    event.errorMessage || "",
    toJsonParam(event.requestSummary, {}),
    toJsonParam(event.responseSummary, {}),
    toDateOrNow(event.createdAt),
  ];
}

function toJsonParam(value, fallback) {
  const safeValue = value === undefined ? fallback : value;
  return JSON.stringify(safeValue === undefined ? null : safeValue);
}

function toDateOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toDateOrNow(value) {
  return toDateOrNull(value) || new Date();
}

function toIso(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}
