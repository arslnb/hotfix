create table if not exists sentry_issue_snapshots (
    id uuid primary key,
    hotfix_project_id uuid not null references hotfix_projects(id) on delete cascade,
    imported_sentry_project_id uuid not null references imported_sentry_projects(id) on delete cascade,
    sentry_issue_id text not null,
    short_id text,
    title text not null,
    culprit text,
    level text,
    status text not null,
    event_count bigint not null default 0,
    user_count bigint not null default 0,
    permalink text,
    exemplar_event_id text,
    release_name text,
    environment text,
    trace_id text,
    first_seen_at timestamptz,
    last_seen_at timestamptz,
    metadata jsonb not null default '{}'::jsonb,
    last_backfilled_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (imported_sentry_project_id, sentry_issue_id)
);

create index if not exists sentry_issue_snapshots_project_idx
    on sentry_issue_snapshots (hotfix_project_id, last_seen_at desc);

create table if not exists sentry_issue_code_refs (
    id uuid primary key,
    sentry_issue_snapshot_id uuid not null references sentry_issue_snapshots(id) on delete cascade,
    github_repo_id bigint,
    github_repo_full_name text,
    github_repo_url text,
    path text not null,
    start_line integer,
    end_line integer,
    symbol text,
    confidence double precision not null default 0,
    source text not null default 'stack_frame',
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists sentry_issue_code_refs_snapshot_idx
    on sentry_issue_code_refs (sentry_issue_snapshot_id);

create table if not exists hotfix_incidents (
    id uuid primary key,
    hotfix_project_id uuid not null references hotfix_projects(id) on delete cascade,
    incident_key text not null,
    title text not null,
    status text not null,
    first_seen_at timestamptz,
    last_seen_at timestamptz,
    issue_count integer not null default 0,
    sentry_project_count integer not null default 0,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (hotfix_project_id, incident_key)
);

create index if not exists hotfix_incidents_project_idx
    on hotfix_incidents (hotfix_project_id, last_seen_at desc);

create table if not exists incident_sentry_issues (
    id uuid primary key,
    incident_id uuid not null references hotfix_incidents(id) on delete cascade,
    sentry_issue_snapshot_id uuid not null references sentry_issue_snapshots(id) on delete cascade,
    created_at timestamptz not null default now(),
    unique (incident_id, sentry_issue_snapshot_id)
);

create index if not exists incident_sentry_issues_incident_idx
    on incident_sentry_issues (incident_id);

create table if not exists incident_code_refs (
    id uuid primary key,
    incident_id uuid not null references hotfix_incidents(id) on delete cascade,
    github_repo_id bigint,
    github_repo_full_name text,
    github_repo_url text,
    path text not null,
    start_line integer,
    end_line integer,
    symbol text,
    confidence double precision not null default 0,
    source text not null default 'stack_frame',
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists incident_code_refs_incident_idx
    on incident_code_refs (incident_id);
