-- Enable participant-only SELECT visibility for Realtime and publish friendship changes.
-- Safe to run repeatedly after auth_setup.sql and the existing friendships migration.
do $$
begin
  if to_regclass('public.friendships') is null then
    raise exception 'public.friendships does not exist; apply the existing friendships migration first';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'friendships'
      and column_name = 'requester_id'
  ) or not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'friendships'
      and column_name = 'addressee_id'
  ) then
    raise exception 'public.friendships must contain requester_id and addressee_id';
  end if;

  if to_regprocedure('public.gadlink_email_is_confirmed()') is null then
    raise exception 'public.gadlink_email_is_confirmed() does not exist; apply supabase/auth_setup.sql first';
  end if;

  alter table public.friendships enable row level security;
  grant select on public.friendships to authenticated;

  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'friendships'
      and policyname = 'gadlink_friendships_realtime_select'
  ) then
    create policy gadlink_friendships_realtime_select
      on public.friendships
      as permissive
      for select
      to authenticated
      using (
        public.gadlink_email_is_confirmed()
        and (
          requester_id = (select auth.uid())
          or addressee_id = (select auth.uid())
        )
      );
  end if;

  if not exists (
    select 1 from pg_catalog.pg_publication
    where pubname = 'supabase_realtime'
  ) then
    raise exception 'supabase_realtime publication does not exist';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_publication
    where pubname = 'supabase_realtime' and puballtables
  ) and not exists (
    select 1 from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'friendships'
  ) then
    alter publication supabase_realtime add table public.friendships;
  end if;
end
$$;
