alter table imported_sentry_projects
    add column if not exists errors_24h_series jsonb not null default '[]'::jsonb,
    add column if not exists transactions_24h_series jsonb not null default '[]'::jsonb;
