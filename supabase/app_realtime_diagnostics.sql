-- Read-only. Run AFTER the migrations in realtime_setup.md.
-- Missing tables, disabled RLS, absent publication or policies require attention.
with expected(name) as (values
 ('profiles'),('friendships'),('conversations'),('conversation_members'),
 ('messages'),('conversation_read_state'),('posts'),('channel_messages'),
 ('voice_calls'),('reel_posts'),('reel_likes'),('reel_comments'),
 ('reel_saves'),('reel_reposts'),('user_activity'))
select e.name as table_name,
  c.oid is not null as table_exists,
  c.relrowsecurity as rls_enabled,
  (exists(select 1 from pg_publication where pubname = 'supabase_realtime' and puballtables)
    or exists(select 1 from pg_publication_tables p where p.pubname = 'supabase_realtime'
      and p.schemaname = 'public' and p.tablename = e.name)) as published,
  has_table_privilege('authenticated', c.oid, 'SELECT') as authenticated_can_select,
  (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = e.name
    and p.cmd in ('SELECT','ALL')) as select_policy_count
from expected e left join pg_class c on c.oid = to_regclass('public.' || e.name)
order by e.name;

select policyname, permissive, roles, cmd, qual, with_check
from pg_policies where schemaname = 'realtime' and tablename = 'messages'
order by policyname;

select routine_name from information_schema.routines
where routine_schema = 'public' and routine_name in (
 'gadlink_touch_activity', 'gadlink_set_activity_visibility',
 'gadlink_presence_allowed', 'gadlink_record_reel_view',
 'get_public_profile_details', 'gadlink_get_chat_overview')
order by routine_name;

-- Test policy behavior with real authenticated sessions as well: a policy's
-- existence does not prove that a particular user's membership satisfies it.
