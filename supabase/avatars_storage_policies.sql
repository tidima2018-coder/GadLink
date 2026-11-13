-- RLS for the existing public avatars bucket.
-- Apply after auth_setup.sql. Safe to run repeatedly; RLS remains enabled.

do $$
begin
  if to_regclass('storage.objects') is null then
    raise exception 'storage.objects does not exist';
  end if;
  if to_regprocedure('public.gadlink_email_is_confirmed()') is null then
    raise exception 'public.gadlink_email_is_confirmed() does not exist; apply supabase/auth_setup.sql first';
  end if;
end
$$;

grant select, insert, update, delete on storage.objects to authenticated;

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do update set public = true;

drop policy if exists gadlink_avatars_insert on storage.objects;
create policy gadlink_avatars_insert on storage.objects
  as permissive for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and public.gadlink_email_is_confirmed()
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- Restrictive avatar guards explicitly pass through all other buckets. This is
-- important because RLS policies apply to storage.objects across every bucket.
drop policy if exists gadlink_avatars_guard_insert on storage.objects;
create policy gadlink_avatars_guard_insert on storage.objects
  as restrictive for insert to public
  with check (
    bucket_id <> 'avatars'
    or (
      public.gadlink_email_is_confirmed()
      and (storage.foldername(name))[1] = (select auth.uid())::text
    )
  );

drop policy if exists gadlink_avatars_select on storage.objects;
create policy gadlink_avatars_select on storage.objects
  as permissive for select to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists gadlink_avatars_guard_select on storage.objects;
create policy gadlink_avatars_guard_select on storage.objects
  as restrictive for select to public
  using (
    bucket_id <> 'avatars'
    or (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists gadlink_avatars_update on storage.objects;
create policy gadlink_avatars_update on storage.objects
  as permissive for update to authenticated
  using (
    bucket_id = 'avatars'
    and public.gadlink_email_is_confirmed()
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'avatars'
    and public.gadlink_email_is_confirmed()
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists gadlink_avatars_guard_update on storage.objects;
create policy gadlink_avatars_guard_update on storage.objects
  as restrictive for update to public
  using (
    bucket_id <> 'avatars'
    or (
      public.gadlink_email_is_confirmed()
      and (storage.foldername(name))[1] = (select auth.uid())::text
    )
  )
  with check (
    bucket_id <> 'avatars'
    or (
      public.gadlink_email_is_confirmed()
      and (storage.foldername(name))[1] = (select auth.uid())::text
    )
  );

drop policy if exists gadlink_avatars_delete on storage.objects;
create policy gadlink_avatars_delete on storage.objects
  as permissive for delete to authenticated
  using (
    bucket_id = 'avatars'
    and public.gadlink_email_is_confirmed()
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists gadlink_avatars_guard_delete on storage.objects;
create policy gadlink_avatars_guard_delete on storage.objects
  as restrictive for delete to public
  using (
    bucket_id <> 'avatars'
    or (
      public.gadlink_email_is_confirmed()
      and (storage.foldername(name))[1] = (select auth.uid())::text
    )
  );
