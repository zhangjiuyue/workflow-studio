create table if not exists workflow_video_tasks (
  id text primary key default gen_random_uuid()::text,
  user_id text not null references users(id) on delete cascade,
  workflow_id text not null references workflows(id) on delete cascade,
  workflow_run_id text not null references workflow_runs(id) on delete cascade,
  result_key text not null,
  timeline_item_id text not null default '',
  submission_job_id text not null default '',
  provider_task_id text not null default '',
  status text not null default 'queued',
  submission_state text not null default 'queued',
  sort_order integer not null default 0,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workflow_run_id, result_key)
);

create index if not exists idx_workflow_video_tasks_run
  on workflow_video_tasks(workflow_run_id, sort_order, created_at);

create index if not exists idx_workflow_video_tasks_user_status
  on workflow_video_tasks(user_id, status, updated_at desc);

create index if not exists idx_workflow_video_tasks_provider_task
  on workflow_video_tasks(provider_task_id)
  where provider_task_id <> '';

with legacy_videos as (
  select
    run.user_id,
    run.workflow_id,
    run.id as workflow_run_id,
    video.payload,
    video.ordinality::integer as sort_order,
    coalesce(
      nullif(video.payload->>'id', ''),
      nullif(video.payload->>'resultId', ''),
      nullif(video.payload->>'taskId', ''),
      nullif(video.payload#>>'{meta,taskId}', '')
    ) as instance_id,
    nullif(video.payload->>'timelineItemId', '') as timeline_item_id,
    coalesce(
      nullif(video.payload->>'createdAt', ''),
      nullif(video.payload->>'submittedAt', ''),
      nullif(video.payload->>'title', '')
    ) as legacy_suffix,
    run.created_at,
    run.updated_at
  from workflow_runs run
  cross join lateral jsonb_array_elements(
    case
      when jsonb_typeof(run.result->'videoResults') = 'array' then run.result->'videoResults'
      else '[]'::jsonb
    end
  ) with ordinality as video(payload, ordinality)
), keyed_videos as (
  select
    *,
    case
      when instance_id is not null then 'instance:' || instance_id
      when timeline_item_id is not null then 'legacy:' || timeline_item_id || ':' || coalesce(legacy_suffix, '')
      else ''
    end as result_key
  from legacy_videos
)
insert into workflow_video_tasks (
  user_id,
  workflow_id,
  workflow_run_id,
  result_key,
  timeline_item_id,
  submission_job_id,
  provider_task_id,
  status,
  submission_state,
  sort_order,
  payload,
  created_at,
  updated_at
)
select
  user_id,
  workflow_id,
  workflow_run_id,
  result_key,
  coalesce(timeline_item_id, ''),
  coalesce(payload->>'submissionJobId', ''),
  coalesce(nullif(payload->>'taskId', ''), nullif(payload#>>'{meta,taskId}', ''), ''),
  coalesce(nullif(payload->>'status', ''), 'queued'),
  coalesce(nullif(payload->>'submissionState', ''), 'queued'),
  sort_order,
  payload,
  created_at,
  updated_at
from keyed_videos
where result_key <> ''
on conflict (workflow_run_id, result_key) do nothing;
