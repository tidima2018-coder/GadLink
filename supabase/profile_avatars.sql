-- Keep profile photos in the existing avatars bucket and profiles.avatar_url column.
-- Apply after auth_setup.sql. This script is safe to run more than once.

do $$
begin
  if to_regclass('public.profiles') is null then
    raise exception 'public.profiles does not exist; apply the existing profiles migration first';
  end if;
  if to_regclass('storage.objects') is null then
    raise exception 'storage.objects does not exist';
  end if;
  if to_regprocedure('public.gadlink_email_is_confirmed()') is null then
    raise exception 'public.gadlink_email_is_confirmed() does not exist; apply supabase/auth_setup.sql first';
  end if;
  if not exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    raise exception 'supabase_realtime publication does not exist';
  end if;
end
$$;

alter table public.profiles enable row level security;
alter table storage.objects enable row level security;
grant select on public.profiles to authenticated;

-- The existing client uses public URLs for profile photos. Public read is limited
-- to this images-only bucket; writes remain restricted to the owner's folder.
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do update set public = true;

drop policy if exists gadlink_avatars_insert on storage.objects;
create policy gadlink_avatars_insert on storage.objects
  as permissive for insert to authenticated
  with check (
    public.gadlink_email_is_confirmed()
    and bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists gadlink_avatars_guard_insert on storage.objects;
create policy gadlink_avatars_guard_insert on storage.objects
  as restrictive for insert to public
  with check (
    public.gadlink_email_is_confirmed()
    and bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists gadlink_avatars_update on storage.objects;
create policy gadlink_avatars_update on storage.objects
  as permissive for update to authenticated
  using (
    public.gadlink_email_is_confirmed()
    and bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    public.gadlink_email_is_confirmed()
    and bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists gadlink_avatars_guard_update on storage.objects;
create policy gadlink_avatars_guard_update on storage.objects
  as restrictive for update to public
  using (
    public.gadlink_email_is_confirmed()
    and bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    public.gadlink_email_is_confirmed()
    and bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists gadlink_avatars_delete on storage.objects;
create policy gadlink_avatars_delete on storage.objects
  as permissive for delete to authenticated
  using (
    public.gadlink_email_is_confirmed()
    and bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists gadlink_avatars_guard_delete on storage.objects;
create policy gadlink_avatars_guard_delete on storage.objects
  as restrictive for delete to public
  using (
    public.gadlink_email_is_confirmed()
    and bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- Profiles are already discoverable by authenticated users in GadLink. This
-- policy preserves that model for Postgres Changes delivery and private channel auth.
drop policy if exists gadlink_profiles_avatar_realtime_read on public.profiles;
create policy gadlink_profiles_avatar_realtime_read on public.profiles
  as permissive for select to authenticated
  using ((select auth.uid()) is not null);

drop policy if exists gadlink_profile_avatar_realtime_channel_read on realtime.messages;
create policy gadlink_profile_avatar_realtime_channel_read on realtime.messages
  for select to authenticated
  using (
    realtime.topic() = 'gadlink-profile-avatars'
    and (select auth.uid()) is not null
  );

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_publication
    where pubname = 'supabase_realtime' and puballtables
  ) and not exists (
    select 1 from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'profiles'
  ) then
    alter publication supabase_realtime add table public.profiles;
  end if;
end
$$;
