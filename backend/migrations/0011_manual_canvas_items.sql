alter table hotfix_project_graph_nodes
    add column if not exists github_repo_id bigint,
    add column if not exists github_repo_full_name text,
    add column if not exists github_repo_url text,
    add column if not exists github_repo_default_branch text,
    add column if not exists base_directory text,
    add column if not exists indexing_status text not null default 'pending',
    add column if not exists indexing_percentage integer not null default 0,
    add column if not exists linked_imported_sentry_project_id uuid references imported_sentry_projects(id) on delete set null;

update hotfix_project_graph_nodes
set indexing_status = 'pending'
where indexing_status is null;

update hotfix_project_graph_nodes
set indexing_percentage = 0
where indexing_percentage is null;

alter table hotfix_project_graph_nodes
    drop constraint if exists hotfix_project_graph_nodes_indexing_percentage_check;

alter table hotfix_project_graph_nodes
    add constraint hotfix_project_graph_nodes_indexing_percentage_check
    check (indexing_percentage >= 0 and indexing_percentage <= 100);

create index if not exists hotfix_project_graph_nodes_linked_sentry_idx
    on hotfix_project_graph_nodes (linked_imported_sentry_project_id);
