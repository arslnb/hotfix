alter table imported_sentry_projects
    add column if not exists errors_24h bigint not null default 0,
    add column if not exists transactions_24h bigint not null default 0,
    add column if not exists replays_24h bigint not null default 0,
    add column if not exists profiles_24h bigint not null default 0,
    add column if not exists sentry_repo_connected boolean not null default false,
    add column if not exists synced_at timestamptz;
