-- Apply after existing chat_sync.sql, friendships_realtime.sql, reels.sql,
-- push_and_sync.sql, profile_avatars.sql, voice_calls.sql and voice_inbox_realtime_fix.sql.
begin;
-- These topics carry Postgres Changes only. Table RLS still authorizes each row.
drop policy if exists gadlink_database_channels_read on realtime.messages;
create policy gadlink_database_channels_read on realtime.messages for select to authenticated
using (public.gadlink_email_is_confirmed() and (
  realtime.topic() in ('gadlink-profile-avatars', 'feed-posts')
  or realtime.topic() in (
    'friendships-' || auth.uid()::text,
    'conversation-members-' || auth.uid()::text,
    'chat-overview-' || auth.uid()::text,
    'reel-posts-' || auth.uid()::text,
    'reel-interactions-' || auth.uid()::text,
    'activity-settings-' || auth.uid()::text
  )
  or realtime.topic() ~ '^(messages-|channel-messages-)[0-9a-f-]{36}$'
));

-- Unique authenticated views, without publishing the viewers' identities.
alter table public.reel_posts add column if not exists view_count bigint not null default 0;
create table if not exists public.reel_views (
  post_id uuid not null references public.reel_posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  primary key(post_id, user_id)
);
alter table public.reel_views enable row level security;
revoke all on public.reel_views from anon, authenticated;
create or replace function public.gadlink_record_reel_view(target_post_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare inserted integer;
begin
  if auth.uid() is null or not public.gadlink_email_is_confirmed() then
    raise exception 'Confirmed authentication required';
  end if;
  -- Match the existing authenticated-read policy of reel_posts.
  insert into public.reel_views(post_id, user_id)
    select id, auth.uid() from public.reel_posts where id = target_post_id
    on conflict do nothing;
  get diagnostics inserted = row_count;
  if inserted > 0 then
    update public.reel_posts set view_count = view_count + 1 where id = target_post_id;
  end if;
end;
$$;
revoke all on function public.gadlink_record_reel_view(uuid) from public, anon;
grant execute on function public.gadlink_record_reel_view(uuid) to authenticated;
-- Keep the counter accurate if an account is deleted as well.
create or replace function public.gadlink_reel_view_removed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.reel_posts set view_count = greatest(0, view_count - 1) where id = old.post_id;
  return old;
end;
$$;
revoke all on function public.gadlink_reel_view_removed() from public, anon, authenticated;
drop trigger if exists gadlink_reel_view_removed on public.reel_views;
create trigger gadlink_reel_view_removed after delete on public.reel_views
  for each row execute function public.gadlink_reel_view_removed();
-- Owners must not be able to forge the aggregate through an ordinary UPDATE.
create or replace function public.gadlink_guard_reel_view_count()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then new.view_count := 0;
    else new.view_count := old.view_count; end if;
  end if;
  return new;
end;
$$;
drop trigger if exists gadlink_guard_reel_view_count on public.reel_posts;
create trigger gadlink_guard_reel_view_count before insert or update on public.reel_posts
  for each row execute function public.gadlink_guard_reel_view_count();

do $$
declare target text;
begin
  if not exists(select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise exception 'supabase_realtime publication is missing';
  end if;
  foreach target in array array['profiles','friendships','messages','conversation_members',
    'conversations','conversation_read_state','posts','channel_messages','voice_calls',
    'reel_posts','reel_likes','reel_comments','reel_saves','reel_reposts'] loop
    if to_regclass('public.' || target) is null then
      raise exception 'Missing public.%; apply the existing feature migration first', target;
    end if;
    if not (select relrowsecurity from pg_class where oid = to_regclass('public.' || target)) then
      raise exception 'RLS is disabled on public.%; review the existing feature policies', target;
    end if;
    if not exists (select 1 from pg_publication where pubname = 'supabase_realtime' and puballtables)
      and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
        and schemaname = 'public' and tablename = target) then
      execute format('alter publication supabase_realtime add table public.%I', target);
    end if;
    execute format('alter table public.%I replica identity full', target);
  end loop;
end $$;
commit;
