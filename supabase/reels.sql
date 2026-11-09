-- Reels engagement tables and policies. Run in Supabase SQL Editor.
-- This migration does not change the Storage bucket's visibility or upload rules.

create table if not exists public.reel_likes (
  reel_path text not null check (length(reel_path) between 1 and 1024),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (reel_path, user_id)
);

create table if not exists public.reel_saves (
  reel_path text not null check (length(reel_path) between 1 and 1024),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (reel_path, user_id)
);

create table if not exists public.reel_comments (
  id uuid primary key default gen_random_uuid(),
  reel_path text not null check (length(reel_path) between 1 and 1024),
  user_id uuid not null references public.profiles(id) on delete cascade,
  content text not null check (length(trim(content)) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index if not exists reel_comments_path_created_idx on public.reel_comments (reel_path, created_at);

alter table public.reel_likes enable row level security;
alter table public.reel_saves enable row level security;
alter table public.reel_comments enable row level security;

grant select, insert, delete on public.reel_likes to authenticated;
grant select, insert, delete on public.reel_saves to authenticated;
grant select, insert, delete on public.reel_comments to authenticated;

drop policy if exists "gadlink reels list files" on storage.objects;
create policy "gadlink reels list files" on storage.objects
  for select to authenticated using (bucket_id = 'reels');

drop policy if exists "authenticated users read reel likes" on public.reel_likes;
create policy "authenticated users read reel likes" on public.reel_likes
  for select to authenticated using (true);
drop policy if exists "users add own reel likes" on public.reel_likes;
create policy "users add own reel likes" on public.reel_likes
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "users remove own reel likes" on public.reel_likes;
create policy "users remove own reel likes" on public.reel_likes
  for delete to authenticated using (user_id = auth.uid());

drop policy if exists "users read own reel saves" on public.reel_saves;
create policy "users read own reel saves" on public.reel_saves
  for select to authenticated using (user_id = auth.uid());
drop policy if exists "users add own reel saves" on public.reel_saves;
create policy "users add own reel saves" on public.reel_saves
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "users remove own reel saves" on public.reel_saves;
create policy "users remove own reel saves" on public.reel_saves
  for delete to authenticated using (user_id = auth.uid());

drop policy if exists "authenticated users read reel comments" on public.reel_comments;
create policy "authenticated users read reel comments" on public.reel_comments
  for select to authenticated using (true);
drop policy if exists "users add own reel comments" on public.reel_comments;
create policy "users add own reel comments" on public.reel_comments
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "users remove own reel comments" on public.reel_comments;
create policy "users remove own reel comments" on public.reel_comments
  for delete to authenticated using (user_id = auth.uid());
