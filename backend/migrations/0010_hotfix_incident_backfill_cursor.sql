alter table hotfix_projects
    add column if not exists last_incident_backfill_at timestamptz;
