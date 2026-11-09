-- Publish membership and message changes so participants' devices can refresh
-- their Supabase-backed chat lists and histories through Postgres Changes.
-- RLS stays enabled; conversation reads are limited to actual participants.
drop policy if exists gadlink_conversations_member_only on public.conversations;
create policy gadlink_conversations_member_only on public.conversations
  as restrictive for select to authenticated
  using (
    exists (
      select 1
      from public.conversation_members m
      where m.conversation_id = conversations.id
        and m.user_id = (select auth.uid())
    )
  );

do $$
declare
  target_table text;
begin
  if not exists (
    select 1
    from pg_catalog.pg_publication
    where pubname = 'supabase_realtime'
  ) then
    raise exception 'Supabase Realtime publication does not exist';
  end if;

  foreach target_table in array array['conversation_members', 'messages'] loop
    if to_regclass('public.' || target_table) is null then
      raise exception 'public.% does not exist', target_table;
    end if;

    if not exists (
      select 1
      from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = target_table
    ) and not exists (
      select 1
      from pg_catalog.pg_publication
      where pubname = 'supabase_realtime'
        and puballtables
    ) then
      execute format('alter publication supabase_realtime add table public.%I', target_table);
    end if;
  end loop;
end
$$;
