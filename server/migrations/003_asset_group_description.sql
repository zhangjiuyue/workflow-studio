alter table asset_groups
  add column if not exists description text not null default '';
