-- Reapply GadLink's private voice topic SELECT policies without changing RLS.
-- Safe to run repeatedly. Only the two GadLink-owned policies are replaced.

do $$
begin
  if to_regclass('realtime.messages') is null then
    raise exception 'realtime.messages does not exist';
  end if;
  if to_regclass('public.voice_calls') is null then
    raise exception 'public.voice_calls does not exist; apply supabase/voice_calls.sql first';
  end if;
end
$$;

drop policy if exists gadlink_voice_private_topic_read on realtime.messages;
create policy gadlink_voice_private_topic_read on realtime.messages
  for select to authenticated
  using (
    realtime.topic() = 'voice-inbox:' || (select auth.uid())::text
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
