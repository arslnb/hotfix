alter table imported_sentry_projects
    add column if not exists included boolean not null default true;
