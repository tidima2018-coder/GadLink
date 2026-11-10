-- Retryable, serialized push delivery with per-device success tracking.
-- Apply after push_and_sync.sql. Existing event rows remain completed so
-- applying this migration cannot resend notifications already deduplicated.

alter table public.gadlink_push_event_log
  add column if not exists status text not null default 'sent',
  add column if not exists lease_until timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists attempts integer not null default 0,
  add column if not exists last_error text,
  add column if not exists delivered_endpoints text[] not null default '{}'::text[];
grant select on public.gadlink_push_event_log to service_role;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.gadlink_push_event_log'::regclass
      and conname = 'gadlink_push_event_log_status_check'
  ) then
    alter table public.gadlink_push_event_log
      add constraint gadlink_push_event_log_status_check
      check (status in ('processing', 'pending', 'sent', 'rate_limited'));
  end if;
end
$$;

drop function if exists public.gadlink_claim_push_event(text, uuid);
create function public.gadlink_claim_push_event(target_event_key text, target_user_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text := coalesce((select auth.jwt() ->> 'role'), '');
  v_recent_count integer;
  event_row public.gadlink_push_event_log;
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

  select l.* into event_row
  from public.gadlink_push_event_log l
  where l.event_key = target_event_key and l.user_id = target_user_id
  for update;
  if found then
    if event_row.status = 'sent' then
      return 'complete';
    elsif event_row.status = 'rate_limited' then
      return 'rate_limited';
    end if;
    if event_row.status = 'processing' and event_row.lease_until > now() then
      return 'busy';
    end if;

    update public.gadlink_push_event_log l
    set status = 'processing',
        lease_until = now() + interval '5 minutes',
        attempts = l.attempts + 1,
        last_error = null
    where l.event_key = target_event_key and l.user_id = target_user_id;
    return 'claimed';
  end if;

  select count(*) into v_recent_count
  from public.gadlink_push_event_log l
  where l.user_id = target_user_id
    and l.created_at > now() - interval '1 minute';
  if v_recent_count >= 60 then
    return 'rate_limited';
  end if;

  insert into public.gadlink_push_event_log(
    event_key, user_id, status, lease_until, attempts
  )
  values (
    target_event_key, target_user_id, 'processing', now() + interval '5 minutes', 1
  );
  return 'claimed';
end
$$;

create or replace function public.gadlink_mark_push_endpoint_delivered(
  target_event_key text,
  target_user_id uuid,
  target_endpoint text
)
returns void
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
  if target_event_key is null or target_user_id is null
      or target_endpoint is null or length(target_endpoint) not between 1 and 4096 then
    raise exception 'Invalid push delivery.' using errcode = '22023';
  end if;

  update public.gadlink_push_event_log l
  set delivered_endpoints = case
        when target_endpoint = any(l.delivered_endpoints) then l.delivered_endpoints
        else array_append(l.delivered_endpoints, target_endpoint)
      end
  where l.event_key = target_event_key
    and l.user_id = target_user_id
    and l.status = 'processing';
  if not found then
    raise exception 'Push event is not being processed.' using errcode = '55000';
  end if;
end
$$;

create or replace function public.gadlink_complete_push_event(
  target_event_key text,
  target_user_id uuid
)
returns void
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

  update public.gadlink_push_event_log l
  set status = 'sent',
      lease_until = null,
      completed_at = now(),
      last_error = null
  where l.event_key = target_event_key
    and l.user_id = target_user_id
    and l.status = 'processing';
  if not found then
    raise exception 'Push event is not being processed.' using errcode = '55000';
  end if;
end
$$;

create or replace function public.gadlink_release_push_event(
  target_event_key text,
  target_user_id uuid,
  failure_reason text
)
returns void
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

  update public.gadlink_push_event_log l
  set status = 'pending',
      lease_until = null,
      last_error = left(coalesce(failure_reason, 'Push delivery failed.'), 1000)
  where l.event_key = target_event_key
    and l.user_id = target_user_id
    and l.status = 'processing';
  if not found then
    raise exception 'Push event is not being processed.' using errcode = '55000';
  end if;
end
$$;

revoke all on function public.gadlink_claim_push_event(text, uuid) from public, anon, authenticated;
revoke all on function public.gadlink_mark_push_endpoint_delivered(text, uuid, text) from public, anon, authenticated;
revoke all on function public.gadlink_complete_push_event(text, uuid) from public, anon, authenticated;
revoke all on function public.gadlink_release_push_event(text, uuid, text) from public, anon, authenticated;
grant execute on function public.gadlink_claim_push_event(text, uuid) to service_role;
grant execute on function public.gadlink_mark_push_endpoint_delivered(text, uuid, text) to service_role;
grant execute on function public.gadlink_complete_push_event(text, uuid) to service_role;
grant execute on function public.gadlink_release_push_event(text, uuid, text) to service_role;
