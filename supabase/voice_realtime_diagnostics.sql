-- Read-only diagnostics for the GadLink incoming-call Realtime subscription.
-- Run in Supabase SQL Editor; this script does not change policies or settings.

-- Check that the call table is included in the publication.
select
  p.pubname,
  p.puballtables,
  coalesce(bool_or(pt.schemaname = 'public' and pt.tablename = 'voice_calls'), false) as voice_calls_published
from pg_catalog.pg_publication p
left join pg_catalog.pg_publication_tables pt on pt.pubname = p.pubname
where p.pubname = 'supabase_realtime'
group by p.pubname, p.puballtables;

-- Check table existence, RLS, and authenticated SELECT grant.
select
  c.oid::regclass as table_name,
  c.relrowsecurity as rls_enabled,
  c.relforcerowsecurity as rls_forced,
  has_table_privilege('authenticated', c.oid, 'select') as authenticated_can_select
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'voice_calls';

-- Review participant SELECT policies on voice_calls.
select policyname, permissive, roles, cmd, qual, with_check
from pg_catalog.pg_policies
where schemaname = 'public' and tablename = 'voice_calls'
order by policyname;

-- Review private-channel authorization policies. The inbox topic must allow
-- authenticated SELECT for voice-inbox:<auth.uid()> and guards must not deny it.
select policyname, permissive, roles, cmd, qual, with_check
from pg_catalog.pg_policies
where schemaname = 'realtime' and tablename = 'messages'
order by cmd, permissive, policyname;

-- Confirm the project currently permits private-only channels or public ones.
-- Dashboard setting is authoritative; this query reports publication state only.
select exists (
  select 1
  from pg_catalog.pg_publication
  where pubname = 'supabase_realtime'
) as supabase_realtime_publication_exists;
