-- Push subscriptions, synchronized unread state, and call expiration safeguards.
-- Apply after the existing chat, friendships, Reels, and voice_calls migrations.
-- RLS stays enabled on all application data.

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique check (endpoint ~ '^https://' and length(endpoint) <= 4096),
  p256dh text not null check (length(p256dh) between 40 and 200),
  auth text not null check (length(auth) between 16 and 200),
  show_preview boolean not null default false,
  active_conversation_id uuid references public.conversations(id) on delete set null,
  is_visible boolean not null default false,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.push_subscriptions
  add column if not exists active_conversation_id uuid references public.conversations(id) on delete set null;
alter table public.push_subscriptions
  add column if not exists is_visible boolean not null default false;
alter table public.push_subscriptions
  add column if not exists last_seen_at timestamptz not null default now();
create index if not exists push_subscriptions_user_id_idx
  on public.push_subscriptions(user_id);

alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;
grant select, insert, update, delete on public.push_subscriptions to authenticated;
grant select, delete on public.push_subscriptions to service_role;

drop policy if exists gadlink_push_subscriptions_select_own on public.push_subscriptions;
create policy gadlink_push_subscriptions_select_own on public.push_subscriptions
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists gadlink_push_subscriptions_insert_own on public.push_subscriptions;
create policy gadlink_push_subscriptions_insert_own on public.push_subscriptions
  for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists gadlink_push_subscriptions_update_own on public.push_subscriptions;
create policy gadlink_push_subscriptions_update_own on public.push_subscriptions
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
drop policy if exists gadlink_push_subscriptions_delete_own on public.push_subscriptions;
create policy gadlink_push_subscriptions_delete_own on public.push_subscriptions
  for delete to authenticated using ((select auth.uid()) = user_id);

create or replace function public.gadlink_limit_push_devices()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  device_count integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(new.user_id::text, 1)
  );
  select count(*) into device_count
  from public.push_subscriptions p
  where p.user_id = new.user_id and p.endpoint <> new.endpoint;
  if device_count >= 10 then
    raise exception 'Разрешено не более 10 устройств с Push-уведомлениями.' using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end
$$;
revoke all on function public.gadlink_limit_push_devices() from public, anon, authenticated;
drop trigger if exists gadlink_limit_push_devices on public.push_subscriptions;
create trigger gadlink_limit_push_devices
  before insert or update on public.push_subscriptions
  for each row execute function public.gadlink_limit_push_devices();

create table if not exists public.conversation_read_state (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
alter table public.conversation_read_state enable row level security;
revoke all on public.conversation_read_state from anon, authenticated;
grant select, insert, update on public.conversation_read_state to authenticated;

drop policy if exists gadlink_conversation_read_state_select_own on public.conversation_read_state;
create policy gadlink_conversation_read_state_select_own on public.conversation_read_state
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists gadlink_conversation_read_state_insert_member on public.conversation_read_state;
create policy gadlink_conversation_read_state_insert_member on public.conversation_read_state
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.conversation_members m
      where m.conversation_id = conversation_read_state.conversation_id
        and m.user_id = (select auth.uid())
    )
  );
drop policy if exists gadlink_conversation_read_state_update_member on public.conversation_read_state;
create policy gadlink_conversation_read_state_update_member on public.conversation_read_state
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.conversation_members m
      where m.conversation_id = conversation_read_state.conversation_id
        and m.user_id = (select auth.uid())
    )
  );

