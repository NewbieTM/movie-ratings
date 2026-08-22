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
  const LS_WANT = "movie-ratings-want";
  const WEBKEY_KEY = "movie-ratings-webkey";

  /** Случайный ключ этого браузера (веб-режим): единственный доступ к своим строкам */
  function webKey() {
    let k = null;
    try { k = localStorage.getItem(WEBKEY_KEY); } catch {}
    if (!k) {
      k = (crypto.randomUUID ? crypto.randomUUID()
                             : "wk-" + Date.now() + "-" + Math.random().toString(36).slice(2));
      try { localStorage.setItem(WEBKEY_KEY, k); } catch {}
    }
    return k;
  }

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
    // веб-версия: вход по Telegram Id (тот же аккаунт!) или @username
    const p = legacyProfile();
    if (!p || !p.kind) return { userId: null, displayName: null };
    return {
      userId: p.kind === "tg" ? `tg-${p.value}` : `tgu-${p.value}`,
      displayName: p.kind === "tg" ? `TG ${p.value}` : `@${p.value}`,
    };
  }

  /** "123456789" -> tg-аккаунт; "@name"/"name" -> username-аккаунт; иначе null */
  function parseTid(input) {
    const v = String(input || "").trim();
    if (/^\d{2,15}$/.test(v)) return { kind: "tg", value: v };
    const m = v.match(/^@?([A-Za-z][A-Za-z0-9_]{3,31})$/);
    if (m) return { kind: "tgu", value: m[1].toLowerCase() };
    return null;
  }

  // ---------- Локальный профиль (веб-версия) ----------
  function legacyProfile() {
    try { return JSON.parse(localStorage.getItem(PROFILE_KEY)) || null; }
    catch { return null; }
  }
  function setProfile(raw) {
    const t = parseTid(raw);
    if (!t) return null;
    localStorage.setItem(PROFILE_KEY, JSON.stringify({
      ...t, created_at: new Date().toISOString(),
    }));
    return t;
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
        // RLS: Telegram initData (проверяется подписью на сервере) или веб-ключ
        ...(inTelegram() && tg() && tg().initData
              ? { "x-tg-init": tg().initData }
              : { "x-web-key": webKey() }),
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

  // Старые оценки v1 хранили числовой TMDB-id; приводим к формату источника
  const normKey = (k) => (/^\d+$/.test(String(k)) ? `tmdb-${k}` : String(k));
  const normRow = (r) => ({ ...r, movie_id: normKey(r.movie_id) });
  // Варианты ключа в БД: "tmdb-123" может лежать и как старый "123"
  function dbKeyVariants(key) {
    const k = String(key);
    const m = k.match(/^tmdb-(\d+)$/);
    return m ? [k, m[1]] : [k];
  }

  /** Мои оценки (по userId либо по нику веб-версии) */
  async function mine() {
    const me = identity();
    if (mode() === "cloud") {
      let filter;
      if (me.userId) filter = `user_id.eq.${me.userId}`;
      else if (me.displayName)
        filter = `and(user_id.is.null,user_name.eq.${encodeURIComponent(me.displayName)})`;
      else return [];
      const rows = await sb(`ratings?select=*&order=updated_at.desc&limit=1000&and=(${filter})`);
      return (rows || []).map(normRow);
    }
    const wk = webKey();
    return lsRead()
      .filter((r) =>
        (me.userId && r.user_id === me.userId) ||
        (!r.user_id && r.web_key && r.web_key === wk))
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
      .map(normRow);
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
      movie_id: normKey(entry.movie_id),      // строка вида "kp-301" / "tmdb-693134"
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
    // веб-режим: помечаем строку ключом браузера (RLS пускает только с ним)
    if (!inTelegram()) row.web_key = webKey();

    if (mode() === "cloud") {
      // ищем существующую оценку по всем вариантам id (новый и старый числовой)
      const variants = dbKeyVariants(row.movie_id)
        .map((v) => `movie_id.eq.${encodeURIComponent(v)}`).join(",");
      const owner = me.userId
        ? `user_id.eq.${encodeURIComponent(me.userId)}`
        : `and(user_id.is.null,user_name.eq.${encodeURIComponent(userName)})`;
      const existing = await sb(`ratings?select=id&and=(${owner},or(${variants}))`);
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

  /** Удалить мою оценку фильма (с учётом старого числового id в БД) */
  async function remove(movieId) {
    const me = identity();
    const variants = dbKeyVariants(movieId);
    if (mode() === "cloud") {
      const owner = me.userId
        ? `user_id.eq.${encodeURIComponent(me.userId)}`
        : `and(user_id.is.null,user_name.eq.${encodeURIComponent(me.displayName || "аноним")})`;
      for (const v of variants) {
        const del = await sb(
          `ratings?and=(${owner},movie_id.eq.${encodeURIComponent(v)})`,
          "DELETE",
          null
        ).catch(() => null);
        if (del && del.length) return; // удалили — дальше не ищем
      }
    } else {
      const dn = me.displayName || "аноним";
      lsWrite(lsRead().filter((r) =>
        !(variants.includes(String(r.movie_id)) &&
          (me.userId ? r.user_id === me.userId : r.user_name === dn))));
    }
  }

  // ================= Хочу посмотреть (watchlist) =================
  async function wantAll() {
    const me = identity();
    if (mode() === "cloud") {
      let filter;
      if (me.userId) filter = `user_id.eq.${me.userId}`;
      else if (me.displayName)
        filter = `and(user_id.is.null,user_name.eq.${encodeURIComponent(me.displayName)})`;
      else return [];
      const rows = await sb(`watchlist?select=*&order=added_at.desc&limit=1000&and=(${filter})`);
      return (rows || []).map(normRow);
    }
    try {
      const wk = webKey();
      return JSON.parse(localStorage.getItem(LS_WANT) || "[]")
        .filter((r) =>
          (me.userId && r.user_id === me.userId) ||
          (!r.user_id && r.web_key && r.web_key === wk))
        .map(normRow);
    } catch { return []; }
  }

  async function wantAdd(meta) {
    const me = identity();
    const row = {
      movie_id: String(meta.movieId),
      movie_title: meta.title,
      movie_year: meta.year != null ? String(meta.year) : null,
      movie_poster: meta.poster || null,
      tag: meta.tag || null,
      user_id: me.userId || null,
      user_name: me.userId ? null : (me.displayName || "аноним"),
      web_key: me.userId && me.userId.startsWith("tg-") ? null : webKey(),
    };
    if (mode() === "cloud") {
      const r = await sb("watchlist", "POST", row);
      return normRow(Array.isArray(r) ? r[0] : r);
    }
    const rows = JSON.parse(localStorage.getItem(LS_WANT) || "[]");
    rows.unshift({ ...row, added_at: new Date().toISOString() });
    localStorage.setItem(LS_WANT, JSON.stringify(rows));
    return normRow(rows[0]);
  }

  async function wantRemove(movieId) {
    const me = identity();
    const variants = dbKeyVariants(movieId);
    if (mode() === "cloud") {
      const owner = me.userId
        ? `user_id.eq.${encodeURIComponent(me.userId)}`
        : `and(user_id.is.null,user_name.eq.${encodeURIComponent(me.displayName || "аноним")})`;
      for (const v of variants) {
        const del = await sb(
          `watchlist?and=(${owner},movie_id.eq.${encodeURIComponent(v)})`,
          "DELETE",
          null
        ).catch(() => null);
        if (del && del.length) return;
      }
      return;
    }
    const dn = me.displayName || "аноним";
    localStorage.setItem(LS_WANT, JSON.stringify(
      JSON.parse(localStorage.getItem(LS_WANT) || "[]").filter((r) =>
        !(variants.includes(String(r.movie_id)) &&
          (me.userId ? r.user_id === me.userId : r.user_name === dn)))));
  }

  /** Тихо поправить тег у моей оценки (данные стали точнее) */
  async function retag(movieId, tag) {
    if (!tag) return;
    const me = identity();
    const variants = dbKeyVariants(movieId);
    if (mode() === "cloud") {
      const owner = me.userId
        ? `user_id.eq.${encodeURIComponent(me.userId)}`
        : `and(user_id.is.null,user_name.eq.${encodeURIComponent(me.displayName || "аноним")})`;
      for (const v of variants) {
        const upd = await sb(
          `ratings?and=(${owner},movie_id.eq.${encodeURIComponent(v)})`,
          "PATCH",
          { tag }
        ).catch(() => null);
        if (upd && upd.length) return;
      }
    } else {
      const dn = me.displayName || "аноним";
      const rows = lsRead();
      for (const r of rows)
        if (variants.includes(String(r.movie_id)) &&
            (me.userId ? r.user_id === me.userId : r.user_name === dn)) { r.tag = tag; }
      lsWrite(rows);
    }
  }

  return { mode, mine, save, remove, retag, wantAll, wantAdd, wantRemove,
           identity, setProfile, claimLegacy, inTelegram };
})();
