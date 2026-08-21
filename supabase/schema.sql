-- ============================================================
--  Схема Supabase для КиноОценки
--  Запустите этот скрипт в Supabase: SQL Editor -> New query
-- ============================================================

create table if not exists public.ratings (
  id bigint generated always as identity primary key,
  movie_id bigint not null,
  movie_title text not null,
  movie_year text,
  movie_poster text,
  rating integer not null check (rating between 1 and 10),
  review text default '',
  user_name text not null default 'аноним',
  updated_at timestamptz not null default now(),
  unique (movie_id, user_name)
);

-- Включаем Row Level Security и разрешаем anon-ключу
-- читать/писать/удалять (сайт публичный, ключ anon публичный по дизайну TMDB-подобных приложений)
alter table public.ratings enable row level security;

drop policy if exists "ratings_select_all" on public.ratings;
create policy "ratings_select_all" on public.ratings
  for select using (true);

drop policy if exists "ratings_insert_all" on public.ratings;
create policy "ratings_insert_all" on public.ratings
  for insert with check (true);

drop policy if exists "ratings_update_all" on public.ratings;
create policy "ratings_update_all" on public.ratings
  for update using (true);

drop policy if exists "ratings_delete_all" on public.ratings;
create policy "ratings_delete_all" on public.ratings
  for delete using (true);
