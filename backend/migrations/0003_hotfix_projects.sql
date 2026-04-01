create table if not exists provider_connections (
    id uuid primary key,
    user_id uuid not null references users(id) on delete cascade,
    provider text not null,
    external_id text not null,
    slug text,
    display_name text not null,
    scopes text,
    access_token_nonce bytea not null,
    access_token_ciphertext bytea not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, provider, external_id)
);

create index if not exists provider_connections_user_provider_idx
    on provider_connections (user_id, provider);

create table if not exists hotfix_projects (
    id uuid primary key,
    user_id uuid not null references users(id) on delete cascade,
    name text not null,
    sentry_connection_id uuid references provider_connections(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists hotfix_projects_user_idx
    on hotfix_projects (user_id, created_at desc);

create table if not exists imported_sentry_projects (
    id uuid primary key,
    hotfix_project_id uuid not null references hotfix_projects(id) on delete cascade,
    sentry_connection_id uuid not null references provider_connections(id) on delete cascade,
    sentry_project_id text not null,
    slug text not null,
    name text not null,
    platform text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (hotfix_project_id, sentry_project_id)
);

create index if not exists imported_sentry_projects_hotfix_project_idx
    on imported_sentry_projects (hotfix_project_id, name);

create table if not exists sentry_project_repo_mappings (
    id uuid primary key,
    imported_sentry_project_id uuid not null unique references imported_sentry_projects(id) on delete cascade,
    github_repo_id bigint not null,
    github_repo_full_name text not null,
    github_repo_url text not null,
    github_repo_default_branch text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
