-- Secure private Realtime presence and signaling for existing server voice channels.
-- Apply after community_setup.sql. This migration does not change server data or disable RLS.
begin;

create or replace function public.gadlink_can_join_voice_channel(target_channel_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.text_channels c
    where c.id = target_channel_id
      and c.channel_type = 'voice'
      and public.gadlink_email_is_confirmed()
      and (
        public.gadlink_is_server_owner(c.server_id)
        or (not c.is_private and public.gadlink_is_server_member(c.server_id))
      )
  )
$$;

revoke all on function public.gadlink_can_join_voice_channel(uuid) from public, anon;
grant execute on function public.gadlink_can_join_voice_channel(uuid) to authenticated;

drop policy if exists gadlink_voice_room_read on realtime.messages;
create policy gadlink_voice_room_read on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension in ('broadcast', 'presence')
    and realtime.topic() ~ '^voice-room:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    and public.gadlink_can_join_voice_channel(substring(realtime.topic() from 12)::uuid)
  );

drop policy if exists gadlink_voice_room_broadcast on realtime.messages;
create policy gadlink_voice_room_broadcast on realtime.messages
  for insert to authenticated
  with check (
    realtime.messages.extension = 'broadcast'
    and realtime.topic() ~ '^voice-room:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    and public.gadlink_can_join_voice_channel(substring(realtime.topic() from 12)::uuid)
  );

drop policy if exists gadlink_voice_room_presence on realtime.messages;
create policy gadlink_voice_room_presence on realtime.messages
  for insert to authenticated
  with check (
    realtime.messages.extension = 'presence'
    and realtime.topic() ~ '^voice-room:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    and public.gadlink_can_join_voice_channel(substring(realtime.topic() from 12)::uuid)
  );

-- Keep room topics restricted even if another broad permissive policy exists.
drop policy if exists gadlink_voice_room_guard_read on realtime.messages;
create policy gadlink_voice_room_guard_read on realtime.messages
  as restrictive for select to authenticated
  using (
    realtime.topic() not like 'voice-room:%'
    or (
      realtime.messages.extension in ('broadcast', 'presence')
      and realtime.topic() ~ '^voice-room:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      and public.gadlink_can_join_voice_channel(substring(realtime.topic() from 12)::uuid)
    )
  );

drop policy if exists gadlink_voice_room_guard_insert on realtime.messages;
create policy gadlink_voice_room_guard_insert on realtime.messages
  as restrictive for insert to authenticated
  with check (
    realtime.topic() not like 'voice-room:%'
    or (
      realtime.messages.extension in ('broadcast', 'presence')
      and realtime.topic() ~ '^voice-room:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      and public.gadlink_can_join_voice_channel(substring(realtime.topic() from 12)::uuid)
    )
  );

commit;
