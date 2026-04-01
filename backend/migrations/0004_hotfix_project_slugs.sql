alter table hotfix_projects
    add column if not exists slug text;

do $$
declare
    project_record record;
    base_slug text;
    candidate_slug text;
    slug_suffix integer;
begin
    for project_record in
        select id, name
        from hotfix_projects
        order by created_at asc, id asc
    loop
        base_slug := lower(regexp_replace(coalesce(project_record.name, ''), '[^a-zA-Z0-9]+', '-', 'g'));
        base_slug := regexp_replace(base_slug, '(^-+|-+$)', '', 'g');

        if base_slug = '' then
            base_slug := 'project';
        end if;

        if base_slug in ('api', 'privacy', 'terms') then
            base_slug := base_slug || '-project';
        end if;

        candidate_slug := base_slug;
        slug_suffix := 2;

        while exists(
            select 1
            from hotfix_projects
            where slug = candidate_slug
              and id <> project_record.id
        ) loop
            candidate_slug := base_slug || '-' || slug_suffix::text;
            slug_suffix := slug_suffix + 1;
        end loop;

        update hotfix_projects
        set slug = candidate_slug
        where id = project_record.id;
    end loop;
end
$$;

alter table hotfix_projects
    alter column slug set not null;

create unique index if not exists hotfix_projects_slug_idx
    on hotfix_projects (slug);
