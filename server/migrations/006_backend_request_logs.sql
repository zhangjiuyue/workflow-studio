create table if not exists backend_request_logs (
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

create index if not exists idx_backend_request_logs_user_created on backend_request_logs(user_id, created_at desc);
create index if not exists idx_backend_request_logs_created on backend_request_logs(created_at desc);
create index if not exists idx_backend_request_logs_status on backend_request_logs(status_code, created_at desc);
create index if not exists idx_backend_request_logs_task_type on backend_request_logs(task_type, created_at desc);
