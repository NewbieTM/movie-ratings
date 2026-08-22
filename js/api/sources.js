// ============================================================
//  Единый слой источников данных о фильмах
//  Основной: Кинопоиск (kinopoisk.dev) — работает из РФ без VPN
//  Фолбек:   TMDB — если КП недоступен (лимит/сеть)
//  + кэш в localStorage: переживает обрывы сети
// ============================================================

const Movies = (() => {
  const cfg = () => window.APP_CONFIG || {};
  const CACHE_PREFIX = "mr-cache:";
  const TAG_LABELS = {
    movie: "Фильм", "tv-series": "Сериал", cartoon: "Мультфильм",
    anime: "Аниме", "animated-series": "Мультсериал", "tv-show": "ТВ-шоу",
  };

  // ---------- кэш ----------
  function cacheGet(url, maxAgeMs) {
    try {
      const hit = JSON.parse(localStorage.getItem(CACHE_PREFIX + url));
      if (!hit) return null;
      hit.fresh = Date.now() - hit.t < maxAgeMs;
      return hit;
    } catch { return null; }
  }
  function cacheSet(url, data) {
    try {
      localStorage.setItem(CACHE_PREFIX + url, JSON.stringify({ t: Date.now(), data }));
    } catch { /* переполнение localStorage игнорируем */ }
  }

  async function fetchJSON(url, headers) {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      let msg = "";
      try { msg = (await res.text()).slice(0, 150); } catch {}
      throw new Error(`HTTP ${res.status} ${msg}`);
    }
    return res.json();
  }

  /** Запрос с кэшем и доживанием из устаревшего кэша при ошибке сети */
  async function cachedGet(url, headers, ttlMs = 30 * 60e3) {
    const hit = cacheGet(url);
    if (hit && hit.fresh) return hit.data;
    try {
      const data = await fetchJSON(url, headers);
      cacheSet(url, data);
      return data;
    } catch (e) {
      if (hit) return hit.data;           // отдаём устаревший кэш
      throw e;
    }
  }

  // ================= НОРМАЛИЗАЦИЯ =================
  // item: {key, title, origTitle, year, poster, overview, tags[], ratingKp,
  //        ratingImdb, ratingTmdb, votes, media}
  const norm = (o) => Object.assign({
    key: "", title: "", origTitle: "", year: null, poster: null,
    overview: "", tags: [], ratingKp: null, ratingImdb: null, ratingTmdb: null,
    votes: 0, media: "",
  }, o);

  // ================= КИНОПОИСК (kinopoisk.dev v1.4) =================
  const KpSource = {
    name: "kp",
    enabled() { const k = cfg().KINOPOISK_API_KEY; return !!k && !k.startsWith("ВСТАВЬТЕ"); },

    async _get(path, params = {}) {
      const u = new URL(`https://api.kinopoisk.dev/v1.4${path}`);
      for (const [k, v] of Object.entries(params))
        if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, v);
      return cachedGet(u.toString(),
        { "X-API-KEY": cfg().KINOPOISK_API_KEY, accept: "application/json" });
    },

    mapDoc(d) {
      const tags = d.type ? [TAG_LABELS[d.type]].filter(Boolean) : [];
      const persons = d.persons || [];
      const director = (persons.find((p) => /режисс/i.test(p.profession || "")) || {}).name || null;
      const cast = persons.filter((p) => /актер|актёр/i.test(p.profession || ""))
        .slice(0, 8).map((p) => p.name).filter(Boolean);
      return norm({
        key: `kp-${d.id}`, source: "kp", id: d.id,
        title: d.name || d.alternativeName || d.enName || "Без названия",
        origTitle: d.alternativeName || d.enName || "",
        year: Array.isArray(d.year) ? d.year[0] : d.year,
        poster: d.poster?.previewUrl || d.poster?.url || null,
        overview: d.description || "",
        tags, media: d.type || "",
        ratingKp: d.rating?.kp ?? null,
        ratingImdb: d.rating?.imdb ?? null,
        votes: d.votes?.kp || 0,
        director, cast,
        genres: (d.genres || []).map((g) => g.name),
        movieLength: d.movieLength || null,
        ageRating: d.ageRating || null,
      });
    },

    /** Поиск: запрос на любом языке + фильтры + сортировка */
    async search({ query = "", page = 1, limit = 24, type = "", minRating = "", years = "", sort = "smart" }) {
      const params = { page, limit, notNullFields: "name" };
      if (query) params.query = query;
      if (type) params.type = type;
      if (minRating) params.ratingKinopoisk = `${minRating}-10`;
      if (years) params.year = years.replace(/[\s]/g, "");
      if (sort === "rating") { params.sortField = "ratingKinopoisk"; params.sortType = "-1"; }
      else if (sort === "year") { params.sortField = "year"; params.sortType = "-1"; }
      else if (sort === "smart") { params.sortField = "votesKinopoisk"; params.sortType = "-1"; }
      // Подтверждено зондированием: /v1.4/movie принимает query+фильтры+сортировку
      // (домен api.kinopoisk.dev 301->api.poiskkino.dev, fetch следует сам)
      const d = await this._get("/movie", params);
      return {
        items: (d.docs || []).map((x) => this.mapDoc(x)),
        total: d.total || 0, page: d.page || page,
        pages: Math.min(d.pages || 1, 500),
      };
    },

    async home() {
      const yr = new Date().getFullYear();
      const [fresh, popular, top] = await Promise.all([
        this.search({ years: `${yr}-${yr + 1}`, sort: "smart", limit: 18 }),
        this.search({ sort: "smart", limit: 18 }),
        this.search({ sort: "rating", minRating: 7.5, limit: 18 }),
      ]);
      return { fresh: fresh.items, popular: popular.items, top: top.items };
    },

    async details(key) {
      const id = key.replace("kp-", "");
      return this.mapDoc(await this._get(`/movie/${id}`));
    },
  };

  // ================= TMDB (фолбек) =================
  const TmdbSource = {
    name: "tmdb",
    enabled() { const k = cfg().TMDB_API_KEY; return !!k && !k.startsWith("ВСТАВЬТЕ"); },
    IMG: "https://image.tmdb.org/t/p",

    async _get(path, params = {}) {
      const u = new URL(`https://api.themoviedb.org/3${path}`);
      u.searchParams.set("api_key", cfg().TMDB_API_KEY);
      u.searchParams.set("language", cfg().TMDB_LANGUAGE || "ru-RU");
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      return cachedGet(u.toString());
    },

    poster(path, size = "w342") { return path ? `${this.IMG}/${size}${path}` : null; },

    /** Грубая карта тегов для TMDB */
    mapItem(r) {
      const media = r.media_type === "tv" || r.first_air_date ? "tv" : r.media_type === "movie" || r.release_date ? "movie" : "";
      const gids = r.genre_ids || (r.genres || []).map((g) => g.id);
      const tags = [];
      if (gids.includes(16)) tags.push(media === "tv" ? "Мультсериал?" : "Мультфильм?");
      if (media === "tv") tags.unshift("Сериал");
      if (media === "movie") tags.unshift("Фильм");
      const dateStr = r.release_date || r.first_air_date || "";
      const titleKey = media === "tv" ? "name" : "title";
      return norm({
        key: media === "tv" ? `tmdb-tv-${r.id}` : `tmdb-${r.id}`,
        source: "tmdb", id: r.id,
        title: r[titleKey] || r.original_name || r.title || r.original_title || "",
        origTitle: r.original_title || r.original_name || "",
        year: dateStr.slice(0, 4) ? Number(dateStr.slice(0, 4)) : null,
        poster: this.poster(r.poster_path),
        overview: r.overview || "",
        tags, media,
        ratingTmdb: r.vote_average ? Number(r.vote_average.toFixed(1)) : null,
        votes: r.vote_count || 0,
      });
    },

    /** Клиентские фильтры поверх выдачи TMDB */
    _applyFilters(items, { type = "", minRating = "", years = "" }) {
      return items.filter((m) => {
        if (type) {
          if (type.startsWith("tmdb")) { /* не задаётся для TMDB */ }
          const map = { movie: ["Фильм"], "tv-series": ["Сериал"], cartoon: ["Мультфильм?"], anime: ["Аниме"] };
          const want = map[type];
          if (want && !want.some((t) => m.tags.includes(t))) return false;
          if (type === "animated-series" || type === "tv-show") return false;
        }
        const r = m.ratingTmdb;
        if (minRating && !(r && r >= Number(minRating) - 0.5)) return false;
        if (years) {
          const [a, b] = years.split("-").map(Number);
          if (!(m.year >= a && m.year <= b)) return false;
        }
        return true;
      });
    },

    async search({ query = "", page = 1, type = "", minRating = "", years = "", sort = "smart" }) {
      if (!query) return { items: [], total: 0, page: 1, pages: 0 };
      const d = await this._get("/search/multi", { query, page, include_adult: "false" });
      let items = (d.results || []).map((x) => this.mapItem(x)).filter((m) => m.media);
      items = this._applyFilters(items, { type, minRating, years });
      if (sort === "rating")
        items.sort((a, b) => (b.ratingTmdb || 0) * Math.log10(b.votes + 10) - (a.ratingTmdb || 0) * Math.log10(a.votes + 10));
      else if (sort === "year")
        items.sort((a, b) => (b.year || 0) - (a.year || 0));
      return { items, total: d.total_results || 0, page: d.page || page, pages: Math.min(d.total_pages || 1, 500) };
    },

    async home() {
      const [now, pop, top] = await Promise.all([
        this._get("/movie/now_playing", { region: "RU" }).catch(() => ({ results: [] })),
        this._get("/movie/popular"),
        this._get("/movie/top_rated"),
      ]);
      const mapAll = (arr) => arr.map((x) => this.mapItem(x));
      return { fresh: mapAll(now.results || []), popular: mapAll(pop.results || []), top: mapAll(top.results || []) };
    },

    async details(key) {
      const m = key.match(/^tmdb(?:-(tv))?-(\d+)$/);
      const isTv = !!m[1], id = m[2];
      const d = await this._get(`/${isTv ? "tv" : "movie"}/${id}`, { append_to_response: "credits" });
      const item = this.mapItem(d);
      item.key = key;
      item.director = ((d.credits?.crew || []).find((c) => c.job === "Director") || {}).name || null;
      item.cast = (d.credits?.cast || []).slice(0, 8).map((c) => c.name);
      item.genres = (d.genres || []).map((g) => g.name);
      item.movieLength = d.runtime || (d.episode_run_time || [])[0] || null;
      item.overview = d.overview || "";
      return item;
    },
  };

  // ================= Оркестратор с фолбеком =================
  const sources = () =>
    [KpSource, TmdbSource].filter((s) => s.enabled());

  let activeSource = null;
  const activeName = () => activeSource ? activeSource.name : null;

  async function call(method, ...args) {
    const list = sources();
    if (!list.length) throw new Error("Не настроен ни один источник данных (см. README)");
    // предпочитаем последний удачно работавший источник
    if (activeSource) {
      const i = list.indexOf(activeSource);
      if (i > 0) list.unshift(list.splice(i, 1)[0]);
    }
    let lastErr = null;
    for (const s of list) {
      try {
        const res = await s[method](...args);
        activeSource = s;
        return res;
      } catch (e) { lastErr = e; }
    }
    throw new Error(
      `Источники данных недоступны (${lastErr ? lastErr.message : "ошибка сети"}). ` +
      `Показаны данные из кэша, если есть.`
    );
  }

  return {
    search: (q) => call("search", q),
    home: () => call("home"),
    details: (k) => call("details", k),
    activeName,
    TAG_LABELS,
    tagLabel: (raw) => TAG_LABELS[raw] || raw,
  };
})();
