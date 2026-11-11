alter table memberships drop constraint if exists memberships_plan_check;
alter table memberships
  add constraint memberships_plan_check
  check (plan in ('basic', 'pro', 'team'));

alter table memberships
  add column if not exists team_seat_limit integer not null default 1;

create table if not exists teams (
  id text primary key,
  name text not null,
  owner_user_id text not null references users(id) on delete cascade,
  invite_code text not null unique,
  seat_limit integer not null default 1,
  status text not null default 'active' check (status in ('active', 'deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists team_members (
  id text primary key,
  team_id text not null references teams(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  status text not null default 'active' check (status in ('active', 'left')),
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, user_id)
);

create unique index if not exists idx_team_members_one_active_team
  on team_members(user_id)
  where status = 'active';

create index if not exists idx_team_members_team_active
  on team_members(team_id, status);

create index if not exists idx_teams_owner
  on teams(owner_user_id);

alter table api_keys
  add column if not exists team_id text references teams(id) on delete cascade;

create index if not exists idx_api_keys_team_type
  on api_keys(team_id, service_type)
  where team_id is not null;

alter table assets
  add column if not exists team_id text references teams(id) on delete set null,
  add column if not exists scope text not null default 'personal',
  add column if not exists review_status text not null default 'approved',
  add column if not exists submitted_by_user_id text references users(id) on delete set null,
  add column if not exists reviewed_by_user_id text references users(id) on delete set null,
  add column if not exists reviewed_at timestamptz;

alter table assets drop constraint if exists assets_scope_check;
alter table assets
  add constraint assets_scope_check
  check (scope in ('personal', 'team'));

alter table assets drop constraint if exists assets_review_status_check;
alter table assets
  add constraint assets_review_status_check
  check (review_status in ('approved', 'pending', 'rejected'));

create index if not exists idx_assets_team_type_status
  on assets(team_id, type, review_status)
  where team_id is not null;
