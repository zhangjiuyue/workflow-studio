-- Allow the PostgreSQL task queue to be adopted before workflow rows are fully migrated.
-- The identifiers remain stored as text on jobs and are still indexed/filterable by the app.

alter table jobs drop constraint if exists jobs_workflow_id_fkey;
alter table jobs drop constraint if exists jobs_workflow_run_id_fkey;
