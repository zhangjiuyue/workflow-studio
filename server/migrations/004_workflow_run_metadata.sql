alter table workflow_runs
  add column if not exists serial text not null default '',
  add column if not exists confirmed_topic_indexes jsonb not null default '[]'::jsonb,
  add column if not exists selected_topics jsonb not null default '[]'::jsonb,
  add column if not exists topic_generation_status text not null default '',
  add column if not exists topic_generation_error text not null default '',
  add column if not exists updated_at timestamptz not null default now();

alter table workflow_runs drop constraint if exists workflow_runs_kind_check;
alter table workflow_runs
  add constraint workflow_runs_kind_check
  check (kind in ('main', 'child', 'topic-seed', 'topic-child'));

alter table workflow_runs drop constraint if exists workflow_runs_status_check;
alter table workflow_runs
  add constraint workflow_runs_status_check
  check (status in ('waiting', 'queued', 'running', 'done', 'error', 'cancelled', 'canceled', 'deleted'));
