create table if not exists admin_audit_events (
  id text primary key,
  actor_user_id text references users(id) on delete set null,
  actor_email text not null default '',
  action text not null,
  target_user_id text references users(id) on delete set null,
  target_email text not null default '',
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_admin_audit_events_created on admin_audit_events(created_at desc);
create index if not exists idx_admin_audit_events_target on admin_audit_events(target_user_id, created_at desc);
create index if not exists idx_admin_audit_events_action on admin_audit_events(action, created_at desc);
