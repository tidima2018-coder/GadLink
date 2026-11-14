-- Apply after auth_setup.sql. Idempotent; no private profile columns are exposed.
begin;
create table if not exists public.user_activity (
  user_id uuid primary key references auth.users(id) on delete cascade,
  show_online_status boolean not null default true,
  last_seen_at timestamptz,
  constraint gadlink_hidden_activity_empty check (show_online_status or last_seen_at is null)
);
alter table public.user_activity enable row level security;
revoke all on public.user_activity from anon, authenticated;
grant select on public.user_activity to authenticated;
drop policy if exists gadlink_activity_read on public.user_activity;
create policy gadlink_activity_read on public.user_activity for select to authenticated
  using (public.gadlink_email_is_confirmed());

create or replace function public.gadlink_touch_activity()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.gadlink_email_is_confirmed() then
    raise exception 'Confirmed authentication required';
  end if;
  insert into public.user_activity(user_id, last_seen_at) values (auth.uid(), now())
  on conflict (user_id) do update set last_seen_at = now()
    where public.user_activity.show_online_status
      and (public.user_activity.last_seen_at is null or public.user_activity.last_seen_at < now() - interval '20 seconds');
end;
$$;
create or replace function public.gadlink_set_activity_visibility(visible boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.gadlink_email_is_confirmed() then
    raise exception 'Confirmed authentication required';
  end if;
  if visible is null then raise exception 'Visibility required'; end if;
  insert into public.user_activity(user_id, show_online_status, last_seen_at)
  values (auth.uid(), visible, case when visible then now() else null end)
  on conflict (user_id) do update set show_online_status = visible,
    last_seen_at = case when visible then now() else null end;
end;
$$;
revoke all on function public.gadlink_touch_activity() from public, anon;
revoke all on function public.gadlink_set_activity_visibility(boolean) from public, anon;
grant execute on function public.gadlink_touch_activity() to authenticated;
grant execute on function public.gadlink_set_activity_visibility(boolean) to authenticated;

create or replace function public.gadlink_presence_allowed(topic text, publishing boolean)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and public.gadlink_email_is_confirmed() and exists (
    select 1 from public.user_activity a
    where topic = 'user-presence:' || a.user_id::text
      and a.show_online_status and (not publishing or a.user_id = auth.uid())
  );
$$;
revoke all on function public.gadlink_presence_allowed(text, boolean) from public, anon;
grant execute on function public.gadlink_presence_allowed(text, boolean) to authenticated;
drop policy if exists gadlink_user_presence_read on realtime.messages;
create policy gadlink_user_presence_read on realtime.messages for select to authenticated
  using (extension = 'presence' and public.gadlink_presence_allowed(realtime.topic(), false));
drop policy if exists gadlink_user_presence_write on realtime.messages;
create policy gadlink_user_presence_write on realtime.messages for insert to authenticated
  with check (extension = 'presence' and public.gadlink_presence_allowed(realtime.topic(), true));
-- Restrictive guards prevent unrelated permissive policies from granting write
-- access to somebody else's topic. Do not alter existing voice policies.
drop policy if exists gadlink_user_presence_read_guard on realtime.messages;
create policy gadlink_user_presence_read_guard on realtime.messages as restrictive for select to authenticated
  using (realtime.topic() not like 'user-presence:%' or
    (extension = 'presence' and public.gadlink_presence_allowed(realtime.topic(), false)));
drop policy if exists gadlink_user_presence_write_guard on realtime.messages;
create policy gadlink_user_presence_write_guard on realtime.messages as restrictive for insert to authenticated
  with check (realtime.topic() not like 'user-presence:%' or
    (extension = 'presence' and public.gadlink_presence_allowed(realtime.topic(), true)));
do $$ begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise exception 'Enable Supabase Realtime before applying this migration';
  end if;
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime' and puballtables)
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
       and schemaname = 'public' and tablename = 'user_activity') then
    alter publication supabase_realtime add table public.user_activity;
  end if;
end $$;
commit;
