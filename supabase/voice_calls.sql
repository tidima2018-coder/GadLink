-- One-to-one voice call history and private Realtime authorization.
-- Run in Supabase SQL Editor. Existing tables and RLS are not disabled.

create table if not exists public.voice_calls (
  id uuid primary key default gen_random_uuid(),
  caller_id uuid not null references auth.users(id) on delete cascade,
  callee_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'ringing'
    check (status in ('ringing', 'accepted', 'rejected', 'missed', 'cancelled', 'ended', 'failed')),
  created_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer not null default 0 check (duration_seconds >= 0),
  updated_at timestamptz not null default now(),
  constraint voice_calls_distinct_users check (caller_id <> callee_id)
);

create index if not exists voice_calls_caller_history_idx
  on public.voice_calls(caller_id, created_at desc);
create index if not exists voice_calls_callee_history_idx
  on public.voice_calls(callee_id, created_at desc);
create index if not exists voice_calls_active_participants_idx
  on public.voice_calls(status, updated_at)
  where status in ('ringing', 'accepted');

alter table public.voice_calls enable row level security;
revoke all on public.voice_calls from anon, authenticated;
grant select on public.voice_calls to authenticated;

drop policy if exists gadlink_voice_calls_participant_read on public.voice_calls;
create policy gadlink_voice_calls_participant_read on public.voice_calls
  for select to authenticated
  using ((select auth.uid()) in (caller_id, callee_id));

