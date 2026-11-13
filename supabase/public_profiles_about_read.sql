-- Ensure authenticated GadLink users can read public profile fields.
-- Does not add columns, change profile updates, or enable/disable RLS.

do $$
begin
  if to_regclass('public.profiles') is null then
    raise exception 'public.profiles does not exist';
  end if;
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'about'
      and data_type = 'text'
  ) then
    raise exception 'public.profiles.about text column does not exist';
  end if;
  if to_regprocedure('public.gadlink_email_is_confirmed()') is null then
    raise exception 'public.gadlink_email_is_confirmed() does not exist; apply supabase/auth_setup.sql first';
  end if;
end
$$;

grant select on public.profiles to authenticated;

-- Replace only these two GadLink-owned policies so stale definitions from an
-- earlier auth_setup.sql run cannot keep hiding public profiles.
drop policy if exists gadlink_profiles_read on public.profiles;
create policy gadlink_profiles_read on public.profiles
  as permissive for select to authenticated
  using (public.gadlink_email_is_confirmed() and (select auth.uid()) is not null);

drop policy if exists gadlink_profiles_guard_read on public.profiles;
create policy gadlink_profiles_guard_read on public.profiles
  as restrictive for select to public
  using (public.gadlink_email_is_confirmed() and (select auth.uid()) is not null);

-- Inspect the effective table grant and every SELECT policy, including any
-- additional restrictive policies that could still deny another user.
select
  has_table_privilege('authenticated', 'public.profiles', 'select') as authenticated_can_select,
  c.relrowsecurity as rls_enabled
from pg_catalog.pg_class c
where c.oid = 'public.profiles'::regclass;

select policyname, permissive, roles, cmd, qual
from pg_catalog.pg_policies
where schemaname = 'public'
  and tablename = 'profiles'
  and cmd in ('SELECT', 'ALL')
order by permissive, policyname;
