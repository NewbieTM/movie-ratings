-- ============================================================
--  БЕЗОПАСНОСТЬ: закрытие RLS по подписи Telegram initData.
--  Запустить один раз: Supabase -> SQL Editor -> вставить -> Run
--
--  Как работает:
--   • Клиент в мини аппе шлёт заголовок x-tg-init = Telegram.WebApp.initData
--   • Postgres проверяет HMAC-SHA256 подпись бота (pgcrypto), свежесть
--     auth_date (< 24 ч) и вытаскивает user_id ТОЛЬКО из проверенных данных
--   • Строки видны/меняемы только их владельцу: user_id = проверенный id
--   • Веб-версия (вне Telegram): случайный ключ браузера x-web-key,
--     хранится в колонке web_key — доступ только со своего браузера
--   • Старые строки с никами (user_name, без web_key) становятся недоступны
-- ============================================================

-- ---------- секреты ----------
create schema if not exists private;

create table if not exists private.secrets (
  k text primary key,
  v text not null
);
revoke all on private.secrets from anon, authenticated, public;

insert into private.secrets(k, v) values
  ('bot_token', '8774910152:AAE5JrQZSCTVxkMecQcw9hG8z_XuVC0l4JU')
on conflict (k) do update set v = excluded.v;

-- ---------- percent-decoding ----------
create or replace function public.pct_decode(s text)
returns text language plpgsql immutable as $$
declare
  i int := 1; n int := length(s); r text := '';
begin
  while i <= n loop
    if substr(s, i, 1) = '%' and i + 2 <= n then
      r := r || chr(('x' || substr(s, i + 1, 2))::bit(8)::int);
      i := i + 3;
    elsif substr(s, i, 1) = '+' then
      r := r || ' '; i := i + 1;
    else
      r := r || substr(s, i, 1); i := i + 1;
    end if;
  end loop;
  return r;
end $$;

-- ---------- проверка initData: возвращает 'tg-<id>' либо NULL ----------
create or replace function public.tg_init_uid()
returns text
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  hdr   jsonb;
  raw   text;
  pair  text;
  dcs   text;
  hash_given text;
  auth_date  bigint;
  uid   text;
  tok   text;
  secret bytea;
begin
  begin
    hdr := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then
    hdr := null;
  end;
  raw := coalesce(hdr ->> 'x-tg-init', '');
  if raw = '' then
    return null;
  end if;

  -- data-check-string: пары key=value (кроме hash), сортировка по ключу (байтовая)
  select string_agg(split_part(pair, '=', 1) || '=' ||
                    public.pct_decode(substr(pair, position('=' in pair) + 1)),
                    E'\n' order by split_part(pair, '=', 1) collate "C")
  into dcs
  from unnest(string_to_array(raw, '&')) as pair
  where pair not like 'hash=%';

  select public.pct_decode(substr(pair, 6)) into hash_given
  from unnest(string_to_array(raw, '&')) as pair
  where pair like 'hash=%'
  limit 1;

  select nullif(public.pct_decode(substr(pair, position('=' in pair) + 1)), '')::bigint
    into auth_date
  from unnest(string_to_array(raw, '&')) as pair
  where split_part(pair, '=', 1) = 'auth_date'
  limit 1;

  select public.pct_decode(substr(pair, position('=' in pair) + 1))::jsonb ->> 'id'
    into uid
  from unnest(string_to_array(raw, '&')) as pair
  where split_part(pair, '=', 1) = 'user'
  limit 1;

  if hash_given is null or auth_date is null or uid is null or dcs is null then
    return null;
  end if;
  if abs(extract(epoch from now()) - auth_date) > 86400 then
    return null;                                   -- данные старше суток: replay
  end if;

  select v into tok from private.secrets where k = 'bot_token';
  if tok is null then
    return null;
  end if;

  secret := hmac(convert_to(tok, 'UTF8'), convert_to('WebAppData', 'UTF8'), 'sha256');
  if encode(hmac(convert_to(dcs, 'UTF8'), secret, 'sha256'), 'hex') <> lower(hash_given) then
    return null;                                   -- подпись не сошлась
  end if;

  return 'tg-' || uid;
end $$;

-- ---------- веб-ключ браузера ----------
create or replace function public.web_key()
returns text
language sql stable
as $$
  select coalesce(nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-web-key', '');
$$;

-- ---------- колонки web_key ----------
alter table public.ratings  add column if not exists web_key text;
alter table public.watchlist add column if not exists web_key text;
create index if not exists ratings_webkey_idx   on public.ratings (web_key);
create index if not exists watchlist_webkey_idx on public.watchlist (web_key);

-- ---------- политики ratings ----------
drop policy if exists "ratings_select_all"  on public.ratings;
drop policy if exists "ratings_insert_all"  on public.ratings;
drop policy if exists "ratings_update_all"  on public.ratings;
drop policy if exists "ratings_delete_all"  on public.ratings;
drop policy if exists "anon all ratings"    on public.ratings;

create policy "ratings_select_own" on public.ratings
  for select to anon using (
    user_id = public.tg_init_uid()
    or (coalesce(user_id,'') like 'tgu-%' and web_key is not null
        and web_key = public.web_key())
  );

create policy "ratings_insert_own" on public.ratings
  for insert to anon with check (
    user_id = public.tg_init_uid()
    or (coalesce(user_id,'') like 'tgu-%' and web_key = public.web_key())
  );

create policy "ratings_update_own" on public.ratings
  for update to anon
  using (
    user_id = public.tg_init_uid()
    or (coalesce(user_id,'') like 'tgu-%' and web_key is not null
        and web_key = public.web_key())
  )
  with check (
    user_id = public.tg_init_uid()
    or (coalesce(user_id,'') like 'tgu-%' and web_key = public.web_key())
  );

create policy "ratings_delete_own" on public.ratings
  for delete to anon using (
    user_id = public.tg_init_uid()
    or (coalesce(user_id,'') like 'tgu-%' and web_key is not null
        and web_key = public.web_key())
  );

-- ---------- политики watchlist ----------
drop policy if exists "anon all watchlist" on public.watchlist;

create policy "watchlist_select_own" on public.watchlist
  for select to anon using (
    user_id = public.tg_init_uid()
    or (coalesce(user_id,'') like 'tgu-%' and web_key is not null
        and web_key = public.web_key())
  );

create policy "watchlist_insert_own" on public.watchlist
  for insert to anon with check (
    user_id = public.tg_init_uid()
    or (coalesce(user_id,'') like 'tgu-%' and web_key = public.web_key())
  );

create policy "watchlist_update_own" on public.watchlist
  for update to anon
  using (
    user_id = public.tg_init_uid()
    or (coalesce(user_id,'') like 'tgu-%' and web_key is not null
        and web_key = public.web_key())
  )
  with check (
    user_id = public.tg_init_uid()
    or (coalesce(user_id,'') like 'tgu-%' and web_key = public.web_key())
  );

create policy "watchlist_delete_own" on public.watchlist
  for delete to anon using (
    user_id = public.tg_init_uid()
    or (coalesce(user_id,'') like 'tgu-%' and web_key is not null
        and web_key = public.web_key())
  );

-- ============================================================
--  ЭКСТРЕННЫЙ ОТКАТ (если что-то сломалось): выполнить этот блок,
--  вернуть открытые политики как раньше:
--
--  drop policy if exists "ratings_select_own" on public.ratings;
--  ... (все *_own) ...
--  create policy "open_r" on public.ratings for all to anon using (true) with check (true);
--  create policy "open_w" on public.watchlist for all to anon using (true) with check (true);
-- ============================================================
