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
  let myLiveApply = null;
  const VIEW_KEY = "mr-view-mode";
  const getViewMode = () => { try { return localStorage.getItem(VIEW_KEY) === "compact" ? "compact" : "cards"; } catch { return "cards"; } };
  const setViewMode = (v) => { try { localStorage.setItem(VIEW_KEY, v); } catch {} };

  let wantRows = [];              // «Хочу посмотреть»
  let myWantSet = new Set();
  const syncWantSet = () =>
    { myWantSet = new Set(wantRows.map((r) => r.movie_id)); };         // живая фильтрация «Моего списка» без перерисовки страницы
  let navSeq = 0;                 // защита от гонок навигации
  let navStack = [];              // история для кнопки «Назад» в Telegram
  let poppingBack = false;
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
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

  let lastMainBtnCb = null;
  function hideMainButton() {
    try {
      const mb = TG()?.MainButton;
      if (mb && lastMainBtnCb && typeof mb.offClick === "function") { mb.offClick(lastMainBtnCb); lastMainBtnCb = null; }
      mb?.hide();
    } catch {}
  }

  // ================= Звёзды с шагом 0.5 =================
  function starsWidget(initial, onChange) {
    let value = initial || 0;
    const el = document.createElement("div");
    el.className = "stars interactive";
    for (let i = 1; i <= 10; i++) {
      const st = document.createElement("span");
      st.className = "star";
      st.dataset.i = i;
      st.innerHTML = `<span class="fill">★</span>`;
      el.appendChild(st);
    }
    const bubble = document.createElement("div");
    bubble.className = "rate-bubble";
    bubble.textContent = String(value || 0);
    el.appendChild(bubble);

    function render() {
      el.querySelectorAll(".star").forEach((st) => {
        const i = +st.dataset.i;
        const w = value >= i ? 100 : value === i - 0.5 ? 50 : 0;
        st.querySelector(".fill").style.width = w + "%";
        st.classList.toggle("half", w === 50);
      });
    }

    let dragging = false;
    function posToValue(clientX) {
      const r = el.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      return Math.round(Math.max(0.02, ratio) * 20) / 2;   // шаг 0.5
    }
    function setVal(v) {
      v = Math.min(10, Math.max(0.5, v));
      if (v !== value) { value = v; render(); haptic(); onChange && onChange(value); }
      bubble.textContent = String(value);
    }
    el.addEventListener("pointerdown", (e) => {
      dragging = true;
      try { el.setPointerCapture(e.pointerId); } catch {}
      el.classList.add("dragging");
      bubble.style.opacity = 1;
      setVal(posToValue(e.clientX));
      e.preventDefault();
    });
    el.addEventListener("pointermove", (e) => { if (dragging) setVal(posToValue(e.clientX)); });
    const end = () => { if (!dragging) return; dragging = false; el.classList.remove("dragging"); bubble.style.opacity = 0; };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);

    el.setValue = (v) => { value = Number(v) || 0; render(); };
    el.getValue = () => value;
    render();
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
          ${m.poster ? `<img loading="lazy" decoding="async" src="${m.poster}" alt="${esc(m.title)}">`
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
    p.delete("page");              // иначе старая страница «прилипает» к ссылке
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
  async function viewHome(root, seq) {
    root.innerHTML = `<p class="loading">Загрузка…</p>`;
    const d = await Movies.home();
    if (seq !== navSeq) return;
    const srcLabel = Movies.activeName() === "tmdb"
      ? "источник: TMDB" : "источник: Кинопоиск (фолбек)";
    root.innerHTML = `
      <p class="src-note">${srcLabel}</p>
      ${d.fresh.length ? `<h2>Новинки</h2>${gridHTML(d.fresh)}` : ""}
      ${d.popular.length ? `<h2>Популярное</h2>${gridHTML(d.popular)}` : ""}
      ${d.top.length ? `<h2>Высокие рейтинги</h2>${gridHTML(d.top)}` : ""}`;
  }

  async function viewSearch(root, query, params, seq) {
    const page = Math.max(1, parseInt(params.page || "1", 10) || 1);
    root.innerHTML =
      `<h2>Поиск: «${esc(query)}»</h2>${filterBarHTML(params)}<div id="results"><p class="loading">Ищем…</p></div>`;
    // мгновенные фильтры: любое изменение сразу перезапрашивает выдачу
    const applyFilters = () =>
      { location.hash = searchHash(query, readFilters($("#filters"))); };
    $("#filters").querySelectorAll("select").forEach((el) =>
      el.addEventListener("change", applyFilters));
    $("#filters").querySelectorAll("input").forEach((el) =>
      el.addEventListener("input", debounce(applyFilters, 450)));
    $("#filters").addEventListener("submit", (e) => { e.preventDefault(); applyFilters(); });
    const resEl = $("#results");
    try {
      const d = await Movies.search({ query, page, ...params });
      if (seq !== navSeq) return;
      resEl.innerHTML =
        gridHTML(d.items) +
        paginationHTML(d.total, d.page, d.pages, (p) => searchHash(query, params, p));
      window.scrollTo(0, 0);
    } catch (e) {
      resEl.innerHTML = `<p class="error">Поиск недоступен: ${esc(e.message)}</p>`;
    }
  }

  function kpUrl(m) {
    const id = m.kpId || (m.source === "kp" ? m.id : null);
    if (id) {
      const seg = (m.kpType || m.media) === "movie" ? "film" : "series";
      return `https://www.kinopoisk.ru/${seg}/${id}/`;
    }
    return `https://www.kinopoisk.ru/index.php?kp_query=${encodeURIComponent(m.title || m.origTitle || "")}`;
  }

  async function viewMovie(root, key, seq) {
    root.innerHTML = `<p class="loading">Загружаем…</p>`;
    let m, ex = null;
    try {
      // детали и обогащение рейтингами летят параллельно — страница открывается быстрее
      [m, ex] = await Promise.all([
        Movies.details(key),
        /^tmdb/.test(key) ? Movies.kpRatings(key).catch(() => null) : Promise.resolve(null),
      ]);
    } catch (e) {
      root.innerHTML = `<p class="error">Не удалось загрузить: ${esc(e.message)}</p>`;
      return;
    }
    if (seq !== navSeq) return;
    keyCache.set(key, m);

    if (ex) {
      m.ratingKp = m.ratingKp ?? ex.ratingKp;
      m.ratingImdb = m.ratingImdb ?? ex.ratingImdb;
      if (ex.kpId) { m.kpId = ex.kpId; m.kpType = ex.kpType; }
    }

    const my = myRatings.get(key);

    // самолечение: если тип фильма теперь определяется точнее — обновляем метку
    if (my) {
      const betterTag = pickTag(m.tags);
      if (betterTag && my.tag !== betterTag) {
        my.tag = betterTag;
        Store.retag(key, betterTag).catch(() => {});
      }
    }

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
          <button id="share-btn" class="btn ghost">⤴ Поделиться</button>
          ${!my ? `<button id="want-btn" class="btn ghost ${myWantSet.has(key) ? "active" : ""}">
            ${myWantSet.has(key) ? "✓ В «Хочу посмотреть»" : "＋ Хочу посмотреть"}</button>` : ""}
          <div class="rate-box">
            <h3>${my ? `Ваша оценка: <span class="accent">${fmtR(my.rating)}</span> из 10` : "Поставьте оценку"}</h3>
            <div id="rate-stars"></div>
            <textarea id="review" placeholder="Отзыв (необязательно)…">${esc(my?.review || "")}</textarea>
            <div class="rate-actions">
              <button id="save-rating" class="btn primary">Сохранить</button>
              ${my ? `<button id="delete-rating" class="btn danger">Удалить</button>` : ""}
            </div>
          </div>
          <a class="kp-link" target="_blank" rel="noopener" href="${kpUrl(m)}">
             Найти на Кинопоиске ↗</a>
        </div>
      </div>`;

    const shareBtn = $("#share-btn");
    if (shareBtn) {
      shareBtn.onclick = async () => {
        const url = location.href;
        try {
          if (navigator.share) {
            await navigator.share({ title: "КиноОценка", text: `${m.title} (${m.year || ""})`, url });
          } else if (navigator.clipboard) {
            await navigator.clipboard.writeText(url);
            toast("Ссылка скопирована");
          }
          haptic();
        } catch { /* пользователь отменил */ }
      };
    }

    const wantBtn = $("#want-btn");
    if (wantBtn) {
      wantBtn.onclick = async () => {
        const had = myWantSet.has(key);
        wantBtn.disabled = true;
        try {
          if (had) {
            await Store.wantRemove(key);
            wantRows = wantRows.filter((r) => r.movie_id !== key);
          } else {
            const row = await Store.wantAdd({
              movieId: key, title: m.title, year: m.year,
              poster: m.poster, tag: pickTag(m.tags) || null,
            });
            wantRows = [row, ...wantRows];
          }
          syncWantSet();
          wantBtn.classList.toggle("active", !had);
          wantBtn.textContent = !had ? "✓ В «Хочу посмотреть»" : "＋ Хочу посмотреть";
          haptic();
        } catch (e) { toast("Не получилось: " + e.message, true); }
        wantBtn.disabled = false;
      };
    }

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
          tag: pickTag(m.tags),
          rating: val,
          review: $("#review").value,
        });
        await refreshMine();
        // оценил — значит посмотрел: тихо убираем из «Хочу посмотреть»
        if (myWantSet.has(m.key)) {
          Store.wantRemove(m.key)
            .then(() => { wantRows = wantRows.filter((r) => r.movie_id !== m.key); syncWantSet(); })
            .catch(() => {});
        }
        haptic("impact");
        toast("Сохранено ✓");
        hideMainButton();
        route();
      } catch (e) { toast(e.message, true); }
    }
    async function doDelete() {
      try {
        await Store.remove(m.key);
        await refreshMine();
        toast("Оценка удалена");
        route();
      } catch (e) { toast(e.message, true); }
    }

    $("#save-rating").onclick = doSave;
    const del = $("#delete-rating");
    if (del) del.onclick = doDelete;

    const t = TG();
    if (t && t.MainButton) {
      if (lastMainBtnCb && typeof t.MainButton.offClick === "function") t.MainButton.offClick(lastMainBtnCb);
      lastMainBtnCb = null;
      t.MainButton.setText("Сохранить оценку");
      t.MainButton.onClick(doSave);
      lastMainBtnCb = doSave;
      t.MainButton.show();
    }
  }

  async function viewMy(root, params) {
    if (!myListRows.length) myListRows = await Store.mine().catch(() => []);

    const usedTags = [...new Set(myListRows.map((r) => r.tag).filter(Boolean))];

    root.innerHTML = `
      <h2 id="mysum"></h2>
      <form id="myfilters" class="filters wrap">
        <select name="tag">
          <option value="">Все типы</option>
          ${usedTags.map((t) => `<option ${params.tag === t ? "selected" : ""}>${esc(t)}</option>`).join("")}
        </select>
        <label class="range">оценка от
          <input name="from" type="number" min="0" max="10" step="0.5" value="${params.from || "0"}"></label>
        <label class="range">до
          <input name="to" type="number" min="0" max="10" step="0.5" value="${params.to || "10"}"></label>
        <select name="sort">
          <option value="date">По дате</option>
          <option value="rating">По оценке</option>
          <option value="title">По названию</option>
        </select>
        <button type="button" id="view-toggle" class="view-toggle">${getViewMode() === "cards" ? "☰ Компактно" : "▦ Карточки"}</button>
      </form>
      <div id="myresults"></div>`;
    bindViewToggle(() => refresh(false));
    const sortSel = $("#myfilters").querySelector("select[name=sort]");
    if (params.sort) sortSel.value = params.sort;
    if (params.q) $("#search-input").value = params.q;

    // Читаем фильтры прямо из контролов и обновляем ТОЛЬКО сетку и счётчик.
    // Никакой навигации — фокус в поле остаётся, клавиатура не прячется.
    function computeRows() {
      const f = $("#myfilters");
      const q = ($("#search-input").value || "").trim().toLowerCase();
      const fromV = parseFloat(f.querySelector("input[name=from]").value) || 0;
      const toRaw = parseFloat(f.querySelector("input[name=to]").value);
      const toV = isNaN(toRaw) ? 10 : Math.min(10, Math.max(0, toRaw));
      const tag = f.querySelector("select[name=tag]").value;
      const sort = f.querySelector("select[name=sort]").value;
      const fromV2 = Math.max(0, fromV);
      const rows = myListRows.filter((r) =>
        (!q || r.movie_title.toLowerCase().includes(q)) &&
        (Number(r.rating) >= fromV2 && Number(r.rating) <= toV) &&
        (!tag || r.tag === tag));
      if (sort === "rating") rows.sort((a, b) => b.rating - a.rating);
      else if (sort === "title") rows.sort((a, b) => a.movie_title.localeCompare(b.movie_title, "ru"));
      else rows.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
      return { rows, q, fromV: fromV2, toV, tag, sort };
    }

    function refresh(syncUrl) {
      const { rows, q, fromV, toV, tag, sort } = computeRows();
      const avg = rows.length
        ? (rows.reduce((sm, r) => sm + Number(r.rating), 0) / rows.length).toFixed(1) : "—";
      $("#mysum").innerHTML =
        `Мой список <span class="count">${rows.length}${rows.length !== myListRows.length ? ` из ${myListRows.length}` : ""} · средняя ${avg}</span>`;
      $("#myresults").innerHTML = renderMyGrid(rows);
      if (syncUrl) {
        const p = new URLSearchParams();
        if (q) p.set("q", q);
        if (tag) p.set("tag", tag);
        if (fromV > 0) p.set("from", String(fromV));
        if (toV < 10) p.set("to", String(toV));
        if (sort !== "date") p.set("sort", sort);
        const qs = p.toString();
        try { history.replaceState(null, "", "#/my" + (qs ? "?" + qs : "")); } catch {}
      }
    }

    const applyLive = debounce(() => refresh(true), 200);
    myLiveApply = () => refresh(true);

    $("#myfilters").querySelectorAll("select").forEach((el) =>
      el.addEventListener("change", () => refresh(true)));
    $("#myfilters").querySelectorAll("input").forEach((el) =>
      el.addEventListener("input", applyLive));

    refresh(false);
  }

  function wantGridHTML(rows = wantRows) {
    if (!wantRows.length)
      return `<p class="empty">Пока пусто. Откройте любой фильм и нажмите «Хочу посмотреть».</p>`;
    if (!rows.length)
      return `<p class="empty">Под фильтры ничего не подошло.</p>`;
    if (getViewMode() === "compact") {
      return groupedMiniHTML(rows, (r) => miniRowHTML({
        href: `#/movie/${encodeURIComponent(r.movie_id)}`,
        poster: r.movie_poster,
        title: esc(r.movie_title),
        sub: `${esc(r.movie_year || "—")}`,
        right: "",
        extra: `<button class="want-x" data-x="${esc(r.movie_id)}" title="Убрать из списка">✕</button>`,
      }));
    }
    return `<div class="grid">${rows.map((r) => `
        <div class="card want-card">
          <a class="poster" href="#/movie/${encodeURIComponent(r.movie_id)}">
            ${r.movie_poster ? `<img loading="lazy" decoding="async" src="${TMDB_IMG_W342(r.movie_poster)}" alt="${esc(r.movie_title)}">`
                             : `<div class="poster-fallback">🎬</div>`}
          </a>
          <div class="card-body">
            <a class="card-title" href="#/movie/${encodeURIComponent(r.movie_id)}">${esc(r.movie_title)}</a>
            <div class="card-meta">${esc(r.movie_year || "—")}${r.tag ? ` <span class="chip">${esc(r.tag)}</span>` : ""}</div>
          </div>
          <button class="want-x" data-x="${esc(r.movie_id)}" title="Убрать из списка">✕</button>
        </div>`).join("")}</div>`;
  }

  /** Кнопка переключения вида карточки/компактно (перерисовывает текущий список) */
  function bindViewToggle(rerender) {
    const b = $("#view-toggle");
    if (!b) return;
    b.onclick = () => {
      setViewMode(getViewMode() === "cards" ? "compact" : "cards");
      b.textContent = getViewMode() === "cards" ? "☰ Компактно" : "▦ Карточки";
      haptic();
      rerender();
    };
  }

  let wantLiveApply = null;       // живой поиск по «Хочу посмотреть»

  /** Отфильтрованные строки по выбранному типу */
  const wantFiltered = () => {
    const t = ($("#want-tag") || {}).value || "";
    return t ? wantRows.filter((r) => r.tag === t) : wantRows;
  };

  async function viewWant(root, params = {}) {
    try { wantRows = await Store.wantAll(); } catch { wantRows = []; }
    syncWantSet();
    const usedTags = [...new Set(wantRows.map((r) => r.tag).filter(Boolean))];

    function renderWant(syncUrl) {
      const t = ($("#want-tag") || {}).value || "";
      const qq = ($("#search-input").value || "").trim().toLowerCase();
      const rows = wantRows.filter((r) =>
        (!t || r.tag === t) && (!qq || r.movie_title.toLowerCase().includes(qq)));
      $("#want-count").textContent = String(rows.length);
      $("#wantgrid").innerHTML = wantGridHTML(rows);
      if (syncUrl) {
        const p = new URLSearchParams();
        if (t) p.set("tag", t);
        if (qq) p.set("q", qq);
        const qs = p.toString();
        try { history.replaceState(null, "", "#/want" + (qs ? "?" + qs : "")); } catch {}
      }
    }
    wantLiveApply = () => renderWant(true);

    root.innerHTML = `
      <h2>Хочу посмотреть <span class="count" id="want-count">${wantRows.length}</span></h2>
      <div class="filters wrap">
        <select id="want-tag">
          <option value="">Все типы</option>
          ${usedTags.map((t) => `<option ${params.tag === t ? "selected" : ""}>${esc(t)}</option>`).join("")}
        </select>
        <button type="button" id="view-toggle" class="view-toggle">${getViewMode() === "cards" ? "☰ Компактно" : "▦ Карточки"}</button>
      </div>
      <div id="wantgrid"></div>`;

    if (params.q) $("#search-input").value = params.q;
    renderWant(false);

    $("#want-tag").addEventListener("change", () => renderWant(true));
    bindViewToggle(() => renderWant(false));

    $("#wantgrid").addEventListener("click", async (e) => {
      const x = e.target.closest("[data-x]");
      if (!x) return;
      e.preventDefault();
      const key = x.dataset.x;
      x.disabled = true;
      try {
        await Store.wantRemove(key);
        wantRows = wantRows.filter((r) => r.movie_id !== key);
        syncWantSet();
        renderWant(true);
        haptic();
      } catch (err) { toast("Не получилось убрать: " + err.message, true); x.disabled = false; }
    });
  }

  const TMDB_IMG_W342 = (p) =>
    p.startsWith("http") ? p : `https://image.tmdb.org/t/p/w342${p}`;
  const TMDB_IMG_W185 = (p) =>
    p.startsWith("http") ? p : `https://image.tmdb.org/t/p/w185${p}`;

  function renderMyGrid(rows) {
    if (!myListRows.length)
      return `<p class="empty">Пока пусто. Найдите фильм через поиск и поставьте оценку.</p>`;
    if (!rows.length)
      return `<p class="empty">Под фильтры ничего не подошло.</p>`;
    if (getViewMode() === "compact") {
      return groupedMiniHTML(rows, (r) => miniRowHTML({
        href: `#/movie/${encodeURIComponent(r.movie_id)}`,
        poster: r.movie_poster,
        title: esc(r.movie_title),
        sub: `${esc(r.movie_year || "—")}`,
        right: `<b>${fmtR(r.rating)}</b>/10`,
      }));
    }
    return `<div class="grid">${rows.map((r) => `
        <div class="card">
          <a class="poster" href="#/movie/${r.movie_id}">
            ${r.movie_poster ? `<img loading="lazy" decoding="async" src="${TMDB_IMG_W185(r.movie_poster)}" alt="">`
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

  /** Компактный список: горизонтальные мини-строки */
  function miniRowHTML({ href, poster, title, sub, right, extra = "" }) {
    return `
      <a class="mini-row" href="${href}">
        ${poster ? `<img loading="lazy" decoding="async" src="${TMDB_IMG_W185(poster)}" alt="">`
                 : `<span class="mi-fallback">🎬</span>`}
        <span class="mi-body">
          <span class="mi-title">${title}</span>
          <span class="mi-sub">${sub}</span>
        </span>
        <span class="mi-right">${right}</span>${extra}
      </a>`;
  }
  function minilistHTML(rows, mkRow) {
    return `<div class="minilist">${rows.map(mkRow).join("")}</div>`;
  }
  /** Компактный вид с группами по типу: линия-разделитель с названием категории,
      сортировка внутри группы сохраняется */
  const TAG_ORDER = ["Фильм", "Сериал", "Мультфильм", "Мультсериал", "Аниме", "ТВ-шоу"];
  const TAG_PLURAL = { "Фильм": "Фильмы", "Сериал": "Сериалы", "Мультфильм": "Мультфильмы",
                       "Мультсериал": "Мультсериалы", "Аниме": "Аниме", "ТВ-шоу": "ТВ-шоу" };
  function groupedMiniHTML(rows, mkRow) {
    const groups = new Map();
    for (const r of rows) {
      const k = r.tag || "Прочее";
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    const keys = [...groups.keys()].sort((a, b) =>
      ((TAG_ORDER.indexOf(a) < 0 ? 99 : TAG_ORDER.indexOf(a)) -
       (TAG_ORDER.indexOf(b) < 0 ? 99 : TAG_ORDER.indexOf(b))) || a.localeCompare(b, "ru"));
    return keys.map((k) => `
      <section class="mini-group">
        <div class="mini-groupline"><span>${esc(TAG_PLURAL[k] || k)}</span></div>
        ${minilistHTML(groups.get(k), mkRow)}
      </section>`).join("");
  }

  // ================= Личность на веб-версии =================
  async function ensureIdentity() {
    const me = Store.identity();
    if (me.userId) return me;
    let t = null;
    let tries = 0;
    while (!t) {
      if (++tries > 5) throw new Error("Не удалось распознать Id");
      const raw = prompt(
        "Чтобы сохранять оценки и списки, укажите ваш Telegram Id или @username.\n\n" +
        "Численный Id — лучший вариант (не меняется никогда): напишите что угодно боту @userinfobot, он пришлет ваш Id.\n\n" +
        "Либо введите @username (учтите: если смените его в Telegram, доступ по нему пропадет).",
        "");
      if (!raw) throw new Error("Нужен Telegram Id или @username");
      t = Store.setProfile(raw);
      if (!t) alert("Не похоже на Id (только цифры) или @username. Попробуйте еще раз.");
    }
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
    if (parts[0] === "want") return { name: "want", params };
    return { name: "home", params };
  }

  async function route() {
    const seq = ++navSeq;
    const root = $("#content");
    const r = parseHash();

    myLiveApply = null;
    wantLiveApply = null;

    // ведём историю для системной кнопки «Назад» в Telegram
    const h = location.hash || "#/";
    if (poppingBack) poppingBack = false;
    else if (navStack[navStack.length - 1] !== h) navStack.push(h);
    if (backCb) { backButton(false, backCb); backCb = null; }
    hideMainButton();
    setActiveNav(["home", "my", "want"].includes(r.name) ? r.name : "");
    try {
      if (r.name === "search") await viewSearch(root, r.query, r.params, seq);
      else if (r.name === "movie") await viewMovie(root, r.key, seq);
      else if (r.name === "my") await viewMy(root, r.params, seq);
      else if (r.name === "want") await viewWant(root, r.params);
      else await viewHome(root, seq);
    } catch (e) {
      root.innerHTML = `<p class="error">Ошибка: ${esc(e.message)}</p>`;
    }
    if (r.name !== "home") {
      backCb = () => {
        if (navStack.length > 1) {
          navStack.pop();
          poppingBack = true;
          location.hash = navStack[navStack.length - 1] || "#/";
        } else { try { TG()?.close(); } catch {} }
      };
      backButton(true, backCb);
    }
    const si = $("#search-input");
    if (r.name === "search") { si.value = r.query; si.placeholder = "Фильм или сериал, на любом языке…"; }
    else if (r.name === "my") { si.value = r.params.q || ""; si.placeholder = "Найти фильм из вашего списка…"; }
    else if (r.name === "want") { si.value = r.params.q || ""; si.placeholder = "Найти из «Хочу посмотреть»…"; }
    else { si.value = ""; si.placeholder = "Фильм или сериал, на любом языке…"; }
  }

  const TAG_PRIORITY = ["Аниме", "Мультсериал", "Мультфильм", "ТВ-шоу", "Сериал", "Фильм"];
  const cleanTag = (t) => String(t || "").replace("?", "");
  // для сохранения выбираем самый конкретный тип, иначе мультики пишутся как «Сериал»
  function pickTag(tags) {
    const n = (tags || []).map(cleanTag);
    for (const pr of TAG_PRIORITY) if (n.includes(pr)) return pr;
    return n[0] || null;
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
    initTelegram();

    const myQs = (q) => {
      const cur = parseHash();
      const p = new URLSearchParams(cur.params || {});
      if (q) p.set("q", q); else p.delete("q");
      p.delete("page");
      const str = p.toString();
      return "#/my" + (str ? "?" + str : "");
    };
    $("#search-form").onsubmit = (e) => {
      e.preventDefault();
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      const q = $("#search-input").value.trim();
      if (parseHash().name === "my") {
        if (myLiveApply) myLiveApply();
        else location.hash = "#/my" + myQs(q);
      } else if (parseHash().name === "want") {
        if (wantLiveApply) wantLiveApply();           // живой поиск по watchlist
        else location.hash = `#/want?q=${encodeURIComponent(q)}`;
      } else if (q) location.hash = `#/search/${encodeURIComponent(q)}`;
    };
    // мгновенный фильтр по названию на странице «Мой список» — тоже без перезагрузки
    $("#search-input").addEventListener("input", debounce(() => {
      const n = parseHash().name;
      if (n === "my" && myLiveApply) myLiveApply();
      if (n === "want" && wantLiveApply) wantLiveApply();
    }, 250));


    window.addEventListener("hashchange", route);
    refreshMine().then(route);

    // Тап вне строки поиска — снимаем с неё фокус (клавиатура прячется).
    // Фаза захвата: работает до прочих обработчиков и не зависит от них.
    document.addEventListener("pointerdown", (e) => {
      const si = $("#search-input");
      const form = $("#search-form");
      if (!si || !form) return;
      if (document.activeElement === si && !form.contains(e.target)) {
        try { si.blur(); } catch {}
      }
    }, true);
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
