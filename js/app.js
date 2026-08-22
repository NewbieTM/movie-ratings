// ============================================================
//  КиноОценка v2 — SPA + Telegram Mini App
//  Половинчатые оценки, теги, фильтры, пагинация, КП/IMDb рейтинги,
//  источники Кинопоиск↔TMDB с фолбеком, вход через Telegram.
// ============================================================
const App = (() => {
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const TG = () => window.Telegram && window.Telegram.WebApp;
  const fmtR = (v) => (v == null ? "—" : Number(v).toFixed(1));

  let myRatings = new Map();      // movie_key -> row
  const keyCache = new Map();     // movie_key -> normalized item
  let myListRows = [];            // кэш строк для «Моего списка»

  // ================= Telegram Mini App =================
  function initTelegram() {
    const t = TG();
    if (!t) return false;
    try {
      t.ready();
      t.expand();
      if (t.setHeaderColor) t.setHeaderColor("#0d1117");
      if (t.setBackgroundColor) t.setBackgroundColor("#0d1117");
      if (t.enableClosingConfirmation) t.enableClosingConfirmation();
    } catch {}
    if (Store.inTelegram()) {
      Store.claimLegacy().then((n) => {
        if (n > 0) toast(`Склеено старых оценок по нику: ${n}`);
      }).catch(() => {});
    }
    return true;
  }

  function haptic(kind = "selection") {
    try {
      const hf = TG()?.HapticFeedback;
      if (!hf) return;
      kind === "impact" ? hf.impactOccurred("light") : hf.selectionChanged();
    } catch {}
  }

  let backCb = null;
  function backButton(show, cb) {
    const t = TG();
    if (!t || !t.BackButton) return;
    if (show) {
      t.BackButton.onClick(cb);
      t.BackButton.show();
    } else {
      try { t.BackButton.offClick(cb); } catch {}
      t.BackButton.hide();
    }
  }

  function hideMainButton() {
    try { TG()?.MainButton?.hide(); } catch {}
  }

  // ================= Звёзды с шагом 0.5 =================
  function starsWidget(initial, onChange) {
    let value = initial || 0;
    const el = document.createElement("div");
    el.className = "stars interactive";
    for (let i = 1; i <= 10; i++) {
      const s = document.createElement("span");
      s.className = "star";
      s.dataset.i = i;
      s.innerHTML = `<span class="fill">★</span><i class="zl"></i><i class="zr"></i>`;
      el.appendChild(s);
    }
    function render() {
      el.querySelectorAll(".star").forEach((s) => {
        const i = +s.dataset.i;
        const w = value >= i ? 100 : value === i - 0.5 ? 50 : 0;
        s.querySelector(".fill").style.width = w + "%";
        s.classList.toggle("half", w === 50);
      });
      el.title = `${value || 0} из 10`;
    }
    el.addEventListener("click", (e) => {
      const z = e.target.closest(".zl,.zr");
      if (!z) return;
      const i = +z.parentElement.dataset.i;
      value = z.classList.contains("zl") ? i - 0.5 : i;
      render();
      haptic();
      onChange && onChange(value);
    });
    render();
    el.getValue = () => value;
    return el;
  }

  function starsStatic(value) {
    let out = `<span class="stars static">`;
    for (let i = 1; i <= 10; i++) {
      const w = value >= i ? 100 : value === i - 0.5 ? 50 : 0;
      out += `<span class="star${w === 50 ? " half" : ""}"><span class="fill" style="width:${w}%">★</span></span>`;
    }
    return out + `</span>`;
  }

  // ================= Карточки =================
  function badgesHTML(m) {
    const b = [];
    m.ratingKp != null && b.push(`<span class="rb kp">КП ${fmtR(m.ratingKp)}</span>`);
    m.ratingImdb != null && b.push(`<span class="rb imdb">IMDb ${fmtR(m.ratingImdb)}</span>`);
    m.ratingTmdb != null && b.push(`<span class="rb tmdb">TMDB ${fmtR(m.ratingTmdb)}</span>`);
    return b.join("");
  }
  const tagChipsHTML = (tags) =>
    (tags || []).map((t) => `<span class="chip">${esc(String(t).replace("?", ""))}</span>`).join("");

  function cardHTML(m) {
    const my = myRatings.get(m.key);
    keyCache.set(m.key, m);
    return `
      <div class="card">
        <a class="poster" href="#/movie/${m.key}">
          ${m.poster ? `<img loading="lazy" src="${m.poster}" alt="${esc(m.title)}">`
                     : `<div class="poster-fallback">🎬</div>`}
          ${badgesHTML(m)}
        </a>
        <div class="card-body">
          <a class="card-title" href="#/movie/${m.key}">${esc(m.title)}</a>
          <div class="card-meta">${esc(m.year || "—")} ${tagChipsHTML(m.tags)}</div>
          ${my ? `<div class="mine"><b>${fmtR(my.rating)}</b>/10 ${starsStatic(Number(my.rating))}</div>` : ""}
        </div>
      </div>`;
  }
  const gridHTML = (items) => items.length
    ? `<div class="grid">${items.map(cardHTML).join("")}</div>`
    : `<p class="empty">Ничего не найдено.</p>`;

  // ================= Фильтры поиска =================
  const TYPES = [
    ["", "Все типы"], ["movie", "Фильмы"], ["tv-series", "Сериалы"],
    ["cartoon", "Мультфильмы"], ["anime", "Аниме"],
    ["animated-series", "Мультсериалы"], ["tv-show", "ТВ-шоу"],
  ];
  const SORTS = [["smart", "Популярные"], ["rating", "По рейтингу"], ["year", "По году"]];

  function filterBarHTML(p) {
    return `
      <form id="filters" class="filters">
        <select name="type">
          ${TYPES.map(([v, l]) => `<option value="${v}" ${p.type === v ? "selected" : ""}>${l}</option>`).join("")}
        </select>
        <select name="sort">
          ${SORTS.map(([v, l]) => `<option value="${v}" ${(p.sort || "smart") === v ? "selected" : ""}>${l}</option>`).join("")}
        </select>
        <input name="minRating" type="number" min="0" max="10" step="0.5" placeholder="Рейтинг ≥" value="${esc(p.minRating || "")}">
        <input name="years" type="text" placeholder="Годы: 2020-2024" value="${esc(p.years || "")}">
        <button class="btn primary sm" type="submit">Применить</button>
      </form>`;
  }
  function readFilters(form) {
    const o = {};
    for (const [k, v] of new FormData(form).entries())
      if (String(v).trim()) o[k] = String(v).trim();
    return o;
  }
  function searchHash(query, params, page = 1) {
    const p = new URLSearchParams(params);
    if (page > 1) p.set("page", page);
    const qs = p.toString();
    return `#/search/${encodeURIComponent(query)}${qs ? "?" + qs : ""}`;
  }

  function paginationHTML(total, page, pages, mkHref) {
    if (pages <= 1) return total ? `<p class="found">Найдено: ${total}</p>` : "";
    const nums = [];
    const from = Math.max(1, page - 2), to = Math.min(pages, page + 2);
    if (from > 1) nums.push(`<a href="${mkHref(1)}">1</a>`, from > 2 ? `<span class="dots">…</span>` : "");
    for (let i = from; i <= to; i++)
      nums.push(`<a class="${i === page ? "cur" : ""}" href="${mkHref(i)}">${i}</a>`);
    if (to < pages) nums.push(to < pages - 1 ? `<span class="dots">…</span>` : "", `<a href="${mkHref(pages)}">${pages}</a>`);
    return `<p class="found">Найдено: ${total}</p><nav class="pager">
      ${page > 1 ? `<a href="${mkHref(page - 1)}">← Назад</a>` : ""}${nums.join("")}
      ${page < pages ? `<a href="${mkHref(page + 1)}">Вперёд →</a>` : ""}</nav>`;
  }

  // ================= Страницы =================
  async function viewHome(root) {
    root.innerHTML = `<p class="loading">Загрузка…</p>`;
    const d = await Movies.home();
    const srcLabel = Movies.activeName() === "tmdb"
      ? "источник: TMDB (Кинопоиск недоступен)" : "источник: Кинопоиск";
    root.innerHTML = `
      <p class="src-note">${srcLabel}</p>
      ${d.fresh.length ? `<h2>Новинки</h2>${gridHTML(d.fresh)}` : ""}
      ${d.popular.length ? `<h2>Популярное</h2>${gridHTML(d.popular)}` : ""}
      ${d.top.length ? `<h2>Высокие рейтинги</h2>${gridHTML(d.top)}` : ""}`;
  }

  async function viewSearch(root, query, params) {
    const page = Math.max(1, parseInt(params.page || "1", 10) || 1);
    root.innerHTML =
      `<h2>Поиск: «${esc(query)}»</h2>${filterBarHTML(params)}<div id="results"><p class="loading">Ищем…</p></div>`;
    $("#filters").onsubmit = (e) => {
      e.preventDefault();
      location.hash = searchHash(query, readFilters(e.target));
    };
    const resEl = $("#results");
    try {
      const d = await Movies.search({ query, page, ...params });
      resEl.innerHTML =
        gridHTML(d.items) +
        paginationHTML(d.total, d.page, d.pages, (p) => searchHash(query, params, p));
      window.scrollTo(0, 0);
    } catch (e) {
      resEl.innerHTML = `<p class="error">Поиск недоступен: ${esc(e.message)}</p>`;
    }
  }

  async function viewMovie(root, key) {
    root.innerHTML = `<p class="loading">Загружаем…</p>`;
    let m;
    try { m = await Movies.details(key); }
    catch (e) {
      root.innerHTML = `<p class="error">Не удалось загрузить: ${esc(e.message)}</p>`;
      return;
    }
    keyCache.set(key, m);
    const my = myRatings.get(key);

    root.innerHTML = `
      <div class="movie-page">
        <div class="movie-poster">
          ${m.poster ? `<img src="${m.poster}" alt="${esc(m.title)}">`
                     : `<div class="poster-fallback big">🎬</div>`}
          <div class="ext-ratings">
            <div class="ext"><span class="lbl">Кинопоиск</span><b>${fmtR(m.ratingKp)}</b></div>
            <div class="ext"><span class="lbl">IMDb</span><b>${fmtR(m.ratingImdb)}</b></div>
            ${m.ratingTmdb != null ? `<div class="ext"><span class="lbl">TMDB</span><b>${fmtR(m.ratingTmdb)}</b></div>` : ""}
          </div>
        </div>
        <div class="movie-info">
          <h1>${esc(m.title)} <span class="year">(${esc(m.year || "—")})</span></h1>
          ${m.origTitle && m.origTitle !== m.title ? `<p class="tagline">${esc(m.origTitle)}</p>` : ""}
          <div class="meta">${tagChipsHTML(m.tags)}
            ${(m.genres || []).slice(0, 4).map((g) => `<span class="chip dim">${esc(g)}</span>`).join("")}
            ${m.movieLength ? `<span class="chip dim">⏱ ${m.movieLength} мин</span>` : ""}
          </div>
          ${m.director ? `<p class="cast">Режиссёр: ${esc(m.director)}</p>` : ""}
          ${m.cast && m.cast.length ? `<p class="cast">В ролях: ${esc(m.cast.join(", "))}</p>` : ""}
          <p class="overview">${esc(m.overview || "Описание отсутствует.")}</p>
          <div class="rate-box">
            <h3>${my ? `Ваша оценка: <span class="accent">${fmtR(my.rating)}</span> из 10` : "Поставьте оценку"}</h3>
            <div id="rate-stars"></div>
            <textarea id="review" placeholder="Отзыв (необязательно)…">${esc(my?.review || "")}</textarea>
            <div class="rate-actions">
              <button id="save-rating" class="btn primary">Сохранить</button>
              ${my ? `<button id="delete-rating" class="btn danger">Удалить</button>` : ""}
            </div>
          </div>
          <a class="kp-link" target="_blank" rel="noopener"
             href="https://www.kinopoisk.ru/index.php?kp_query=${encodeURIComponent(m.origTitle || m.title)}">
             Найти на Кинопоиске ↗</a>
        </div>
      </div>`;

    const stars = starsWidget(my?.rating || 0);
    $("#rate-stars").appendChild(stars);

    async function doSave() {
      const val = stars.getValue();
      if (!val) { toast("Сначала выберите оценку", true); return; }
      try {
        await ensureIdentity();
        await Store.save({
          movie_id: m.key,
          movie_title: m.title,
          movie_year: m.year,
          movie_poster: m.poster || null,
          tag: (m.tags || [])[0] || null,
          rating: val,
          review: $("#review").value,
        });
        await refreshMine();
        haptic("impact");
        toast("Сохранено ✓");
        hideMainButton();
        viewMovie(root, key);
      } catch (e) { toast(e.message, true); }
    }
    async function doDelete() {
      try {
        await Store.remove(m.key);
        await refreshMine();
        toast("Оценка удалена");
        viewMovie(root, key);
      } catch (e) { toast(e.message, true); }
    }

    $("#save-rating").onclick = doSave;
    const del = $("#delete-rating");
    if (del) del.onclick = doDelete;

    const t = TG();
    if (t && t.MainButton) {
      t.MainButton.setText("Сохранить оценку");
      t.MainButton.onClick(doSave);
      t.MainButton.show();
    }
  }

  async function viewMy(root, params) {
    if (!myListRows.length) myListRows = await Store.mine().catch(() => []);
    const q = (params.q || "").toLowerCase();
    const from = parseFloat(params.from || "0") || 0;
    const to = parseFloat(params.to || "10") || 10;
    const tag = params.tag || "";
    const sort = params.sort || "date";

    let rows = myListRows.filter((r) =>
      (!q || r.movie_title.toLowerCase().includes(q)) &&
      (Number(r.rating) >= from && Number(r.rating) <= to) &&
      (!tag || r.tag === tag));

    if (sort === "rating") rows.sort((a, b) => b.rating - a.rating);
    else if (sort === "title") rows.sort((a, b) => a.movie_title.localeCompare(b.movie_title, "ru"));
    else rows.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));

    const avg = rows.length ? (rows.reduce((s, r) => s + Number(r.rating), 0) / rows.length).toFixed(1) : "—";
    const usedTags = [...new Set(myListRows.map((r) => r.tag).filter(Boolean))];

    root.innerHTML = `
      <h2>Мой список <span class="count">${rows.length}${rows.length !== myListRows.length ? ` из ${myListRows.length}` : ""} · средняя ${avg}</span></h2>
      <form id="myfilters" class="filters wrap">
        <input name="q" type="text" placeholder="Фильтр по названию…" value="${esc(params.q || "")}">
        <select name="tag">
          <option value="">Все типы</option>
          ${usedTags.map((t) => `<option value="${esc(t)}" ${tag === t ? "selected" : ""}>${esc(t)}</option>`).join("")}
        </select>
        <label class="range">от
          <input name="from" type="number" min="0" max="10" step="0.5" value="${params.from || "0"}"></label>
        <label class="range">до
          <input name="to" type="number" min="0" max="10" step="0.5" value="${params.to || "10"}"></label>
        <select name="sort">
          <option value="date" ${sort === "date" ? "selected" : ""}>По дате</option>
          <option value="rating" ${sort === "rating" ? "selected" : ""}>По оценке</option>
          <option value="title" ${sort === "title" ? "selected" : ""}>По названию</option>
        </select>
        <button class="btn primary sm" type="submit">Применить</button>
      </form>
      <div id="myresults">${renderMyGrid(rows)}</div>`;

    $("#myfilters").onsubmit = (e) => {
      e.preventDefault();
      const p = new URLSearchParams(readFilters(e.target));
      location.hash = `#/my${p.toString() ? "?" + p.toString() : ""}`;
    };
  }

  const TMDB_IMG_W342 = (p) =>
    p.startsWith("http") ? p : `https://image.tmdb.org/t/p/w342${p}`;

  function renderMyGrid(rows) {
    if (!myListRows.length)
      return `<p class="empty">Пока пусто. Найдите фильм через поиск и поставьте оценку.</p>`;
    if (!rows.length)
      return `<p class="empty">Под фильтры ничего не подошло.</p>`;
    return `<div class="grid">${rows.map((r) => `
        <div class="card">
          <a class="poster" href="#/movie/${r.movie_id}">
            ${r.movie_poster ? `<img loading="lazy" src="${TMDB_IMG_W342(r.movie_poster)}" alt="">`
                             : `<div class="poster-fallback">🎬</div>`}
          </a>
          <div class="card-body">
            <a class="card-title" href="#/movie/${r.movie_id}">${esc(r.movie_title)}</a>
            <div class="card-meta">${esc(r.movie_year || "—")}${r.tag ? ` <span class="chip">${esc(r.tag)}</span>` : ""}</div>
            <div class="mine"><b>${fmtR(r.rating)}</b>/10 ${starsStatic(Number(r.rating))}</div>
            ${r.review ? `<p class="mini-review">${esc(r.review)}</p>` : ""}
          </div>
        </div>`).join("")}</div>`;
  }

  // ================= Личность на веб-версии =================
  async function ensureIdentity() {
    const me = Store.identity();
    if (me.userId || me.displayName) return me;
    const name = prompt("Как вас подписывать под оценками?");
    if (!name) throw new Error("Нужен ник для сохранения оценок");
    Store.setProfile(name);
    return Store.identity();
  }

  // ================= Роутер =================
  function parseHash() {
    const h = location.hash || "#/";
    const [pathPart, qs] = h.slice(1).split("?");
    const params = Object.fromEntries(new URLSearchParams(qs || ""));
    const parts = pathPart.split("/").filter(Boolean);
    if (parts[0] === "search") return { name: "search", query: decodeURIComponent(parts[1] || ""), params };
    if (parts[0] === "movie") {
      let key = decodeURIComponent(parts[1] || "");
      if (/^\d+$/.test(key)) key = `tmdb-${key}`;   // старые ссылки с числовым id
      return { name: "movie", key, params };
    }
    if (parts[0] === "my") return { name: "my", params };
    return { name: "home", params };
  }

  async function route() {
    const root = $("#content");
    const r = parseHash();
    if (backCb) { backButton(false, backCb); backCb = null; }
    hideMainButton();
    setActiveNav(r.name === "home" ? "home" : r.name === "my" ? "my" : "");
    try {
      if (r.name === "search") await viewSearch(root, r.query, r.params);
      else if (r.name === "movie") await viewMovie(root, r.key);
      else if (r.name === "my") await viewMy(root, r.params);
      else await viewHome(root);
    } catch (e) {
      root.innerHTML = `<p class="error">Ошибка: ${esc(e.message)}</p>`;
    }
    if (r.name !== "home") {
      backCb = () => { location.hash = "#/"; };
      backButton(true, backCb);
    }
    if (r.name === "search") $("#search-input").value = r.query;
  }

  function setActiveNav(name) {
    document.querySelectorAll(".nav a").forEach((a) =>
      a.classList.toggle("active", a.dataset.nav === name));
  }

  async function refreshMine() {
    try {
      const rows = await Store.mine();
      myListRows = rows;
      myRatings = new Map(rows.map((r) => [r.movie_id, r]));
    } catch { myRatings = new Map(); }
  }

  // ================= Инициализация =================
  function init() {
    const isTg = initTelegram();

    $("#search-form").onsubmit = (e) => {
      e.preventDefault();
      const q = $("#search-input").value.trim();
      if (q) location.hash = `#/search/${encodeURIComponent(q)}`;
    };

    const badge = $("#mode-badge");
    const me = Store.identity();
    badge.textContent = Store.inTelegram()
      ? `👤 ${me.displayName}`
      : Store.mode() === "cloud"
        ? (me.displayName ? `☁️ ${me.displayName}` : "☁️ облако")
        : "💾 локально";
    badge.title = Store.inTelegram()
      ? "Личность из Telegram, оценки в облаке Supabase"
      : Store.mode() === "cloud"
        ? "Оценки в облаке Supabase, синхронизируются между устройствами"
        : "Оценки только в этом браузере";

    window.addEventListener("hashchange", route);
    refreshMine().then(route);
  }

  function toast(msg, isError = false) {
    const t = document.createElement("div");
    t.className = "toast" + (isError ? " error" : "");
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }

  return { init };
})();

document.addEventListener("DOMContentLoaded", App.init);
