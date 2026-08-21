// ============================================================
//  TMDB API клиент — поиск, новинки, детали фильма
// ============================================================
const TMDB = (() => {
  const BASE = "https://api.themoviedb.org/3";
  const IMG = "https://image.tmdb.org/t/p";

  const cfg = () => window.APP_CONFIG || {};
  const key = () => cfg().TMDB_API_KEY || "";
  const lang = () => cfg().TMDB_LANGUAGE || "ru-RU";

  const isConfigured = () => {
    const k = key();
    return k && k !== "ВСТАВЬТЕ_КЛЮЧ_TMDB";
  };

  async function request(path, params = {}) {
    const url = new URL(BASE + path);
    url.searchParams.set("api_key", key());
    url.searchParams.set("language", lang());
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`TMDB ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  // Поиск фильма по названию
  const search = (query, page = 1) =>
    request("/search/movie", { query, page, include_adult: "false" });

  // Новинки (сейчас в кино)
  const nowPlaying = (page = 1) =>
    request("/movie/now_playing", { page, region: "RU" });

  // Популярные
  const popular = (page = 1) =>
    request("/movie/popular", { page });

  // Детали одного фильма
  const details = (id) =>
    request(`/movie/${id}`, {
      append_to_response: "credits,videos",
    });

  // URL постера
  const poster = (path, size = "w342") =>
    path ? `${IMG}/${size}${path}` : null;

  return { isConfigured, search, nowPlaying, popular, details, poster };
})();
