alter table hotfix_project_graph_nodes
    add column if not exists github_repo_selected_branch text,
    add column if not exists indexed_commit_sha text;

update hotfix_project_graph_nodes
set github_repo_selected_branch = coalesce(github_repo_selected_branch, github_repo_default_branch)
where github_repo_id is not null;

create table if not exists repo_snapshots (
    id uuid primary key,
    github_repo_id bigint not null,
    github_repo_full_name text not null,
    github_repo_url text not null,
    github_repo_default_branch text,
    github_repo_selected_branch text not null,
    commit_sha text not null,
    base_directory text not null default '',
    snapshot_artifact_key text not null,
    artifact_ready_at timestamptz,
    indexed_at timestamptz,
    last_error text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create unique index if not exists repo_snapshots_identity_idx
    on repo_snapshots (github_repo_id, github_repo_selected_branch, commit_sha, base_directory);

create index if not exists repo_snapshots_repo_idx
    on repo_snapshots (github_repo_id, github_repo_selected_branch, created_at desc);

create table if not exists index_jobs (
    id uuid primary key,
    repo_snapshot_id uuid not null references repo_snapshots(id) on delete cascade,
    hotfix_project_graph_node_id uuid not null references hotfix_project_graph_nodes(id) on delete cascade,
    status text not null default 'queued',
    progress_percentage integer not null default 0,
    error_summary text,
    started_at timestamptz,
    finished_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create unique index if not exists index_jobs_node_snapshot_idx
    on index_jobs (hotfix_project_graph_node_id, repo_snapshot_id);

create index if not exists index_jobs_status_idx
    on index_jobs (status, created_at desc);

alter table index_jobs
    drop constraint if exists index_jobs_progress_percentage_check;

alter table index_jobs
    add constraint index_jobs_progress_percentage_check
    check (progress_percentage >= 0 and progress_percentage <= 100);

create table if not exists repo_snapshot_modules (
    id uuid primary key,
    repo_snapshot_id uuid not null references repo_snapshots(id) on delete cascade,
    path text not null,
    language text,
    line_count integer not null default 0,
    summary text not null,
    created_at timestamptz not null default now(),
    unique (repo_snapshot_id, path)
);

create table if not exists repo_snapshot_imports (
    id uuid primary key,
    repo_snapshot_id uuid not null references repo_snapshots(id) on delete cascade,
    source_path text not null,
    raw_import text not null,
    resolved_path text,
    import_kind text not null,
    line_number integer,
    created_at timestamptz not null default now()
);

create index if not exists repo_snapshot_imports_snapshot_idx
    on repo_snapshot_imports (repo_snapshot_id, source_path);

create table if not exists repo_snapshot_symbols (
    id uuid primary key,
    repo_snapshot_id uuid not null references repo_snapshots(id) on delete cascade,
    path text not null,
    symbol_kind text not null,
    symbol_name text not null,
    line_number integer,
    created_at timestamptz not null default now()
);

create index if not exists repo_snapshot_symbols_snapshot_idx
    on repo_snapshot_symbols (repo_snapshot_id, path);

create table if not exists repo_snapshot_entrypoints (
    id uuid primary key,
    repo_snapshot_id uuid not null references repo_snapshots(id) on delete cascade,
    path text not null,
    entrypoint_kind text not null,
    label text not null,
    line_number integer,
    created_at timestamptz not null default now()
);

create index if not exists repo_snapshot_entrypoints_snapshot_idx
    on repo_snapshot_entrypoints (repo_snapshot_id, path);

create table if not exists repo_snapshot_log_statements (
    id uuid primary key,
    repo_snapshot_id uuid not null references repo_snapshots(id) on delete cascade,
    path text not null,
    level text,
    expression text not null,
    line_number integer,
    created_at timestamptz not null default now()
);

create index if not exists repo_snapshot_logs_snapshot_idx
    on repo_snapshot_log_statements (repo_snapshot_id, path);

create table if not exists repo_snapshot_deploy_signals (
    id uuid primary key,
    repo_snapshot_id uuid not null references repo_snapshots(id) on delete cascade,
    path text not null,
    signal_kind text not null,
    evidence text not null,
    created_at timestamptz not null default now()
);

create index if not exists repo_snapshot_deploy_signals_snapshot_idx
    on repo_snapshot_deploy_signals (repo_snapshot_id, path);
