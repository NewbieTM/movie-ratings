// ============================================================
//  Главный модуль приложения: роутинг, рендер, звёзды оценок
// ============================================================
const App = (() => {
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  // Кэш оценок текущего профиля: movie_id -> row
  let myRatings = new Map();

  // ---------- Звёздный виджет ----------
  function starsHTML(rating, movieId, interactive = true) {
    let html = `<div class="stars" data-movie="${movieId}">`;
    for (let i = 1; i <= 10; i++) {
      const on = i <= rating ? "on" : "";
      html += `<span class="star ${on}" data-value="${i}" ${
        interactive ? 'role="button" tabindex="0"' : ""
      }>★</span>`;
    }
    html += `</div>`;
    return html;
  }

  // ---------- Карточка фильма ----------
  function cardHTML(m) {
    const poster = TMDB.poster(m.poster_path, "w342");
    const year = (m.release_date || "").slice(0, 4) || "—";
    const my = myRatings.get(m.id);
    const rating = my ? my.rating : 0;
    return `
      <div class="card" data-id="${m.id}">
        <a class="poster" href="#/movie/${m.id}">
          ${
            poster
              ? `<img loading="lazy" src="${poster}" alt="${esc(m.title)}">`
              : `<div class="poster-fallback">🎬</div>`
          }
        </a>
        <div class="card-body">
          <a class="card-title" href="#/movie/${m.id}">${esc(m.title)}</a>
          <div class="card-year">${year}</div>
          ${starsHTML(rating, m.id)}
        </div>
      </div>`;
  }

  function gridHTML(movies) {
    if (!movies.length)
      return `<p class="empty">Ничего не найдено. Попробуйте другое название.</p>`;
    return `<div class="grid">${movies.map(cardHTML).join("")}</div>`;
  }

  // ---------- Страницы ----------
  async function renderHome() {
    const root = $("#content");
    if (!TMDB.isConfigured()) {
      root.innerHTML = `
        <div class="notice">
          <h2>🎬 Добро пожаловать в КиноОценку!</h2>
          <p>Чтобы искать фильмы и видеть постеры, нужен бесплатный ключ TMDB.</p>
          <p>Откройте файл <code>js/config.js</code> и вставьте ключ —
          инструкция в <code>README.md</code>. Пока ключа нет, можно добавлять
          фильмы вручную через «Мой список».</p>
        </div>`;
      return;
    }
    root.innerHTML = `<p class="loading">Загрузка новинок…</p>`;
    try {
      const [now, pop] = await Promise.all([TMDB.nowPlaying(), TMDB.popular()]);
      root.innerHTML = `
        <h2>Сейчас в кино</h2>
        ${gridHTML(now.results || [])}
        <h2>Популярные</h2>
        ${gridHTML(pop.results || [])}`;
    } catch (e) {
      root.innerHTML = `<p class="error">Ошибка загрузки: ${esc(e.message)}</p>`;
    }
  }

  async function renderSearch(query) {
    const root = $("#content");
    if (!query) {
      root.innerHTML = `<p class="empty">Введите название фильма в строку поиска.</p>`;
      return;
    }
    if (!TMDB.isConfigured()) {
      root.innerHTML = `<p class="empty">Поиск доступен после настройки ключа TMDB (см. README.md).</p>`;
      return;
    }
    root.innerHTML = `<p class="loading">Ищем «${esc(query)}»…</p>`;
    try {
      const data = await TMDB.search(query);
      root.innerHTML = `<h2>Результаты: «${esc(query)}»</h2>${gridHTML(data.results || [])}`;
    } catch (e) {
      root.innerHTML = `<p class="error">Ошибка поиска: ${esc(e.message)}</p>`;
    }
  }

  async function renderMovie(id) {
    const root = $("#content");
    root.innerHTML = `<p class="loading">Загружаем фильм…</p>`;
    try {
      const m = await TMDB.details(id);
      const poster = TMDB.poster(m.poster_path, "w500");
      const year = (m.release_date || "").slice(0, 4) || "—";
      const genres = (m.genres || []).map((g) => g.name).join(", ");
      const director = ((m.credits?.crew || []).find((c) => c.job === "Director") || {}).name || "";
      const cast = (m.credits?.cast || []).slice(0, 6).map((c) => c.name).join(", ");
      const my = myRatings.get(m.id);
      const rating = my ? my.rating : 0;
      const review = my ? my.review : "";

      root.innerHTML = `
        <div class="movie-page">
          <div class="movie-poster">
            ${poster ? `<img src="${poster}" alt="${esc(m.title)}">` : `<div class="poster-fallback big">🎬</div>`}
          </div>
          <div class="movie-info">
            <h1>${esc(m.title)} <span class="year">(${year})</span></h1>
            ${m.tagline ? `<p class="tagline">${esc(m.tagline)}</p>` : ""}
            <div class="meta">
              ${genres ? `<span>🎭 ${esc(genres)}</span>` : ""}
              ${m.runtime ? `<span>⏱ ${m.runtime} мин</span>` : ""}
              ${director ? `<span>🎬 Режиссёр: ${esc(director)}</span>` : ""}
            </div>
            ${cast ? `<p class="cast">В ролях: ${esc(cast)}</p>` : ""}
            <p class="overview">${esc(m.overview || "Описание отсутствует.")}</p>
            <div class="rate-box">
              <h3>Ваша оценка</h3>
              ${starsHTML(rating, m.id)}
              <textarea id="review" placeholder="Отзыв (необязательно)">${esc(review)}</textarea>
              <div class="rate-actions">
                <button id="save-rating" class="btn primary">Сохранить</button>
                ${my ? '<button id="delete-rating" class="btn danger">Удалить оценку</button>' : ""}
              </div>
            </div>
          </div>
        </div>`;

      $("#save-rating").onclick = async () => {
        const starsEl = root.querySelector(".stars");
        const val = parseInt(starsEl.dataset.current || rating, 10);
        if (!val) return alert("Сначала выберите оценку (звёзды).");
        await Store.save({
          movie_id: m.id,
          movie_title: m.title,
          movie_year: year,
          movie_poster: m.poster_path,
          rating: val,
          review: $("#review").value,
        });
        await refreshMyRatings();
        alert("Оценка сохранена!");
        renderMovie(id);
      };
      const del = $("#delete-rating");
      if (del)
        del.onclick = async () => {
          await Store.remove(m.id);
          await refreshMyRatings();
          renderMovie(id);
        };
    } catch (e) {
      root.innerHTML = `<p class="error">Ошибка: ${esc(e.message)}</p>`;
    }
  }

  async function renderMyList() {
    const root = $("#content");
    root.innerHTML = `<p class="loading">Загружаем ваш список…</p>`;
    try {
      const rows = await Store.list();
      if (!rows.length) {
        root.innerHTML = `
          <h2>Мой список</h2>
          <p class="empty">Пока пусто. Найдите фильм через поиск и поставьте оценку — он появится здесь.</p>`;
        return;
      }
      const avg = (rows.reduce((s, r) => s + r.rating, 0) / rows.length).toFixed(1);
      root.innerHTML = `
        <h2>Мой список <span class="count">(${rows.length}, средняя ${avg})</span></h2>
        <div class="grid">
          ${rows
            .map((r) => `
              <div class="card" data-id="${r.movie_id}">
                <a class="poster" href="#/movie/${r.movie_id}">
                  ${
                    r.movie_poster
                      ? `<img loading="lazy" src="${TMDB.poster(r.movie_poster, "w342")}" alt="${esc(r.movie_title)}">`
                      : `<div class="poster-fallback">🎬</div>`
                  }
                </a>
                <div class="card-body">
                  <a class="card-title" href="#/movie/${r.movie_id}">${esc(r.movie_title)}</a>
                  <div class="card-year">${esc(r.movie_year || "—")}</div>
                  ${starsHTML(r.rating, r.movie_id, false)}
                  ${r.review ? `<p class="mini-review">${esc(r.review)}</p>` : ""}
                </div>
              </div>`)
            .join("")}
        </div>`;
    } catch (e) {
      root.innerHTML = `<p class="error">Ошибка: ${esc(e.message)}</p>`;
    }
  }

  // ---------- Рейтинг при клике на звёзды в карточках ----------
  async function refreshMyRatings() {
    try {
      const rows = await Store.list();
      myRatings = new Map(rows.map((r) => [r.movie_id, r]));
    } catch {
      myRatings = new Map();
    }
  }

  // ---------- Роутер ----------
  async function route() {
    const hash = location.hash || "#/";
    const searchInput = $("#search-input");
    if (hash.startsWith("#/movie/")) {
      renderMovie(parseInt(hash.split("/")[2], 10));
    } else if (hash.startsWith("#/search/")) {
      const q = decodeURIComponent(hash.slice(9));
      searchInput.value = q;
      renderSearch(q);
    } else if (hash === "#/my") {
      setActiveNav("my");
      renderMyList();
    } else {
      setActiveNav("home");
      renderHome();
    }
  }

  function setActiveNav(name) {
    document.querySelectorAll(".nav a").forEach((a) =>
      a.classList.toggle("active", a.dataset.nav === name)
    );
  }

  // ---------- Инициализация ----------
  function init() {
    // Поиск
    const form = $("#search-form");
    form.onsubmit = (e) => {
      e.preventDefault();
      const q = $("#search-input").value.trim();
      if (q) location.hash = `#/search/${encodeURIComponent(q)}`;
    };

    // Клики по звёздам (делегирование)
    document.addEventListener("click", async (e) => {
      const star = e.target.closest(".star");
      if (!star) return;
      const wrap = star.closest(".stars");
      const movieId = parseInt(wrap.dataset.movie, 10);
      const val = parseInt(star.dataset.value, 10);
      wrap.dataset.current = val;
      wrap.querySelectorAll(".star").forEach((s) =>
        s.classList.toggle("on", parseInt(s.dataset.value, 10) <= val)
      );
      // Быстрое сохранение прямо из карточки (если профиль задан)
      if (!wrap.closest(".rate-box")) {
        const card = wrap.closest(".card");
        const title = card?.querySelector(".card-title")?.textContent || "";
        const year = card?.querySelector(".card-year")?.textContent || "";
        const img = card?.querySelector(".poster img");
        const posterPath = img
          ? img.src.split("/t/p/")[1]?.replace(/^w\d+/, "") || null
          : null;
        try {
          await Store.save({
            movie_id: movieId,
            movie_title: title,
            movie_year: year,
            movie_poster: posterPath,
            rating: val,
            review: "",
          });
          await refreshMyRatings();
          toast(`Оценка ${val}/10 сохранена`);
        } catch (err) {
          toast("Ошибка сохранения: " + err.message, true);
        }
      }
    });

    // Профиль: просим ник при первом сохранении в облако
    if (Store.mode() === "cloud" && !Store.getProfile()) {
      const name = prompt(
        "Как вас подписывать под оценками? (можно изменить позже в консоли: Store.setProfile('имя'))"
      );
      if (name) Store.setProfile(name);
    }

    // Индикатор режима хранения
    const badge = $("#mode-badge");
    if (badge) {
      badge.textContent = Store.mode() === "cloud" ? "☁️ облако" : "💾 локально";
      badge.title =
        Store.mode() === "cloud"
          ? "Оценки хранятся в Supabase"
          : "Оценки хранятся в этом браузере (настройте Supabase для общего доступа)";
    }

    window.addEventListener("hashchange", route);
    refreshMyRatings().then(route);
  }

  function toast(msg, isError = false) {
    const t = document.createElement("div");
    t.className = "toast" + (isError ? " error" : "");
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2500);
  }

  return { init };
})();

document.addEventListener("DOMContentLoaded", App.init);
