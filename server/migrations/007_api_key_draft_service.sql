alter table api_keys drop constraint if exists api_keys_service_type_check;

alter table api_keys
  add constraint api_keys_service_type_check
  check (service_type in ('llm', 'image', 'video', 'audio', 'draft'));
