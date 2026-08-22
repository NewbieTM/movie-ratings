-- ============================================================
--  Миграция v2 для КиноОценки
--  Запустить в Supabase: SQL Editor -> New query -> вставить -> Run
--  Что делает:
--   1) оценки с шагом 0.5 (integer -> numeric)
--   2) id фильмов в формате источника ("kp-301", "tmdb-693134")
--   3) колонки user_id (Telegram-личность) и tag (тип тайтла)
-- ============================================================

-- 1. Половинчатые оценки
alter table public.ratings alter column rating type numeric(3,1);
alter table public.ratings drop constraint if exists ratings_rating_check;
alter table public.ratings add constraint ratings_rating_check
  check (rating between 0.5 and 10);

-- 2. Строковые id фильмов (источник-id)
alter table public.ratings alter column movie_id type text using movie_id::text;

-- 3. Новые колонки
alter table public.ratings add column if not exists user_id text;
alter table public.ratings add column if not exists tag text;

-- Индексы
create index if not exists ratings_user_id_idx on public.ratings(user_id);
create index if not exists ratings_movie_id_idx on public.ratings(movie_id);

-- Уникальность оценки на фильм для пользователей с user_id
-- (старые строки без user_id продолжают жить по правилу movie_id+user_name)
create unique index if not exists ratings_movie_user_uidx
  on public.ratings(movie_id, user_id) where user_id is not null;
