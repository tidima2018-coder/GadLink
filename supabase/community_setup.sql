-- Apply after the existing servers, text_channels, and channel_messages tables
-- and after auth_setup.sql.
BEGIN;

DROP POLICY IF EXISTS "Users can create servers" ON public.servers;
DROP POLICY IF EXISTS "Users can delete own servers" ON public.servers;
DROP POLICY IF EXISTS "Users can update own servers" ON public.servers;
DROP POLICY IF EXISTS "Users can view own servers" ON public.servers;
alter table public.servers
  add column if not exists description text not null default '',
  add column if not exists server_type text not null default 'friends',
  add column if not exists is_private boolean not null default false,
  add column if not exists avatar_path text,
  add column if not exists invite_code text not null default replace(gen_random_uuid()::text, '-', '');

alter table public.servers drop constraint if exists gadlink_servers_type_check;
alter table public.servers
  add constraint gadlink_servers_type_check
  check (server_type in ('friends', 'community', 'study', 'work'));
create unique index if not exists gadlink_servers_invite_code_key
  on public.servers (invite_code);

alter table public.text_channels
  add column if not exists channel_type text not null default 'text',
  add column if not exists category text,
  add column if not exists is_private boolean not null default false,
  add column if not exists created_by uuid references auth.users(id) on delete set null;

update public.text_channels c
set created_by = s.created_by
from public.servers s
where c.server_id = s.id and c.created_by is null;

alter table public.text_channels drop constraint if exists gadlink_channels_type_check;
alter table public.text_channels
  add constraint gadlink_channels_type_check
  check (channel_type in ('text', 'voice', 'announcement'));

