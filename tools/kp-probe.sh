#!/usr/bin/env bash
# Пробник токена kinopoisk.dev: проверяет эндпоинты, ответ и CORS до деплоя.
# Использование: bash tools/kp-probe.sh ТОКЕН
set -euo pipefail
TOK="${1:?нужен токен}"
ORIGIN="https://newbietm.github.io"

req() { # $1=url
  echo "--- GET $1"
  curl --noproxy '*' -sD /tmp/h -o /tmp/b -m 20 "$1" \
    -H "X-API-KEY: $TOK" -H "Origin: $ORIGIN"
  grep -iE "^HTTP/|access-control-allow-origin" /tmp/h || true
  head -c 220 /tmp/b; echo; echo
}

echo "== Базовый поиск (ru) =="
req "https://api.kinopoisk.dev/v1.4/movie?page=1&limit=3&query=%D0%B4%D1%8E%D0%BD%D0%B0&notNullFields=name"
echo "== Поиск (en) =="
req "https://api.kinopoisk.dev/v1.4/movie?page=1&limit=3&query=dune&notNullFields=name"
echo "== Фильтры: сериалы с рейтингом КП >= 8 =="
req "https://api.kinopoisk.dev/v1.4/movie?page=1&limit=3&type=tv-series&ratingKinopoisk=8-10&sortField=votesKinopoisk&sortType=-1&notNullFields=name"
echo "== Детали фильма id=301 (=Дюна? проверка полей persons/rating) =="
req "https://api.kinopoisk.dev/v1.4/movie/301"
echo "== Новинки текущего года =="
Y=$(date +%Y)
req "https://api.kinopoisk.dev/v1.4/movie?page=1&limit=3&year=${Y}-${Y}&sortField=votesKinopoisk&sortType=-1&notNullFields=name"
