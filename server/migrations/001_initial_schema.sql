-- FlowStudio private beta database schema
-- Recommended database: PostgreSQL 15+
-- This schema mirrors the current product rules:
-- basic plan: 10 workflows, 2 concurrent model jobs, 10 assets per type
-- pro plan: 20 workflows, 5 concurrent model jobs, 20 assets per type

create extension if not exists pgcrypto;

create table users (
  id text primary key,
  email text unique not null,
  password_hash text,
  display_name text not null default '',
  role text not null default 'user' check (role in ('user', 'admin')),
  approval_status text not null default 'pending' check (approval_status in ('pending', 'approved', 'rejected')),
  disabled_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table sessions (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  token_hash text not null unique,
  revoked_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table memberships (
  id text primary key default gen_random_uuid()::text,
  user_id text not null unique references users(id) on delete cascade,
  status text not null default 'inactive' check (status in ('inactive', 'active')),
  plan text not null default 'basic' check (plan in ('basic', 'pro')),
  starts_at timestamptz,
  ends_at timestamptz,
  workflow_limit integer not null default 10,
  concurrent_jobs integer not null default 2,
  asset_limit_per_type integer not null default 10,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table api_keys (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  service_type text not null check (service_type in ('llm', 'image', 'video', 'audio', 'draft')),
  channel text not null,
  encrypted_api_key text not null,
  endpoint text not null default '',
  model text not null default '',
  auth_type text not null default 'Bearer',
  protocol text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table asset_groups (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  type text not null,
  name text not null,
  description text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, type, name)
);

create table assets (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  type text not null,
  group_id text references asset_groups(id) on delete set null,
  name text not null,
  payload jsonb not null default '{}'::jsonb,
  file_url text not null default '',
  file_key text not null default '',
  mime_type text not null default '',
  size_bytes bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table workflows (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  name text not null,
  type text not null,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table workflow_runs (
  id text primary key,
  workflow_id text not null references workflows(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  parent_run_id text references workflow_runs(id) on delete cascade,
  kind text not null check (kind in ('main', 'child', 'topic-seed', 'topic-child')),
  serial text not null default '',
  topic text not null default '',
  status text not null default 'waiting' check (status in ('waiting', 'queued', 'running', 'done', 'error', 'cancelled', 'canceled', 'deleted')),
  stages jsonb not null default '{}'::jsonb,
  generated_topics jsonb not null default '[]'::jsonb,
  confirmed_topics jsonb not null default '[]'::jsonb,
  confirmed_topic_indexes jsonb not null default '[]'::jsonb,
  selected_topics jsonb not null default '[]'::jsonb,
  topic_generation_status text not null default '',
  topic_generation_error text not null default '',
  result jsonb not null default '{}'::jsonb,
  error text not null default '',
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create table jobs (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  workflow_id text references workflows(id) on delete set null,
  workflow_run_id text references workflow_runs(id) on delete set null,
  node_id text not null default '',
  kind text not null default 'workflow-node',
  scope text not null default 'workflow',
  title text not null default '',
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'error', 'canceled')),
  progress integer not null default 0,
  payload jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  attempts integer not null default 0,
  priority integer not null default 0,
  error text not null default '',
  queued_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create table usage_events (
  id text primary key default gen_random_uuid()::text,
  user_id text not null references users(id) on delete cascade,
  provider text not null,
  model text not null,
  task_type text not null,
  request_id text not null default '',
  tokens_prompt integer not null default 0,
  tokens_completion integer not null default 0,
  cost_units numeric not null default 0,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table backend_request_logs (
  id text primary key,
  request_id text not null default '',
  user_id text references users(id) on delete set null,
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
);

create table admin_audit_events (
  id text primary key,
  actor_user_id text references users(id) on delete set null,
  actor_email text not null default '',
  action text not null,
  target_user_id text references users(id) on delete set null,
  target_email text not null default '',
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index idx_sessions_user_id on sessions(user_id);
create index idx_sessions_token_hash on sessions(token_hash);
create index idx_api_keys_user_type on api_keys(user_id, service_type);
create index idx_asset_groups_user_type on asset_groups(user_id, type);
create index idx_assets_user_type on assets(user_id, type);
create index idx_assets_group_id on assets(group_id);
create index idx_workflows_user_id on workflows(user_id);
create index idx_workflow_runs_workflow_id on workflow_runs(workflow_id);
create index idx_workflow_runs_parent_run_id on workflow_runs(parent_run_id);
create index idx_jobs_user_status on jobs(user_id, status);
create index idx_jobs_queued_at on jobs(queued_at);
create index idx_usage_events_user_created on usage_events(user_id, created_at desc);
create index idx_backend_request_logs_user_created on backend_request_logs(user_id, created_at desc);
create index idx_backend_request_logs_created on backend_request_logs(created_at desc);
create index idx_backend_request_logs_status on backend_request_logs(status_code, created_at desc);
create index idx_backend_request_logs_task_type on backend_request_logs(task_type, created_at desc);
create index idx_admin_audit_events_created on admin_audit_events(created_at desc);
create index idx_admin_audit_events_target on admin_audit_events(target_user_id, created_at desc);
create index idx_admin_audit_events_action on admin_audit_events(action, created_at desc);