create table if not exists public.server_members (
  server_id uuid not null references public.servers(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (server_id, user_id)
);

insert into public.server_members (server_id, user_id, role)
select id, created_by, 'owner'
from public.servers
on conflict (server_id, user_id) do update set role = 'owner';

create index if not exists gadlink_server_members_user_id_idx
  on public.server_members (user_id);
create index if not exists gadlink_text_channels_server_id_idx
  on public.text_channels (server_id);

create or replace function public.gadlink_add_server_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.server_members (server_id, user_id, role)
  values (new.id, new.created_by, 'owner')
  on conflict (server_id, user_id) do update set role = 'owner';
  return new;
end
$$;

drop trigger if exists gadlink_add_server_owner on public.servers;
create trigger gadlink_add_server_owner
after insert on public.servers
for each row execute function public.gadlink_add_server_owner();

create or replace function public.gadlink_join_server(invite_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_server_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in to join a server';
  end if;
  if not public.gadlink_email_is_confirmed() then
    raise exception 'Confirm your email to join a server';
  end if;

  select s.id into target_server_id
  from public.servers s
  where s.invite_code = trim(invite_token);

  if target_server_id is null then
    raise exception 'Invite link is invalid or expired';
  end if;

  insert into public.server_members (server_id, user_id, role)
  values (target_server_id, auth.uid(), 'member')
  on conflict (server_id, user_id) do nothing;

  return target_server_id;
end
$$;

create or replace function public.gadlink_is_server_member(target_server_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.server_members m
    where m.server_id = target_server_id and m.user_id = (select auth.uid())
  )
$$;

create or replace function public.gadlink_is_server_owner(target_server_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.servers s
    where s.id = target_server_id and s.created_by = (select auth.uid())
  )
$$;

revoke all on function public.gadlink_add_server_owner() from public;
revoke all on function public.gadlink_join_server(text) from public;
revoke all on function public.gadlink_is_server_member(uuid) from public;
revoke all on function public.gadlink_is_server_owner(uuid) from public;
grant execute on function public.gadlink_join_server(text) to authenticated;
grant execute on function public.gadlink_is_server_member(uuid) to authenticated;
grant execute on function public.gadlink_is_server_owner(uuid) to authenticated;

alter table public.servers enable row level security;
alter table public.server_members enable row level security;
alter table public.text_channels enable row level security;
alter table public.channel_messages enable row level security;

drop policy if exists gadlink_servers_read on public.servers;
drop policy if exists gadlink_servers_guard_read on public.servers;
drop policy if exists gadlink_servers_insert on public.servers;
drop policy if exists gadlink_servers_guard_insert on public.servers;
drop policy if exists gadlink_servers_update on public.servers;
drop policy if exists gadlink_servers_guard_update on public.servers;
drop policy if exists gadlink_servers_delete on public.servers;
drop policy if exists gadlink_servers_guard_delete on public.servers;
drop policy if exists gadlink_community_servers_select on public.servers;
drop policy if exists gadlink_community_servers_insert on public.servers;
drop policy if exists gadlink_community_servers_update on public.servers;
drop policy if exists gadlink_community_servers_delete on public.servers;

create policy gadlink_community_servers_select on public.servers
for select to authenticated
using (
  auth.uid() is not null
  and public.gadlink_email_is_confirmed()
  and (not is_private or public.gadlink_is_server_member(id))
);
create policy gadlink_community_servers_insert on public.servers
for insert to authenticated
with check (public.gadlink_email_is_confirmed() and created_by = auth.uid());
create policy gadlink_community_servers_update on public.servers
for update to authenticated
using (public.gadlink_email_is_confirmed() and created_by = auth.uid())
with check (public.gadlink_email_is_confirmed() and created_by = auth.uid());
create policy gadlink_community_servers_delete on public.servers
for delete to authenticated
using (public.gadlink_email_is_confirmed() and created_by = auth.uid());

drop policy if exists gadlink_server_members_select on public.server_members;
drop policy if exists gadlink_server_members_delete on public.server_members;
create policy gadlink_server_members_select on public.server_members
for select to authenticated
using (
  public.gadlink_email_is_confirmed()
  and (user_id = auth.uid() or public.gadlink_is_server_owner(server_id))
);
create policy gadlink_server_members_delete on public.server_members
for delete to authenticated
using (
  public.gadlink_email_is_confirmed()
  and public.gadlink_is_server_owner(server_id)
);

drop policy if exists gadlink_channels_read on public.text_channels;
drop policy if exists gadlink_channels_guard_read on public.text_channels;
drop policy if exists gadlink_channels_insert on public.text_channels;
drop policy if exists gadlink_channels_guard_insert on public.text_channels;
drop policy if exists gadlink_channels_update on public.text_channels;
drop policy if exists gadlink_channels_guard_update on public.text_channels;
drop policy if exists gadlink_channels_delete on public.text_channels;
drop policy if exists gadlink_channels_guard_delete on public.text_channels;
drop policy if exists gadlink_community_channels_select on public.text_channels;
drop policy if exists gadlink_community_channels_insert on public.text_channels;
drop policy if exists gadlink_community_channels_update on public.text_channels;
drop policy if exists gadlink_community_channels_delete on public.text_channels;

create policy gadlink_community_channels_select on public.text_channels
for select to authenticated
using (
  public.gadlink_email_is_confirmed()
  and (
    public.gadlink_is_server_owner(server_id)
    or (not is_private and public.gadlink_is_server_member(server_id))
  )
);
create policy gadlink_community_channels_insert on public.text_channels
for insert to authenticated
with check (
  public.gadlink_email_is_confirmed()
  and created_by = auth.uid()
  and public.gadlink_is_server_owner(server_id)
);
create policy gadlink_community_channels_update on public.text_channels
for update to authenticated
using (public.gadlink_email_is_confirmed() and public.gadlink_is_server_owner(server_id))
with check (
  public.gadlink_email_is_confirmed()
  and
  created_by = auth.uid()
  and public.gadlink_is_server_owner(server_id)
);
create policy gadlink_community_channels_delete on public.text_channels
for delete to authenticated
using (public.gadlink_email_is_confirmed() and public.gadlink_is_server_owner(server_id));

drop policy if exists gadlink_channel_messages_read on public.channel_messages;
drop policy if exists gadlink_channel_messages_guard_read on public.channel_messages;
drop policy if exists gadlink_channel_messages_insert on public.channel_messages;
drop policy if exists gadlink_channel_messages_guard_insert on public.channel_messages;
drop policy if exists gadlink_channel_messages_update on public.channel_messages;
drop policy if exists gadlink_channel_messages_guard_update on public.channel_messages;
drop policy if exists gadlink_channel_messages_delete on public.channel_messages;
drop policy if exists gadlink_channel_messages_guard_delete on public.channel_messages;
drop policy if exists gadlink_community_messages_select on public.channel_messages;
drop policy if exists gadlink_community_messages_insert on public.channel_messages;
drop policy if exists gadlink_community_messages_update on public.channel_messages;
drop policy if exists gadlink_community_messages_delete on public.channel_messages;

create policy gadlink_community_messages_select on public.channel_messages
for select to authenticated
using (
  public.gadlink_email_is_confirmed()
  and exists (
    select 1 from public.text_channels c
    where c.id = channel_messages.channel_id
      and c.channel_type <> 'voice'
      and (public.gadlink_is_server_owner(c.server_id)
        or (not c.is_private and public.gadlink_is_server_member(c.server_id)))
  )
);
create policy gadlink_community_messages_insert on public.channel_messages
for insert to authenticated
with check (
  public.gadlink_email_is_confirmed()
  and user_id = auth.uid()
  and exists (
    select 1
    from public.text_channels c
    where c.id = channel_messages.channel_id
      and c.channel_type <> 'voice'
      and (c.channel_type <> 'announcement' or public.gadlink_is_server_owner(c.server_id))
      and (public.gadlink_is_server_owner(c.server_id)
        or (not c.is_private and public.gadlink_is_server_member(c.server_id)))
  )
);
create policy gadlink_community_messages_update on public.channel_messages
for update to authenticated
using (
  public.gadlink_email_is_confirmed()
  and user_id = auth.uid()
  and exists (select 1 from public.text_channels c where c.id = channel_messages.channel_id
    and c.channel_type <> 'voice'
    and (c.channel_type <> 'announcement' or public.gadlink_is_server_owner(c.server_id))
    and (public.gadlink_is_server_owner(c.server_id) or (not c.is_private and public.gadlink_is_server_member(c.server_id))))
)
with check (
  public.gadlink_email_is_confirmed()
  and user_id = auth.uid()
  and exists (select 1 from public.text_channels c where c.id = channel_messages.channel_id
    and c.channel_type <> 'voice'
    and (c.channel_type <> 'announcement' or public.gadlink_is_server_owner(c.server_id))
    and (public.gadlink_is_server_owner(c.server_id) or (not c.is_private and public.gadlink_is_server_member(c.server_id))))
);
create policy gadlink_community_messages_delete on public.channel_messages
for delete to authenticated
using (
  public.gadlink_email_is_confirmed()
  and user_id = auth.uid()
  and exists (select 1 from public.text_channels c where c.id = channel_messages.channel_id
    and c.channel_type <> 'voice'
    and (c.channel_type <> 'announcement' or public.gadlink_is_server_owner(c.server_id))
    and (public.gadlink_is_server_owner(c.server_id) or (not c.is_private and public.gadlink_is_server_member(c.server_id))))
);

grant select, insert, update, delete on public.servers, public.text_channels, public.channel_messages to authenticated;
grant select, delete on public.server_members to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('server-avatars', 'server-avatars', true, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "gadlink server avatar upload" on storage.objects;
drop policy if exists "gadlink server avatar update" on storage.objects;
drop policy if exists "gadlink server avatar delete" on storage.objects;
create policy "gadlink server avatar upload" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'server-avatars'
  and public.gadlink_email_is_confirmed()
  and (storage.foldername(name))[1] = auth.uid()::text
);
create policy "gadlink server avatar update" on storage.objects
for update to authenticated
using (
  bucket_id = 'server-avatars'
  and public.gadlink_email_is_confirmed()
  and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
  bucket_id = 'server-avatars'
  and public.gadlink_email_is_confirmed()
  and (storage.foldername(name))[1] = auth.uid()::text
);
create policy "gadlink server avatar delete" on storage.objects
for delete to authenticated
using (
  bucket_id = 'server-avatars'
  and public.gadlink_email_is_confirmed()
  and (storage.foldername(name))[1] = auth.uid()::text
);
COMMIT;
