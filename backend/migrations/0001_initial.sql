create table if not exists users (
    id uuid primary key,
    display_name text not null,
    email text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists auth_identities (
    id uuid primary key,
    user_id uuid not null references users(id) on delete cascade,
    provider text not null,
    provider_user_id text not null,
    username text,
    display_name text not null,
    email text,
    avatar_url text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    last_login_at timestamptz not null default now(),
    unique (provider, provider_user_id)
);

create index if not exists auth_identities_user_id_idx on auth_identities (user_id);
