insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

create or replace function public.gadlink_email_is_confirmed()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from auth.users u
    where u.id = (select auth.uid())
      and u.email_confirmed_at is not null
  )
$$;

revoke all on function public.gadlink_email_is_confirmed() from public;
grant execute on function public.gadlink_email_is_confirmed() to anon, authenticated;

do $$
begin
  if to_regclass('public.conversations') is not null then
    execute $function$
      create or replace function public.gadlink_is_conversation_creator(target_conversation_id uuid)
      returns boolean
      language sql
      stable
      security definer
      set search_path = ''
      as $body$
        select exists (
          select 1
          from public.conversations c
          where c.id = target_conversation_id
            and c.created_by = (select auth.uid())
        )
      $body$
    $function$;
    execute 'revoke all on function public.gadlink_is_conversation_creator(uuid) from public';
    execute 'grant execute on function public.gadlink_is_conversation_creator(uuid) to authenticated';
  end if;
end
$$;

do $$
declare
  rule record;
  statement text;
begin
  for rule in
    select * from (values
      ('public', 'profiles', 'gadlink_profiles_read', 'PERMISSIVE', 'SELECT', 'auth.uid() is not null', null),
      ('public', 'profiles', 'gadlink_profiles_guard_read', 'RESTRICTIVE', 'SELECT', 'auth.uid() is not null', null),
      ('public', 'profiles', 'gadlink_profiles_insert', 'PERMISSIVE', 'INSERT', null, 'id = auth.uid()'),
      ('public', 'profiles', 'gadlink_profiles_guard_insert', 'RESTRICTIVE', 'INSERT', null, 'id = auth.uid()'),
      ('public', 'profiles', 'gadlink_profiles_update', 'PERMISSIVE', 'UPDATE', 'id = auth.uid()', 'id = auth.uid()'),
      ('public', 'profiles', 'gadlink_profiles_guard_update', 'RESTRICTIVE', 'UPDATE', 'id = auth.uid()', 'id = auth.uid()'),

      ('public', 'posts', 'gadlink_posts_read', 'PERMISSIVE', 'SELECT', 'auth.uid() is not null', null),
      ('public', 'posts', 'gadlink_posts_guard_read', 'RESTRICTIVE', 'SELECT', 'auth.uid() is not null', null),
      ('public', 'posts', 'gadlink_posts_insert', 'PERMISSIVE', 'INSERT', null, 'user_id = auth.uid()'),
      ('public', 'posts', 'gadlink_posts_guard_insert', 'RESTRICTIVE', 'INSERT', null, 'user_id = auth.uid()'),
      ('public', 'posts', 'gadlink_posts_update', 'PERMISSIVE', 'UPDATE', 'user_id = auth.uid()', 'user_id = auth.uid()'),
      ('public', 'posts', 'gadlink_posts_guard_update', 'RESTRICTIVE', 'UPDATE', 'user_id = auth.uid()', 'user_id = auth.uid()'),
      ('public', 'posts', 'gadlink_posts_delete', 'PERMISSIVE', 'DELETE', 'user_id = auth.uid()', null),
      ('public', 'posts', 'gadlink_posts_guard_delete', 'RESTRICTIVE', 'DELETE', 'user_id = auth.uid()', null),

      ('public', 'conversations', 'gadlink_conversations_read', 'PERMISSIVE', 'SELECT', 'exists (select 1 from public.conversation_members m where m.conversation_id = conversations.id and m.user_id = auth.uid())', null),
      ('public', 'conversations', 'gadlink_conversations_guard_read', 'RESTRICTIVE', 'SELECT', 'exists (select 1 from public.conversation_members m where m.conversation_id = conversations.id and m.user_id = auth.uid())', null),
      ('public', 'conversations', 'gadlink_conversations_insert', 'PERMISSIVE', 'INSERT', null, 'created_by = auth.uid()'),
      ('public', 'conversations', 'gadlink_conversations_guard_insert', 'RESTRICTIVE', 'INSERT', null, 'created_by = auth.uid()'),
      ('public', 'conversations', 'gadlink_conversations_update', 'PERMISSIVE', 'UPDATE', 'created_by = auth.uid()', 'created_by = auth.uid()'),
      ('public', 'conversations', 'gadlink_conversations_guard_update', 'RESTRICTIVE', 'UPDATE', 'created_by = auth.uid()', 'created_by = auth.uid()'),
      ('public', 'conversations', 'gadlink_conversations_delete', 'PERMISSIVE', 'DELETE', 'created_by = auth.uid()', null),
      ('public', 'conversations', 'gadlink_conversations_guard_delete', 'RESTRICTIVE', 'DELETE', 'created_by = auth.uid()', null),

      ('public', 'conversation_members', 'gadlink_members_read', 'PERMISSIVE', 'SELECT', 'user_id = auth.uid()', null),
      ('public', 'conversation_members', 'gadlink_members_guard_read', 'RESTRICTIVE', 'SELECT', 'user_id = auth.uid()', null),
      ('public', 'conversation_members', 'gadlink_members_insert', 'PERMISSIVE', 'INSERT', null, 'public.gadlink_is_conversation_creator(conversation_id)'),
      ('public', 'conversation_members', 'gadlink_members_guard_insert', 'RESTRICTIVE', 'INSERT', null, 'public.gadlink_is_conversation_creator(conversation_id)'),

      ('public', 'messages', 'gadlink_messages_read', 'PERMISSIVE', 'SELECT', 'exists (select 1 from public.conversation_members m where m.conversation_id = messages.conversation_id and m.user_id = auth.uid())', null),
      ('public', 'messages', 'gadlink_messages_guard_read', 'RESTRICTIVE', 'SELECT', 'exists (select 1 from public.conversation_members m where m.conversation_id = messages.conversation_id and m.user_id = auth.uid())', null),
      ('public', 'messages', 'gadlink_messages_insert', 'PERMISSIVE', 'INSERT', null, 'user_id = auth.uid() and exists (select 1 from public.conversation_members m where m.conversation_id = messages.conversation_id and m.user_id = auth.uid())'),
      ('public', 'messages', 'gadlink_messages_guard_insert', 'RESTRICTIVE', 'INSERT', null, 'user_id = auth.uid() and exists (select 1 from public.conversation_members m where m.conversation_id = messages.conversation_id and m.user_id = auth.uid())'),
      ('public', 'messages', 'gadlink_messages_update', 'PERMISSIVE', 'UPDATE', 'user_id = auth.uid() and exists (select 1 from public.conversation_members m where m.conversation_id = messages.conversation_id and m.user_id = auth.uid())', 'user_id = auth.uid() and exists (select 1 from public.conversation_members m where m.conversation_id = messages.conversation_id and m.user_id = auth.uid())'),
      ('public', 'messages', 'gadlink_messages_guard_update', 'RESTRICTIVE', 'UPDATE', 'user_id = auth.uid() and exists (select 1 from public.conversation_members m where m.conversation_id = messages.conversation_id and m.user_id = auth.uid())', 'user_id = auth.uid() and exists (select 1 from public.conversation_members m where m.conversation_id = messages.conversation_id and m.user_id = auth.uid())'),
      ('public', 'messages', 'gadlink_messages_delete', 'PERMISSIVE', 'DELETE', 'user_id = auth.uid() and exists (select 1 from public.conversation_members m where m.conversation_id = messages.conversation_id and m.user_id = auth.uid())', null),
      ('public', 'messages', 'gadlink_messages_guard_delete', 'RESTRICTIVE', 'DELETE', 'user_id = auth.uid() and exists (select 1 from public.conversation_members m where m.conversation_id = messages.conversation_id and m.user_id = auth.uid())', null),

      ('public', 'servers', 'gadlink_servers_read', 'PERMISSIVE', 'SELECT', 'auth.uid() is not null', null),
      ('public', 'servers', 'gadlink_servers_guard_read', 'RESTRICTIVE', 'SELECT', 'auth.uid() is not null', null),
      ('public', 'servers', 'gadlink_servers_insert', 'PERMISSIVE', 'INSERT', null, 'created_by = auth.uid()'),
      ('public', 'servers', 'gadlink_servers_guard_insert', 'RESTRICTIVE', 'INSERT', null, 'created_by = auth.uid()'),
      ('public', 'servers', 'gadlink_servers_update', 'PERMISSIVE', 'UPDATE', 'created_by = auth.uid()', 'created_by = auth.uid()'),
      ('public', 'servers', 'gadlink_servers_guard_update', 'RESTRICTIVE', 'UPDATE', 'created_by = auth.uid()', 'created_by = auth.uid()'),
      ('public', 'servers', 'gadlink_servers_delete', 'PERMISSIVE', 'DELETE', 'created_by = auth.uid()', null),
      ('public', 'servers', 'gadlink_servers_guard_delete', 'RESTRICTIVE', 'DELETE', 'created_by = auth.uid()', null),

      ('public', 'text_channels', 'gadlink_channels_read', 'PERMISSIVE', 'SELECT', 'auth.uid() is not null', null),
      ('public', 'text_channels', 'gadlink_channels_guard_read', 'RESTRICTIVE', 'SELECT', 'auth.uid() is not null', null),
      ('public', 'text_channels', 'gadlink_channels_insert', 'PERMISSIVE', 'INSERT', null, 'exists (select 1 from public.servers s where s.id = text_channels.server_id and s.created_by = auth.uid())'),
      ('public', 'text_channels', 'gadlink_channels_guard_insert', 'RESTRICTIVE', 'INSERT', null, 'exists (select 1 from public.servers s where s.id = text_channels.server_id and s.created_by = auth.uid())'),
      ('public', 'text_channels', 'gadlink_channels_update', 'PERMISSIVE', 'UPDATE', 'exists (select 1 from public.servers s where s.id = text_channels.server_id and s.created_by = auth.uid())', 'exists (select 1 from public.servers s where s.id = text_channels.server_id and s.created_by = auth.uid())'),
      ('public', 'text_channels', 'gadlink_channels_guard_update', 'RESTRICTIVE', 'UPDATE', 'exists (select 1 from public.servers s where s.id = text_channels.server_id and s.created_by = auth.uid())', 'exists (select 1 from public.servers s where s.id = text_channels.server_id and s.created_by = auth.uid())'),
      ('public', 'text_channels', 'gadlink_channels_delete', 'PERMISSIVE', 'DELETE', 'exists (select 1 from public.servers s where s.id = text_channels.server_id and s.created_by = auth.uid())', null),
      ('public', 'text_channels', 'gadlink_channels_guard_delete', 'RESTRICTIVE', 'DELETE', 'exists (select 1 from public.servers s where s.id = text_channels.server_id and s.created_by = auth.uid())', null),

      ('public', 'channel_messages', 'gadlink_channel_messages_read', 'PERMISSIVE', 'SELECT', 'auth.uid() is not null', null),
      ('public', 'channel_messages', 'gadlink_channel_messages_guard_read', 'RESTRICTIVE', 'SELECT', 'auth.uid() is not null', null),
      ('public', 'channel_messages', 'gadlink_channel_messages_insert', 'PERMISSIVE', 'INSERT', null, 'user_id = auth.uid()'),
      ('public', 'channel_messages', 'gadlink_channel_messages_guard_insert', 'RESTRICTIVE', 'INSERT', null, 'user_id = auth.uid()'),
      ('public', 'channel_messages', 'gadlink_channel_messages_update', 'PERMISSIVE', 'UPDATE', 'user_id = auth.uid()', 'user_id = auth.uid()'),
      ('public', 'channel_messages', 'gadlink_channel_messages_guard_update', 'RESTRICTIVE', 'UPDATE', 'user_id = auth.uid()', 'user_id = auth.uid()'),
      ('public', 'channel_messages', 'gadlink_channel_messages_delete', 'PERMISSIVE', 'DELETE', 'user_id = auth.uid()', null),
      ('public', 'channel_messages', 'gadlink_channel_messages_guard_delete', 'RESTRICTIVE', 'DELETE', 'user_id = auth.uid()', null)
    ) as rules(schema_name, table_name, policy_name, policy_mode, command_name, using_expression, check_expression)
  loop
    if to_regclass(format('%I.%I', rule.schema_name, rule.table_name)) is not null then
      execute format('alter table %I.%I enable row level security', rule.schema_name, rule.table_name);
      if (rule.table_name not in ('conversations', 'conversation_members', 'messages', 'text_channels')
        or (
          to_regclass('public.conversations') is not null
          and to_regclass('public.conversation_members') is not null
          and (rule.table_name <> 'text_channels' or to_regclass('public.servers') is not null)
        ))
        and not exists (
        select 1
        from pg_policies
        where schemaname = rule.schema_name
          and tablename = rule.table_name
          and policyname = rule.policy_name
      ) then
        statement := format(
          'create policy %I on %I.%I as %s for %s to %s',
          rule.policy_name,
          rule.schema_name,
          rule.table_name,
          rule.policy_mode,
          rule.command_name,
          case when rule.policy_mode = 'RESTRICTIVE' then 'public' else 'authenticated' end
        );
        if rule.command_name = 'INSERT' then
          statement := statement || format(' with check (public.gadlink_email_is_confirmed() and (%s))', rule.check_expression);
        elsif rule.command_name = 'UPDATE' then
          statement := statement || format(
            ' using (public.gadlink_email_is_confirmed() and (%s)) with check (public.gadlink_email_is_confirmed() and (%s))',
            rule.using_expression,
            rule.check_expression
          );
        elsif rule.command_name = 'DELETE' then
          statement := statement || format(' using (public.gadlink_email_is_confirmed() and (%s))', rule.using_expression);
        else
          statement := statement || format(' using (public.gadlink_email_is_confirmed() and (%s))', rule.using_expression);
        end if;
        execute statement;
      end if;
    end if;
  end loop;
