-- GadLink private messaging hardening.
-- Requires existing public.conversations, public.conversation_members,
-- public.messages, public.friendships and public.profiles tables.
-- Existing conversations and messages are preserved.

create or replace function public.gadlink_is_conversation_member(target_conversation_id uuid, target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.conversation_members m
    where m.conversation_id = target_conversation_id
      and m.user_id = target_user_id
  ) and target_user_id = (select auth.uid())
$$;

create or replace function public.gadlink_is_conversation_creator(target_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.conversations c
    where c.id = target_conversation_id
      and c.created_by = (select auth.uid())
  )
$$;

create or replace function public.gadlink_are_confirmed_friends(user_one uuid, user_two uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select user_one is not null
    and user_two is not null
    and user_one <> user_two
    and ((select auth.uid()) = user_one or (select auth.uid()) = user_two)
    and exists (
      select 1
      from public.friendships f
      join auth.users u1 on u1.id = user_one and u1.email_confirmed_at is not null
      join auth.users u2 on u2.id = user_two and u2.email_confirmed_at is not null
      where f.status = 'accepted'
        and ((f.requester_id = user_one and f.addressee_id = user_two)
          or (f.requester_id = user_two and f.addressee_id = user_one))
    )
$$;

revoke all on function public.gadlink_is_conversation_member(uuid, uuid) from public;
revoke all on function public.gadlink_is_conversation_creator(uuid) from public;
revoke all on function public.gadlink_are_confirmed_friends(uuid, uuid) from public;
grant execute on function public.gadlink_is_conversation_member(uuid, uuid) to authenticated;
grant execute on function public.gadlink_is_conversation_creator(uuid) to authenticated;
grant execute on function public.gadlink_are_confirmed_friends(uuid, uuid) to authenticated;

create or replace function public.gadlink_get_or_create_direct_conversation(peer_user_id uuid)
returns table(id uuid, name text, is_group boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  lower_id uuid;
  upper_id uuid;
  direct_id uuid;
begin
  if caller_id is null or peer_user_id is null or caller_id = peer_user_id then
    raise exception 'Укажите другого пользователя.' using errcode = '22023';
  end if;

  lower_id := least(caller_id, peer_user_id);
  upper_id := greatest(caller_id, peer_user_id);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(lower_id::text || ':' || upper_id::text, 0));

  -- Reuse old chats first, even if users are no longer friends.
  select c.id into direct_id
  from public.conversations c
  where c.is_group = false
    and exists (select 1 from public.conversation_members m where m.conversation_id = c.id and m.user_id = caller_id)
    and exists (select 1 from public.conversation_members m where m.conversation_id = c.id and m.user_id = peer_user_id)
    and (select count(*) from public.conversation_members m where m.conversation_id = c.id) = 2
  order by c.id
  limit 1;

  if direct_id is null then
    if not public.gadlink_are_confirmed_friends(caller_id, peer_user_id) then
      raise exception 'Личный чат можно создать только с подтверждённым другом.' using errcode = '42501';
    end if;

    insert into public.conversations(name, is_group, created_by)
    values (null, false, caller_id)
    returning conversations.id into direct_id;

    insert into public.conversation_members(conversation_id, user_id)
    values (direct_id, caller_id), (direct_id, peer_user_id);
  end if;

  return query
    select c.id, c.name, c.is_group
    from public.conversations c
    where c.id = direct_id;
end
$$;

revoke all on function public.gadlink_get_or_create_direct_conversation(uuid) from public;
grant execute on function public.gadlink_get_or_create_direct_conversation(uuid) to authenticated;

alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;

grant select, insert on public.conversations to authenticated;
grant select, insert on public.conversation_members to authenticated;
grant select, insert on public.messages to authenticated;

drop policy if exists gadlink_conversations_read on public.conversations;
create policy gadlink_conversations_read on public.conversations
  for select to authenticated
  using (created_by = (select auth.uid()) or public.gadlink_is_conversation_member(id, (select auth.uid())));
drop policy if exists gadlink_conversations_insert on public.conversations;
create policy gadlink_conversations_insert on public.conversations
  for insert to authenticated
  with check (created_by = (select auth.uid()));

-- A caller may read only chats they created or belong to.
drop policy if exists gadlink_conversations_guard_read on public.conversations;
create policy gadlink_conversations_guard_read on public.conversations
  as restrictive for select to authenticated
  using (created_by = (select auth.uid()) or public.gadlink_is_conversation_member(id, (select auth.uid())));

-- Groups still use the existing group-chat flow. Private conversations are created only by the RPC above.
drop policy if exists gadlink_conversations_guard_insert on public.conversations;
create policy gadlink_conversations_guard_insert on public.conversations
  as restrictive for insert to authenticated
  with check (created_by = (select auth.uid()) and is_group = true);

-- Members can see participants only in conversations they belong to.
drop policy if exists gadlink_members_read on public.conversation_members;
create policy gadlink_members_read on public.conversation_members
  for select to authenticated
  using (public.gadlink_is_conversation_member(conversation_id, (select auth.uid())));
drop policy if exists gadlink_members_guard_read on public.conversation_members;
create policy gadlink_members_guard_read on public.conversation_members
  as restrictive for select to authenticated
  using (public.gadlink_is_conversation_member(conversation_id, (select auth.uid())));

-- Only the creator can add participants. A private one-to-one participant must be a confirmed friend.
drop policy if exists gadlink_members_insert on public.conversation_members;
create policy gadlink_members_insert on public.conversation_members
  for insert to authenticated
  with check (
    public.gadlink_is_conversation_creator(conversation_id)
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id
        and (c.is_group or user_id = (select auth.uid())
          or public.gadlink_are_confirmed_friends((select auth.uid()), user_id))
    )
  );
drop policy if exists gadlink_members_guard_insert on public.conversation_members;
create policy gadlink_members_guard_insert on public.conversation_members
  as restrictive for insert to authenticated
  with check (
    public.gadlink_is_conversation_creator(conversation_id)
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id
        and (c.is_group or user_id = (select auth.uid())
          or public.gadlink_are_confirmed_friends((select auth.uid()), user_id))
    )
  );

-- Message history and inserts are restricted to conversation members, with sender identity fixed to auth.uid().
drop policy if exists gadlink_messages_read on public.messages;
create policy gadlink_messages_read on public.messages
  for select to authenticated
  using (public.gadlink_is_conversation_member(conversation_id, (select auth.uid())));
drop policy if exists gadlink_messages_guard_read on public.messages;
create policy gadlink_messages_guard_read on public.messages
  as restrictive for select to authenticated
  using (public.gadlink_is_conversation_member(conversation_id, (select auth.uid())));
drop policy if exists gadlink_messages_insert on public.messages;
create policy gadlink_messages_insert on public.messages
  for insert to authenticated
  with check (user_id = (select auth.uid()) and public.gadlink_is_conversation_member(conversation_id, (select auth.uid())));
drop policy if exists gadlink_messages_guard_insert on public.messages;
create policy gadlink_messages_guard_insert on public.messages
  as restrictive for insert to authenticated
  with check (user_id = (select auth.uid()) and public.gadlink_is_conversation_member(conversation_id, (select auth.uid())));

create index if not exists gadlink_conversation_members_user_chat_idx
  on public.conversation_members(user_id, conversation_id);
create index if not exists gadlink_messages_conversation_created_idx
  on public.messages(conversation_id, created_at, id);

-- Enable Supabase Postgres Changes for message inserts without removing any existing publication tables.
do $$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime')
    and not exists (
      select 1 from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'
    ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end
$$;
