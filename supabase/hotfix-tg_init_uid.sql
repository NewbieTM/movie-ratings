-- ============================================================
--  ХОТФИКС v2: pgcrypto вызывается со схемой extensions
--  (ранее hmac() не находилась -> 42883 / HTTP 404 на подписанных запросах).
--  Выполнить этот один блок в SQL Editor — политики трогать не нужно.
-- ============================================================
create extension if not exists pgcrypto with schema extensions;
create or replace function public.tg_init_uid()
returns text
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  hdr   jsonb;
  raw   text;
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

  secret := extensions.hmac(convert_to(tok, 'UTF8'), convert_to('WebAppData', 'UTF8'), 'sha256');
  if encode(extensions.hmac(convert_to(dcs, 'UTF8'), secret, 'sha256'), 'hex') <> lower(hash_given) then
    return null;                                   -- подпись не сошлась
  end if;

  return 'tg-' || uid;
end $$;
