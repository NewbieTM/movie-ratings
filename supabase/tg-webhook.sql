-- ============================================================
--  Telegram-вебхук для КиноОценки: мгновенный ответ бота
--  Запустить один раз: Supabase -> SQL Editor -> вставить -> Run
--
--  Как работает: Telegram шлёт POST с обновлением на
--  https://<проект>.supabase.co/rest/v1/rpc/tg_webhook,
--  а PostgREST возвращает из этой функции JSON вида
--  {"method":"sendMessage",...}, который Telegram исполняет.
--  Никакого сервера не нужно, ответ мгновенный.
-- ============================================================

create or replace function public.tg_webhook(
  update_id            bigint default null,
  message              jsonb default null,
  edited_message       jsonb default null,
  channel_post         jsonb default null,
  edited_channel_post  jsonb default null,
  callback_query       jsonb default null,
  my_chat_member       jsonb default null,
  chat_join_request    jsonb default null,
  inline_query         jsonb default null,
  poll_answer          jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  m   jsonb;
  cid bigint;
  txt text;
  kb  jsonb;
begin
  -- кто пишет и что пишет (любой тип сообщения)
  m := coalesce(message, edited_message, channel_post, edited_channel_post);
  if m is not null then
    cid := m->'chat'->>'id';
    txt := coalesce(m->>'text', '');
  elsif callback_query is not null then
    cid := callback_query->'message'->'chat'->>'id';
    txt := '';
  end if;

  if cid is null then
    return null;                       -- не чат-сообщение: молча ок
  end if;

  kb := json_build_object(
    'inline_keyboard', json_build_array(
      json_build_array(
        json_build_object(
          'text', '🎬 Открыть КиноОценку',
          'web_app', json_build_object(
            'url', 'https://newbietm.github.io/movie-ratings/')
        )
      )
    )
  );

  if txt like '/start%' then
    return json_build_object(
      'method', 'sendMessage',
      'chat_id', cid,
      'text', E'Привет! 👋 Это КиноОценка — твой личный дневник фильмов и сериалов.\n\n'
              || '🎬 Жми кнопку ниже, чтобы открыть приложение:\n'
              || '• ищи любые фильмы и сериалы (работает без VPN)\n'
              || '• ставь оценки от 0.5 до 10 с отзывами\n'
              || '• фильтруй свой список по типу и оценке\n\n'
              || 'Оценки хранятся в облаке и доступны с любого устройства.',
      'reply_markup', kb
    );
  elsif txt <> '' then
    return json_build_object(
      'method', 'sendMessage',
      'chat_id', cid,
      'text', 'Я бот-помощник КиноОценки 🙂 Весь функционал — в приложении, открой его кнопкой ниже.',
      'reply_markup', kb
    );
  end if;

  return null;
end;
$$;

-- anon-ключ должен уметь вызывать функцию (вебхук ходит под ним)
grant execute on function public.tg_webhook(
  bigint, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb
) to anon;
