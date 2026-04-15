create table if not exists hotfix_project_graph_nodes (
    id uuid primary key,
    hotfix_project_id uuid not null references hotfix_projects(id) on delete cascade,
    imported_sentry_project_id uuid references imported_sentry_projects(id) on delete set null,
    node_key text not null,
    node_type text not null,
    label text not null,
    description text,
    position_x double precision not null default 0,
    position_y double precision not null default 0,
    metadata jsonb not null default '{}'::jsonb,
    is_system boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (hotfix_project_id, node_key)
);

create index if not exists hotfix_project_graph_nodes_project_idx
    on hotfix_project_graph_nodes (hotfix_project_id, node_type, label);

create table if not exists hotfix_project_graph_edges (
    id uuid primary key,
    hotfix_project_id uuid not null references hotfix_projects(id) on delete cascade,
    edge_key text not null,
    edge_type text not null,
    source_node_id uuid not null references hotfix_project_graph_nodes(id) on delete cascade,
    target_node_id uuid not null references hotfix_project_graph_nodes(id) on delete cascade,
    label text,
    metadata jsonb not null default '{}'::jsonb,
    is_system boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (hotfix_project_id, edge_key)
);

create index if not exists hotfix_project_graph_edges_project_idx
    on hotfix_project_graph_edges (hotfix_project_id, edge_type);