create or replace function public.gadlink_mark_conversation_read(target_conversation_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null or not exists (
    select 1 from public.conversation_members m
    where m.conversation_id = target_conversation_id and m.user_id = v_user_id
  ) then
    raise exception 'Диалог не найден.' using errcode = '42501';
  end if;

  insert into public.conversation_read_state(conversation_id, user_id, last_read_at)
  values (target_conversation_id, v_user_id, now())
  on conflict (conversation_id, user_id)
  do update set last_read_at = excluded.last_read_at;
end
$$;

create or replace function public.gadlink_get_chat_overview()
returns table (
  conversation_id uuid,
  last_message text,
  last_message_user_id uuid,
  last_message_at timestamptz,
  unread_count bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null then
    raise exception 'Необходима авторизация.' using errcode = '42501';
  end if;

  return query
    select mine.conversation_id,
      latest.content,
      latest.user_id,
      latest.created_at,
      (
        select count(*)::bigint
        from public.messages unread
        where unread.conversation_id = mine.conversation_id
          and unread.user_id <> v_user_id
          and unread.created_at > coalesce(read_state.last_read_at, '-infinity'::timestamptz)
      )
    from public.conversation_members mine
    left join public.conversation_read_state read_state
      on read_state.conversation_id = mine.conversation_id
      and read_state.user_id = v_user_id
    left join lateral (
      select m.content, m.user_id, m.created_at
      from public.messages m
      where m.conversation_id = mine.conversation_id
      order by m.created_at desc, m.id desc
      limit 1
    ) latest on true
    where mine.user_id = v_user_id;
end
$$;

revoke all on function public.gadlink_mark_conversation_read(uuid) from public, anon;
revoke all on function public.gadlink_get_chat_overview() from public, anon;
grant execute on function public.gadlink_mark_conversation_read(uuid) to authenticated;
grant execute on function public.gadlink_get_chat_overview() to authenticated;

create table if not exists public.gadlink_push_event_log (
  event_key text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (event_key, user_id)
);
create index if not exists gadlink_push_event_log_rate_idx
  on public.gadlink_push_event_log(user_id, created_at desc);
create index if not exists gadlink_push_event_log_created_at_idx
  on public.gadlink_push_event_log(created_at);
alter table public.gadlink_push_event_log enable row level security;
revoke all on public.gadlink_push_event_log from public, anon, authenticated;

create or replace function public.gadlink_claim_push_event(target_event_key text, target_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text := coalesce((select auth.jwt() ->> 'role'), '');
  v_recent_count integer;
begin
  if v_role <> 'service_role' then
    raise exception 'Forbidden.' using errcode = '42501';
  end if;
  if target_event_key is null or length(target_event_key) not between 1 and 200
      or target_user_id is null then
    raise exception 'Invalid push event.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_user_id::text, 0)
  );
  if exists (
    select 1 from public.gadlink_push_event_log l
    where l.event_key = target_event_key and l.user_id = target_user_id
  ) then
    return false;
  end if;

  select count(*) into v_recent_count
  from public.gadlink_push_event_log l
  where l.user_id = target_user_id
    and l.created_at > now() - interval '1 minute';
  if v_recent_count >= 60 then
    return false;
  end if;

  insert into public.gadlink_push_event_log(event_key, user_id)
  values (target_event_key, target_user_id)
  on conflict do nothing;
  return found;
end
$$;
revoke all on function public.gadlink_claim_push_event(text, uuid) from public, anon, authenticated;
grant execute on function public.gadlink_claim_push_event(text, uuid) to service_role;

-- A ringing call is answerable only during the same 45-second window used by
-- the browser. Expiration can be finalized by either participant after timeout.
create or replace function public.gadlink_transition_voice_call(target_call_id uuid, call_action text)
returns public.voice_calls
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  call_row public.voice_calls;
  next_status text;
begin
  if v_user_id is null then
    raise exception 'Необходима авторизация.' using errcode = '42501';
  end if;

  select c.* into call_row
  from public.voice_calls c
  where c.id = target_call_id
    and v_user_id in (c.caller_id, c.callee_id)
  for update;
  if not found then
    raise exception 'Звонок не найден.' using errcode = 'P0002';
  end if;

  if call_action = 'heartbeat' then
    if call_row.status <> 'accepted' then
      raise exception 'Звонок не активен.' using errcode = '22023';
    end if;
    update public.voice_calls c set updated_at = now()
      where c.id = target_call_id returning c.* into call_row;
    return call_row;
  elsif call_action = 'answer' then
    if v_user_id <> call_row.callee_id or call_row.status <> 'ringing'
        or call_row.created_at < now() - interval '45 seconds' then
      raise exception 'Звонок больше не активен.' using errcode = '42501';
    end if;
    next_status := 'accepted';
  elsif call_action = 'reject' then
    if v_user_id <> call_row.callee_id or call_row.status <> 'ringing' then
      raise exception 'Нельзя отклонить этот звонок.' using errcode = '42501';
    end if;
    next_status := 'rejected';
  elsif call_action = 'cancel' then
    if v_user_id <> call_row.caller_id or call_row.status <> 'ringing' then
      raise exception 'Нельзя отменить этот звонок.' using errcode = '42501';
    end if;
    next_status := 'cancelled';
  elsif call_action = 'missed' then
    if call_row.status <> 'ringing'
        or call_row.created_at > now() - interval '45 seconds' then
      raise exception 'Звонок ещё не истёк.' using errcode = '42501';
    end if;
    next_status := 'missed';
  elsif call_action = 'end' then
    if call_row.status <> 'accepted' then
      raise exception 'Разговор уже не активен.' using errcode = '22023';
    end if;
    next_status := 'ended';
  elsif call_action = 'failed' then
    if call_row.status not in ('ringing', 'accepted') then
      return call_row;
    end if;
    next_status := 'failed';
  else
    raise exception 'Неизвестное действие звонка.' using errcode = '22023';
  end if;

  update public.voice_calls c
  set status = next_status,
      answered_at = case when next_status = 'accepted' then now() else c.answered_at end,
      ended_at = case
        when next_status in ('rejected', 'cancelled', 'missed', 'ended', 'failed') then now()
        else c.ended_at
      end,
      duration_seconds = case
        when next_status in ('ended', 'failed') and c.answered_at is not null
          then greatest(0, floor(extract(epoch from (now() - c.answered_at)))::integer)
        else c.duration_seconds
      end,
      updated_at = now()
  where c.id = target_call_id
  returning c.* into call_row;
  return call_row;
end
$$;

create or replace function public.gadlink_expire_stale_voice_calls()
returns setof public.voice_calls
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text := coalesce((select auth.jwt() ->> 'role'), '');
begin
  if v_role <> 'service_role' then
    raise exception 'Forbidden.' using errcode = '42501';
  end if;

  return query
    update public.voice_calls c
    set status = case when c.status = 'ringing' then 'missed' else 'failed' end,
        ended_at = coalesce(c.ended_at, now()),
        duration_seconds = case
          when c.answered_at is null then 0
          else greatest(0, floor(extract(epoch from (now() - c.answered_at)))::integer)
        end,
        updated_at = now()
    where (c.status = 'ringing' and c.created_at <= now() - interval '45 seconds')
       or (c.status = 'accepted' and c.updated_at <= now() - interval '60 seconds')
    returning c.*;

  delete from public.gadlink_push_event_log l
  where l.created_at < now() - interval '30 days';
end
$$;
revoke all on function public.gadlink_expire_stale_voice_calls() from public, anon, authenticated;
grant execute on function public.gadlink_expire_stale_voice_calls() to service_role;

-- Keep realtime-driven views current without relaxing the tables' RLS.
do $$
declare
  target_table text;
begin
  foreach target_table in array array[
    'conversation_read_state', 'friendships', 'reel_likes', 'reel_comments', 'reel_saves'
  ] loop
    if to_regclass('public.' || target_table) is null then
      raise exception 'public.% does not exist; apply the related GadLink migration first', target_table;
    end if;
    if not exists (
      select 1 from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = target_table
    ) and not exists (
      select 1 from pg_catalog.pg_publication
      where pubname = 'supabase_realtime' and puballtables
    ) then
      execute format('alter publication supabase_realtime add table public.%I', target_table);
    end if;
  end loop;
end
$$;
