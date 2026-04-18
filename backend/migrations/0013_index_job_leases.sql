alter table index_jobs
    add column if not exists claimed_by text,
    add column if not exists claimed_at timestamptz,
    add column if not exists lease_expires_at timestamptz,
    add column if not exists attempt_count integer not null default 0;

create index if not exists index_jobs_claiming_idx
    on index_jobs (status, lease_expires_at, created_at);