end
$$;

do $$
declare
  rule record;
begin
  if to_regclass('storage.objects') is not null then
    for rule in
      select * from (values
        ('gadlink_avatars_insert', 'PERMISSIVE', 'INSERT', null, 'bucket_id = ''avatars'' and (storage.foldername(name))[1] = auth.uid()::text'),
        ('gadlink_avatars_guard_insert', 'RESTRICTIVE', 'INSERT', null, 'bucket_id = ''avatars'' and (storage.foldername(name))[1] = auth.uid()::text'),
        ('gadlink_avatars_update', 'PERMISSIVE', 'UPDATE', 'bucket_id = ''avatars'' and (storage.foldername(name))[1] = auth.uid()::text', 'bucket_id = ''avatars'' and (storage.foldername(name))[1] = auth.uid()::text'),
        ('gadlink_avatars_guard_update', 'RESTRICTIVE', 'UPDATE', 'bucket_id = ''avatars'' and (storage.foldername(name))[1] = auth.uid()::text', 'bucket_id = ''avatars'' and (storage.foldername(name))[1] = auth.uid()::text'),
        ('gadlink_avatars_delete', 'PERMISSIVE', 'DELETE', 'bucket_id = ''avatars'' and (storage.foldername(name))[1] = auth.uid()::text', null),
        ('gadlink_avatars_guard_delete', 'RESTRICTIVE', 'DELETE', 'bucket_id = ''avatars'' and (storage.foldername(name))[1] = auth.uid()::text', null)
      ) as rules(policy_name, policy_mode, command_name, using_expression, check_expression)
    loop
      if not exists (
        select 1
        from pg_policies
        where schemaname = 'storage'
          and tablename = 'objects'
          and policyname = rule.policy_name
      ) then
        if rule.command_name = 'INSERT' then
          execute format(
            'create policy %I on storage.objects as %s for insert to %s with check (public.gadlink_email_is_confirmed() and (%s))',
            rule.policy_name,
            rule.policy_mode,
            case when rule.policy_mode = 'RESTRICTIVE' then 'public' else 'authenticated' end,
            rule.check_expression
          );
        elsif rule.command_name = 'UPDATE' then
          execute format(
            'create policy %I on storage.objects as %s for update to %s using (public.gadlink_email_is_confirmed() and (%s)) with check (public.gadlink_email_is_confirmed() and (%s))',
            rule.policy_name,
            rule.policy_mode,
            case when rule.policy_mode = 'RESTRICTIVE' then 'public' else 'authenticated' end,
            rule.using_expression,
            rule.check_expression
          );
        else
          execute format(
            'create policy %I on storage.objects as %s for delete to %s using (public.gadlink_email_is_confirmed() and (%s))',
            rule.policy_name,
            rule.policy_mode,
            case when rule.policy_mode = 'RESTRICTIVE' then 'public' else 'authenticated' end,
            rule.using_expression
          );
        end if;
      end if;
    end loop;
  end if;
end
$$;