create or replace function public.gadlink_start_voice_call(peer_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  new_call_id uuid;
  first_user uuid;
  second_user uuid;
begin
  if v_user_id is null or peer_user_id is null or v_user_id = peer_user_id then
    raise exception 'Укажите другого пользователя.' using errcode = '22023';
  end if;

  first_user := least(v_user_id, peer_user_id);
  second_user := greatest(v_user_id, peer_user_id);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(first_user::text, 0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(second_user::text, 0));

  update public.voice_calls as c
  set status = case when status = 'ringing' then 'missed' else 'failed' end,
      ended_at = coalesce(ended_at, now()),
      duration_seconds = case
        when answered_at is null then 0
        else greatest(0, floor(extract(epoch from (now() - answered_at)))::integer)
      end,
      updated_at = now()
  where status in ('ringing', 'accepted')
    and updated_at < now() - case when status = 'ringing' then interval '50 seconds' else interval '60 seconds' end
    and (c.caller_id in (v_user_id, peer_user_id) or c.callee_id in (v_user_id, peer_user_id));

  if exists (
    select 1 from public.voice_calls c
    where c.status in ('ringing', 'accepted')
      and (c.caller_id in (v_user_id, peer_user_id) or c.callee_id in (v_user_id, peer_user_id))
  ) then
    raise exception 'Один из пользователей уже участвует в звонке.' using errcode = '55P03';
  end if;

  if not exists (
    select 1
    from public.friendships f
    where f.status = 'accepted'
      and ((f.requester_id = v_user_id and f.addressee_id = peer_user_id)
        or (f.requester_id = peer_user_id and f.addressee_id = v_user_id))
  ) then
    raise exception 'Звонить можно только подтверждённым контактам.' using errcode = '42501';
  end if;

  insert into public.voice_calls(caller_id, callee_id)
  values (v_user_id, peer_user_id)
  returning id into new_call_id;
  return new_call_id;
end
$$;

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

  select * into call_row
  from public.voice_calls
  where id = target_call_id
    and v_user_id in (voice_calls.caller_id, voice_calls.callee_id)
  for update;
  if not found then
    raise exception 'Звонок не найден.' using errcode = 'P0002';
  end if;

  if call_action = 'heartbeat' then
    if call_row.status <> 'accepted' then
      raise exception 'Звонок не активен.' using errcode = '22023';
    end if;
    update public.voice_calls set updated_at = now()
      where id = target_call_id returning * into call_row;
    return call_row;
  end if;

  if call_action = 'answer' then
    if v_user_id <> call_row.callee_id or call_row.status <> 'ringing' then
      raise exception 'Нельзя принять этот звонок.' using errcode = '42501';
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
    if call_row.status <> 'ringing' then
      raise exception 'Нельзя завершить этот звонок как пропущенный.' using errcode = '42501';
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

  update public.voice_calls
  set status = next_status,
      answered_at = case when next_status = 'accepted' then now() else answered_at end,
      ended_at = case when next_status in ('rejected', 'cancelled', 'missed', 'ended', 'failed') then now() else ended_at end,
      duration_seconds = case
        when next_status in ('ended', 'failed') and answered_at is not null
          then greatest(0, floor(extract(epoch from (now() - answered_at)))::integer)
        else duration_seconds
      end,
      updated_at = now()
  where id = target_call_id
  returning * into call_row;
  return call_row;
end
$$;

create or replace function public.gadlink_get_voice_call_history()
returns setof public.voice_calls
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

  update public.voice_calls
  set status = case when status = 'ringing' then 'missed' else 'failed' end,
      ended_at = coalesce(ended_at, now()),
      duration_seconds = case
        when answered_at is null then 0
        else greatest(0, floor(extract(epoch from (now() - answered_at)))::integer)
      end,
      updated_at = now()
  where status in ('ringing', 'accepted')
    and updated_at < now() - case when status = 'ringing' then interval '50 seconds' else interval '60 seconds' end
    and (voice_calls.caller_id = v_user_id or voice_calls.callee_id = v_user_id);

  return query
    select c.*
    from public.voice_calls c
    where c.caller_id = v_user_id or c.callee_id = v_user_id
    order by c.created_at desc
    limit 100;
end
$$;

revoke all on function public.gadlink_start_voice_call(uuid) from public;
revoke all on function public.gadlink_transition_voice_call(uuid, text) from public;
revoke all on function public.gadlink_get_voice_call_history() from public;
grant execute on function public.gadlink_start_voice_call(uuid) to authenticated;
grant execute on function public.gadlink_transition_voice_call(uuid, text) to authenticated;
grant execute on function public.gadlink_get_voice_call_history() to authenticated;

-- A private topic may only be joined by a call participant or its own inbox user.
drop policy if exists gadlink_voice_private_topic_read on realtime.messages;
create policy gadlink_voice_private_topic_read on realtime.messages
  for select to authenticated
  using (
    (
      realtime.topic() = 'voice-inbox:' || (select auth.uid())::text
    )
    or (
      realtime.topic() ~ '^voice-call:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
      and exists (
        select 1
        from public.voice_calls c
        where c.id = substring(realtime.topic() from 12)::uuid
          and (select auth.uid()) in (c.caller_id, c.callee_id)
      )
    )
  );

-- Restrictive guards ensure broader pre-existing Realtime policies cannot expose call topics.
drop policy if exists gadlink_voice_private_topic_guard_read on realtime.messages;
create policy gadlink_voice_private_topic_guard_read on realtime.messages
  as restrictive for select to authenticated
  using (
    (
      realtime.topic() not like 'voice-call:%'
      or (
        realtime.topic() ~ '^voice-call:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
        and exists (
          select 1
          from public.voice_calls c
          where c.id = substring(realtime.topic() from 12)::uuid
            and (select auth.uid()) in (c.caller_id, c.callee_id)
        )
      )
    )
    and (
      realtime.topic() not like 'voice-inbox:%'
      or realtime.topic() = 'voice-inbox:' || (select auth.uid())::text
    )
  );

drop policy if exists gadlink_voice_private_topic_broadcast on realtime.messages;
create policy gadlink_voice_private_topic_broadcast on realtime.messages
  for insert to authenticated
  with check (
    realtime.topic() ~ '^voice-call:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
    and exists (
      select 1
      from public.voice_calls c
      where c.id = substring(realtime.topic() from 12)::uuid
        and (select auth.uid()) in (c.caller_id, c.callee_id)
    )
  );

drop policy if exists gadlink_voice_private_topic_guard_broadcast on realtime.messages;
create policy gadlink_voice_private_topic_guard_broadcast on realtime.messages
  as restrictive for insert to authenticated
  with check (
    (
      realtime.topic() not like 'voice-call:%'
      or (
        realtime.topic() ~ '^voice-call:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
        and exists (
          select 1
          from public.voice_calls c
          where c.id = substring(realtime.topic() from 12)::uuid
            and (select auth.uid()) in (c.caller_id, c.callee_id)
        )
      )
    )
    and realtime.topic() not like 'voice-inbox:%'
  );

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime'
  ) then
    raise exception 'Supabase Realtime publication does not exist';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'voice_calls'
  ) and not exists (
    select 1 from pg_catalog.pg_publication
    where pubname = 'supabase_realtime' and puballtables
  ) then
    alter publication supabase_realtime add table public.voice_calls;
  end if;
end
$$;
