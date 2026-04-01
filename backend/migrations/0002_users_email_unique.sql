with ranked_users as (
    select
        id,
        lower(trim(email)) as normalized_email,
        row_number() over (
            partition by lower(trim(email))
            order by created_at asc, id asc
        ) as row_number,
        first_value(id) over (
            partition by lower(trim(email))
            order by created_at asc, id asc
        ) as canonical_user_id
    from users
    where email is not null and trim(email) <> ''
),
duplicate_users as (
    select id as duplicate_user_id, canonical_user_id
    from ranked_users
    where row_number > 1
)
update auth_identities
set
    user_id = duplicate_users.canonical_user_id,
    updated_at = now()
from duplicate_users
where auth_identities.user_id = duplicate_users.duplicate_user_id;

with ranked_users as (
    select
        id,
        lower(trim(email)) as normalized_email,
        row_number() over (
            partition by lower(trim(email))
            order by created_at asc, id asc
        ) as row_number
    from users
    where email is not null and trim(email) <> ''
)
delete from users
using ranked_users
where users.id = ranked_users.id
  and ranked_users.row_number > 1;

update users
set email = lower(trim(email))
where email is not null;

update auth_identities
set email = lower(trim(email))
where email is not null;

create unique index if not exists users_email_lower_unique_idx
    on users (lower(email))
    where email is not null;
