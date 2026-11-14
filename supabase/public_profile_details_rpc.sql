-- Read only the public fields needed by GadLink profile cards when a direct
-- profiles SELECT is filtered by an existing RLS policy. RLS remains enabled.
do $$
begin
  if to_regclass('public.profiles') is null then
    raise exception 'public.profiles does not exist';
  end if;
  if to_regprocedure('public.gadlink_email_is_confirmed()') is null then
    raise exception 'public.gadlink_email_is_confirmed() does not exist; apply supabase/auth_setup.sql first';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles'
      and column_name = 'id' and data_type = 'uuid'
  ) then
    raise exception 'public.profiles.id uuid column does not exist';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles'
      and column_name = 'username'
  ) then
    raise exception 'public.profiles.username column does not exist';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles'
      and column_name = 'avatar_url'
  ) then
    raise exception 'public.profiles.avatar_url column does not exist';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles'
      and column_name = 'about' and data_type = 'text'
  ) then
    raise exception 'public.profiles.about text column does not exist';
  end if;
end
$$;

create or replace function public.get_public_profile_details(target_profile_ids uuid[])
returns table(id uuid, username text, avatar_url text, about text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if public.gadlink_email_is_confirmed() is not true then
    raise exception 'Confirmed email required' using errcode = '42501';
  end if;
  if coalesce(cardinality(target_profile_ids), 0) > 50 then
    raise exception 'At most 50 profile IDs may be requested' using errcode = '22023';
  end if;

  return query
    select p.id, p.username::text, p.avatar_url::text, p.about::text
    from public.profiles as p
    where p.id = any(coalesce(target_profile_ids, array[]::uuid[]));
end
$$;

revoke all on function public.get_public_profile_details(uuid[]) from public, anon, authenticated;
grant execute on function public.get_public_profile_details(uuid[]) to authenticated;

-- Diagnostic output: verify effective SELECT permission and every SELECT/ALL
-- policy, including restrictive policies that are combined with AND.
select
  has_table_privilege('authenticated', 'public.profiles', 'select') as authenticated_can_select_table,
  has_column_privilege('authenticated', 'public.profiles', 'id', 'select') as authenticated_can_select_id,
  has_column_privilege('authenticated', 'public.profiles', 'about', 'select') as authenticated_can_select_about,
  c.relrowsecurity as rls_enabled
from pg_catalog.pg_class as c
where c.oid = 'public.profiles'::regclass;

select policyname, permissive, roles, cmd, qual
from pg_catalog.pg_policies
where schemaname = 'public'
  and tablename = 'profiles'
  and cmd in ('SELECT', 'ALL')
order by permissive, policyname;

notify pgrst, 'reload schema';
