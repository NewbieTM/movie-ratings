// ============================================================
//  Хранилище оценок: Supabase (облако) с fallback в localStorage.
//  Личность пользователя:
//   - внутри Telegram Mini App — Telegram id (без ников)
//   - на обычном сайте — локальный профиль (ник), как раньше
//  Старые оценки по нику автоматически склеиваются с Telegram-профилем.
// ============================================================
const Store = (() => {
  const cfg = () => window.APP_CONFIG || {};
  const LS_KEY = "movie-ratings-data";
  const PROFILE_KEY = "movie-ratings-profile";
  const CLAIMED_KEY = "movie-ratings-claimed";

  const supabaseConfigured = () => {
    const c = cfg();
    return !!(c.SUPABASE_URL && c.SUPABASE_ANON_KEY);
  };

  // ---------- Telegram ----------
  function tg() { return window.Telegram && window.Telegram.WebApp; }
  const inTelegram = () => !!(tg() && tg().initDataUnsafe && tg().initDataUnsafe.user);

  // ---------- Личность: {userId: "tg-123"|null, displayName} ----------
  function identity() {
    if (inTelegram()) {
      const u = tg().initDataUnsafe.user;
      const nm = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || "Без имени";
      return { userId: `tg-${u.id}`, displayName: nm };
    }
    const p = legacyProfile();
    return { userId: null, displayName: p ? p.name : null };
  }

  // ---------- Локальный профиль (веб-версия) ----------
  function legacyProfile() {
    try { return JSON.parse(localStorage.getItem(PROFILE_KEY)) || null; }
    catch { return null; }
  }
  function setProfile(name) {
    localStorage.setItem(PROFILE_KEY, JSON.stringify({
      name: String(name).trim().slice(0, 40),
      created_at: new Date().toISOString(),
    }));
  }

  // ================= localStorage backend =================
  function lsRead() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; }
    catch { return []; }
  }
  function lsWrite(rows) { localStorage.setItem(LS_KEY, JSON.stringify(rows)); }

  // ================= Supabase backend =================
  async function sb(path, method = "GET", body = null) {
    const c = cfg();
    const res = await fetch(`${c.SUPABASE_URL}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: c.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${c.SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`База данных ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.status === 204 ? null : res.json();
  }

  const mode = () => (supabaseConfigured() ? "cloud" : "local");

  /** Мои оценки (по userId либо по нику веб-версии) */
  async function mine() {
    const me = identity();
    if (mode() === "cloud") {
      let filter;
      if (me.userId) filter = `user_id.eq.${me.userId}`;
      else if (me.displayName)
        filter = `and(user_id.is.null,user_name.eq.${encodeURIComponent(me.displayName)})`;
      else return [];
      return await sb(`ratings?select=*&order=updated_at.desc&limit=1000&and=(${filter})`);
    }
    return lsRead()
      .filter((r) => (me.userId ? r.user_id === me.userId : true))
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  }

  /**
   * Склейка старых оценок (ник из этого браузера) с Telegram-профилем.
   * Один раз при первом входе через Telegram.
   */
  async function claimLegacy() {
    if (!inTelegram() || mode() !== "cloud") return 0;
    if (localStorage.getItem(CLAIMED_KEY)) return 0;
    const p = legacyProfile();
    if (!p || !p.name) { localStorage.setItem(CLAIMED_KEY, "1"); return 0; }
    const me = identity();
    const rows = await sb(`ratings?select=id&user_id=is.null&user_name=eq.${encodeURIComponent(p.name)}`);
    let n = 0;
    for (const r of rows || []) {
      await sb(`ratings?id=eq.${r.id}`, "PATCH", { user_id: me.userId });
      n++;
    }
    localStorage.setItem(CLAIMED_KEY, "1");
    return n;
  }

  /** Сохранить/обновить оценку фильма */
  async function save(entry) {
    const me = identity();
    const userName = me.displayName || "аноним";
    const rating = Number(entry.rating);
    if (!(Number.isFinite(rating) && rating >= 0.5 && rating <= 10))
      throw new Error("Оценка должна быть от 0.5 до 10");
    const row = {
      movie_id: entry.movie_id,               // строка вида "kp-301"
      movie_title: entry.movie_title,
      movie_year: entry.movie_year != null ? String(entry.movie_year) : null,
      movie_poster: entry.movie_poster ?? null,
      tag: entry.tag ?? null,
      rating,
      review: entry.review || "",
      user_name: userName,
      updated_at: new Date().toISOString(),
    };
    if (me.userId) row.user_id = me.userId;

    if (mode() === "cloud") {
      const findQ = me.userId
        ? `ratings?select=id&movie_id=eq.${encodeURIComponent(row.movie_id)}&user_id=eq.${encodeURIComponent(me.userId)}`
        : `ratings?select=id&movie_id=eq.${encodeURIComponent(row.movie_id)}&user_id=is.null&user_name=eq.${encodeURIComponent(userName)}`;
      const existing = await sb(findQ);
      if (existing && existing.length) {
        await sb(`ratings?id=eq.${existing[0].id}`, "PATCH", row);
      } else {
        await sb("ratings", "POST", row);
      }
    } else {
      const rows = lsRead();
      const i = rows.findIndex((r) =>
        r.movie_id === row.movie_id &&
        (me.userId ? r.user_id === me.userId : r.user_name === userName));
      if (i >= 0) rows[i] = { ...rows[i], ...row };
      else rows.push(row);
      lsWrite(rows);
    }
    return row;
  }

  /** Удалить мою оценку фильма */
  async function remove(movieId) {
    const me = identity();
    if (mode() === "cloud") {
      const q = me.userId
        ? `ratings?movie_id=eq.${encodeURIComponent(movieId)}&user_id=eq.${encodeURIComponent(me.userId)}`
        : `ratings?movie_id=eq.${encodeURIComponent(movieId)}&user_id=is.null&user_name=eq.${encodeURIComponent(me.displayName || "аноним")}`;
      await sb(q, "DELETE");
    } else {
      const dn = me.displayName || "аноним";
      lsWrite(lsRead().filter((r) =>
        !(r.movie_id === movieId && (me.userId ? r.user_id === me.userId : r.user_name === dn))));
    }
  }

  return { mode, mine, save, remove, identity, setProfile, claimLegacy, inTelegram };
})();
