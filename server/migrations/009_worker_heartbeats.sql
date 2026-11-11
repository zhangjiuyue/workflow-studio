create table if not exists worker_heartbeats (
  name text primary key,
  heartbeat_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);
