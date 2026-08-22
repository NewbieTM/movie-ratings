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
      // Актуальный хост API (старый api.kinopoisk.dev флапает через редирект)
      const u = new URL(`https://api.poiskkino.dev/v1.4${path}`);
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

    /**
     * Поиск. Проверено зондированием API:
     *  - текстовый поиск: GET /movie/search?query=&sortField=votes.kp (релевантность×популярность);
     *    фильтры type/rating на /search игнорируются — применяем их на клиенте
     *  - просмотр без запроса: GET /movie?type=&rating.kp=&year=&sortField=
     *  - сортировки: votes.kp | rating.kp | year
     * Латинский запрос иногда покрывает не все тайтлы — дополняем выдачей TMDB.
     */
    async search({ query = "", page = 1, limit = 24, type = "", minRating = "", years = "", sort = "smart" }) {
      const sortMap = { smart: "votes.kp", rating: "rating.kp", year: "year" };
      const params = { page, limit };
      if (query) params.query = query;
      if (query) {
        params.sortField = sortMap[sort] || sortMap.smart;
        params.sortType = "-1";
      } else {
        if (type) params.type = type;
        if (minRating) params["rating.kp"] = `${minRating}-10`;
        if (years) params.year = years.replace(/\s/g, "");
        params.sortField = sortMap[sort] || sortMap.smart;
        params.sortType = "-1";
        params.notNullFields = "name";
      }
      const path = query ? "/movie/search" : "/movie";
      let d;
      try {
        d = await this._get(path, params);
      } catch (e) {
        // при сбое поиска пробуем широкий эндпоинт (он хотя бы отдаст базу по сортировке)
        if (!query) throw e;
        d = await this._get("/movie", { ...params, query: undefined });
      }

      // Фильтр по типу при текстовом поиске: /search фильтры игнорирует,
      // поэтому собираем пул из нескольких страниц и ПЕРЕСОБИРАЕМ выдачу —
      // все совпадения оказываются рядом, а не размазаны по чужим страницам.
      if (query && type) {
        const POOL = 120;
        let all = [...(d.docs || [])];
        let p = d.page || 1;
        const maxP = Math.min(d.pages || 1, 8);
        while (all.length < POOL && p < maxP) {
          p++;
          try {
            const nx = await this._get(path, { ...params, page: p });
            const dd = nx.docs || [];
            if (!dd.length) break;
            all.push(...dd);
          } catch { break; }
        }
        const items = all.filter((x) => x.type === type).map((x) => this.mapDoc(x));
        const start = (page - 1) * limit;
        return {
          items: items.slice(start, start + limit),
          total: items.length, page,
          pages: Math.max(1, Math.ceil(items.length / limit)),
        };
      }

      const kpItems = (d.docs || []).map((x) => this.mapDoc(x));

      // Дополняем TMDB-совпадениями (латинские запросы у КП бывают неполными)
      if (query && TmdbSource.enabled()) {
        try {
          const t = await TmdbSource.search({ query, page: 1 });
          const seen = new Set();
          for (const m of kpItems)
            [m.title, m.origTitle].forEach((s) => s && seen.add(`${s.toLowerCase()}|${m.year}`));
          const extras = t.items.filter((m) =>
            ![m.title, m.origTitle].some((s) => s && seen.has(`${s.toLowerCase()}|${m.year}`)));
          kpItems.push(...extras);
          kpItems.sort((a, b) => (b.votes || 0) - (a.votes || 0));
        } catch { /* TMDB не обязателен */ }
      }

      return {
        items: kpItems,
        total: d.total || kpItems.length, page: d.page || page,
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

    async search({ query = "", page = 1, limit = 20, type = "", minRating = "", years = "", sort = "smart" }) {
      if (!query) return { items: [], total: 0, page: 1, pages: 0 };

      // С типом собираем пул страниц и пересобираем выдачу локально
      if (type) {
        let all = [];
        let p = 1;
        while (p <= 5) {
          try {
            const d2 = await this._get("/search/multi", { query, page: p, include_adult: "false" });
            all.push(...(d2.results || []));
            if (p >= Math.min(d2.total_pages || 1, 5)) break;
          } catch { break; }
          p++;
        }
        let items = this._applyFilters(
          all.map((x) => this.mapItem(x)).filter((m) => m.media),
          { type, minRating: "", years: "" }
        );
        if (sort === "rating")
          items.sort((a, b) => (b.ratingTmdb || 0) * Math.log10(b.votes + 10) - (a.ratingTmdb || 0) * Math.log10(a.votes + 10));
        else if (sort === "year")
          items.sort((a, b) => (b.year || 0) - (a.year || 0));
        const start = (page - 1) * limit;
        return {
          items: items.slice(start, start + limit),
          total: items.length, page,
          pages: Math.max(1, Math.ceil(items.length / limit)),
        };
      }

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
  // Порядок приоритета: TMDB основной, Кинопоиск — фолбек.
  // Если основной упал, успешный источник «залипает» на 15 минут,
  // чтобы не тормозить каждый запрос; потом пробуем основной снова.
  const sources = () =>
    [TmdbSource, KpSource].filter((s) => s.enabled());

  let activeSource = null;
  let activeAt = 0;
  const STICKY_MS = 15 * 60e3;
  const disabledUntil = {};          // источники временно в отключке (лимиты)
  const activeName = () => activeSource ? activeSource.name : null;

  function orderedSources() {
    const list = sources().filter((s) => (disabledUntil[s.name] || 0) < Date.now());
    if (activeSource && Date.now() - activeAt < STICKY_MS &&
        !disabledUntil[activeSource?.name]) {
      const i = list.indexOf(activeSource);
      if (i > 0) list.unshift(list.splice(i, 1)[0]);
    }
    return list.length ? list : sources();   // всё отключено — всё равно пробуем
  }

  async function call(method, ...args) {
    const list = orderedSources();
    if (!list.length) throw new Error("Не настроен ни один источник данных (см. README)");
    let lastErr = null;
    for (const s of list) {
      try {
        const res = await s[method](...args);
        activeSource = s;
        activeAt = Date.now();
        return res;
      } catch (e) {
        lastErr = e;
        // исчерпан суточный лимит источника — выключаем его до конца дня
        if (/403|суточн|лимит|Forbid/i.test(String(e.message)))
          disabledUntil[s.name] = Date.now() + 12 * 36e5;
      }
    }
    throw new Error(
      `Источники данных недоступны (${lastErr ? lastErr.message.slice(0, 120) : "ошибка сети"}). ` +
      `Показаны данные из кэша, если есть.`
    );
  }

  /**
   * Рейтинги Кинопоиска и IMDb для тайтла из TMDB:
   * точное сопоставление по externalId.tmdb, кэш на 7 дней
   * (пустой результат тоже кэшируется — на 12 часов).
   * Вызывается при заходе на страницу фильма.
   */
  async function kpRatings(key) {
    const m = String(key).match(/^tmdb(?:-tv)?-(\d+)$/);
    if (!m || !KpSource.enabled()) return null;
    const ck = "mr-kpmap:" + key;
    try {
      const c = JSON.parse(localStorage.getItem(ck));
      if (c && Date.now() - c.t < (c.v ? 7 * 864e5 : 12 * 36e5)) return c.v;
    } catch {}
    try {
      const d = await KpSource._get("/movie", { "externalId.tmdb": m[1], limit: 1 });
      const x = (d.docs || [])[0];
      const r = x?.rating || {};
      const v = x ? {
        ratingKp: r.kp ?? null, ratingImdb: r.imdb ?? null,
        kpId: x.id ?? null, kpType: x.type ?? null,
      } : null;
      try { localStorage.setItem(ck, JSON.stringify({ t: Date.now(), v })); } catch {}
      return v;
    } catch { return null; }
  }

  return {
    search: (q) => call("search", q),
    home: () => call("home"),
    details: (k) => call("details", k),
    activeName,
    TAG_LABELS,
    tagLabel: (raw) => TAG_LABELS[raw] || raw,
    kpRatings,
    // для тестов
    __debug: { KpSource, TmdbSource },
  };
})();
