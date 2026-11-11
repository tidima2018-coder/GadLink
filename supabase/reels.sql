-- Reels engagement tables and policies. Run in Supabase SQL Editor.
-- Ensure the private Storage bucket "reels" exists before publishing media.

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

create table if not exists public.reel_reposts (
  reel_path text not null check (length(reel_path) between 1 and 1024),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (reel_path, user_id)
);
create index if not exists reel_reposts_user_created_idx on public.reel_reposts (user_id, created_at desc);
create index if not exists reel_reposts_path_created_idx on public.reel_reposts (reel_path, created_at desc);

create table if not exists public.reel_comments (
  id uuid primary key default gen_random_uuid(),
  reel_path text not null check (length(reel_path) between 1 and 1024),
  user_id uuid not null references public.profiles(id) on delete cascade,
  content text not null check (length(trim(content)) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index if not exists reel_comments_path_created_idx on public.reel_comments (reel_path, created_at);

create table if not exists public.reel_posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (length(trim(title)) between 1 and 120),
  description text not null default '' check (length(description) <= 1000),
  hashtags text[] not null default '{}'
    check (cardinality(hashtags) <= 10),
  media_paths text[] not null
    check (cardinality(media_paths) between 1 and 10),
  media_types text[] not null
    check (cardinality(media_types) between 1 and 10)
    check (media_types <@ array['image', 'video']::text[]),
  created_at timestamptz not null default now(),
  check (cardinality(media_paths) = cardinality(media_types))
);
create index if not exists reel_posts_created_idx on public.reel_posts (created_at desc);

alter table public.reel_likes enable row level security;
alter table public.reel_saves enable row level security;
alter table public.reel_reposts enable row level security;
alter table public.reel_comments enable row level security;
alter table public.reel_posts enable row level security;

grant select, insert, delete on public.reel_likes to authenticated;
grant select, insert, delete on public.reel_saves to authenticated;
grant select, insert, delete on public.reel_reposts to authenticated;

drop policy if exists "gadlink reels list files" on storage.objects;
create policy "gadlink reels list files" on storage.objects
  for select to authenticated using (bucket_id = 'reels');
drop policy if exists "users upload own reel media" on storage.objects;
create policy "users upload own reel media" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'reels' and (storage.foldername(name))[1] = auth.uid()::text
  );
drop policy if exists "users remove own reel media" on storage.objects;
create policy "users remove own reel media" on storage.objects
  for delete to authenticated using (
    bucket_id = 'reels' and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "users remove own reel posts" on public.reel_posts;
create policy "users remove own reel posts" on public.reel_posts
  for delete to authenticated using (user_id = auth.uid());

drop policy if exists "authenticated users read reel posts" on public.reel_posts;
create policy "authenticated users read reel posts" on public.reel_posts
  for select to authenticated using (true);
drop policy if exists "users publish own reels" on public.reel_posts;
create policy "users publish own reels" on public.reel_posts
  for insert to authenticated with check (
    user_id = auth.uid() and not exists (
      select 1 from unnest(media_paths) as uploaded_path(path)
      where split_part(uploaded_path.path, '/', 1) <> auth.uid()::text
    )
  );
drop policy if exists "users edit own reel posts" on public.reel_posts;
create policy "users edit own reel posts" on public.reel_posts
  for update to authenticated using (user_id = auth.uid()) with check (
    user_id = auth.uid() and not exists (
      select 1 from unnest(media_paths) as uploaded_path(path)
      where split_part(uploaded_path.path, '/', 1) <> auth.uid()::text
    )
  );
drop policy if exists "users delete own reel posts" on public.reel_posts;
create policy "users delete own reel posts" on public.reel_posts
  for delete to authenticated using (user_id = auth.uid());

create or replace function public.cleanup_reel_post_interactions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.reel_likes where reel_path = any(old.media_paths);
  delete from public.reel_saves where reel_path = any(old.media_paths);
  delete from public.reel_reposts where reel_path = any(old.media_paths);
  delete from public.reel_comments where reel_path = any(old.media_paths);
  return old;
end;
$$;
revoke all on function public.cleanup_reel_post_interactions() from public, anon, authenticated;
drop trigger if exists cleanup_reel_post_interactions on public.reel_posts;
create trigger cleanup_reel_post_interactions
  after delete on public.reel_posts
  for each row execute function public.cleanup_reel_post_interactions();

drop policy if exists "authenticated users read reel likes" on public.reel_likes;
create policy "authenticated users read reel likes" on public.reel_likes
  for select to authenticated using (true);
drop policy if exists "users add own reel likes" on public.reel_likes;
create policy "users add own reel likes" on public.reel_likes
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "users remove own reel likes" on public.reel_likes;
create policy "users remove own reel likes" on public.reel_likes
  for delete to authenticated using (user_id = auth.uid());

drop policy if exists "authenticated users read reel reposts" on public.reel_reposts;
create policy "authenticated users read reel reposts" on public.reel_reposts
  for select to authenticated using (true);
drop policy if exists "users add own reel reposts" on public.reel_reposts;
create policy "users add own reel reposts" on public.reel_reposts
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "users remove own reel reposts" on public.reel_reposts;
create policy "users remove own reel reposts" on public.reel_reposts
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

drop policy if exists "authenticated users read reel reposts" on public.reel_reposts;
create policy "authenticated users read reel reposts" on public.reel_reposts
  for select to authenticated using (true);
drop policy if exists "users add own reel reposts" on public.reel_reposts;
create policy "users add own reel reposts" on public.reel_reposts
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "users remove own reel reposts" on public.reel_reposts;
create policy "users remove own reel reposts" on public.reel_reposts
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
create or replace function public.gadlink_delete_reel_post(target_post_id uuid)
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_media_paths text[];
begin
  if v_user_id is null then
    raise exception 'Необходима авторизация.' using errcode = '42501';
  end if;

  select p.media_paths into v_media_paths
  from public.reel_posts p
  where p.id = target_post_id and p.user_id = v_user_id
  for update;
  if not found then
    raise exception 'Публикация не найдена или принадлежит другому пользователю.' using errcode = '42501';
  end if;

  delete from public.reel_posts where id = target_post_id and user_id = v_user_id;
  return v_media_paths;
end
$$;

revoke all on function public.gadlink_delete_reel_post(uuid) from public;
grant execute on function public.gadlink_delete_reel_post(uuid) to authenticated;

do $$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime')
    and not exists (
      select 1 from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'reel_reposts'
    )
  then
    alter publication supabase_realtime add table public.reel_reposts;
  end if;
end
$$;

