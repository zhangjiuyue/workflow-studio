-- Upgrade only the previous standard quotas so intentional custom limits remain unchanged.
update memberships
set
  workflow_limit = case when workflow_limit = 20 then 30 else workflow_limit end,
  asset_limit_per_type = case when asset_limit_per_type = 20 then 30 else asset_limit_per_type end,
  updated_at = now()
where plan in ('pro', 'team')
  and (workflow_limit = 20 or asset_limit_per_type = 20);
