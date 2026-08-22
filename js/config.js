// ============================================================
//  НАСТРОЙКИ САЙТА — вставьте сюда свои ключи (см. README.md)
// ============================================================
window.APP_CONFIG = {
  // TMDB: бесплатный ключ с https://www.themoviedb.org/settings/api
  // (резервный источник, если Кинопоиск недоступен)
  TMDB_API_KEY: "4e10b5c86be732c20bd58a2a374e902b",

  // Кинопоиск: бесплатный токен с https://kinopoisk.dev (основной источник)
  KINOPOISK_API_KEY: "ВСТАВЬТЕ_ТОКЕН_KINOPOISK",

  // Язык данных TMDB (ru-RU — русские названия и описания)
  TMDB_LANGUAGE: "ru-RU",

  // Supabase: URL проекта и публичный anon-ключ
  // (Project Settings -> API). Если оставить пустыми —
  // сайт будет хранить оценки локально в вашем браузере.
  SUPABASE_URL: "https://tmwdzxjwyssrwwhdvqpq.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_TKXZskcFmimrOhebg6xz-A_v43-dwHQ",
};
