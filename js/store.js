// ============================================================
//  Хранилище оценок: Supabase (общее) или localStorage (локальное)
//  Единый интерфейс: load / save / remove / list
// ============================================================
const Store = (() => {
  const cfg = () => window.APP_CONFIG || {};
  const LS_KEY = "movie-ratings-data";
  const PROFILE_KEY = "movie-ratings-profile";

  const supabaseConfigured = () => {
    const c = cfg();
    return !!(c.SUPABASE_URL && c.SUPABASE_ANON_KEY);
  };

  // ---- Профиль (ник пользователя, чтобы различать оценки) ----
  function getProfile() {
    try {
      return JSON.parse(localStorage.getItem(PROFILE_KEY)) || null;
    } catch {
      return null;
    }
  }
  function setProfile(name) {
    const p = { name: name.trim(), created_at: new Date().toISOString() };
    localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
    return p;
  }

  // ================= localStorage backend =================
  function lsRead() {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY)) || [];
    } catch {
      return [];
    }
  }
  function lsWrite(rows) {
    localStorage.setItem(LS_KEY, JSON.stringify(rows));
  }

  // ================= Supabase backend (REST) =================
  async function sb(path, method = "GET", body = null, headers = {}) {
    const c = cfg();
    const res = await fetch(`${c.SUPABASE_URL}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: c.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${c.SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Supabase ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.status === 204 ? null : res.json();
  }

  // ================= Публичный API =================
  const mode = () => (supabaseConfigured() ? "cloud" : "local");

  // Все оценки (опционально — одного профиля)
  async function list(profileName = null) {
    if (mode() === "cloud") {
      let q = "ratings?select=*&order=updated_at.desc&limit=1000";
      if (profileName) q += `&user_name=eq.${encodeURIComponent(profileName)}`;
      return await sb(q);
    }
    const rows = lsRead();
    return profileName
      ? rows.filter((r) => r.user_name === profileName)
      : rows.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
  }

  // Сохранить/обновить оценку (upsert по movie_id + user_name)
  async function save(entry) {
    const profile = getProfile();
    const row = {
      movie_id: entry.movie_id,
      movie_title: entry.movie_title,
      movie_year: entry.movie_year || null,
      movie_poster: entry.movie_poster || null,
      rating: entry.rating,
      review: entry.review || "",
      user_name: profile ? profile.name : "аноним",
      updated_at: new Date().toISOString(),
    };
    if (mode() === "cloud") {
      const existing = await sb(
        `ratings?select=id&movie_id=eq.${row.movie_id}&user_name=eq.${encodeURIComponent(row.user_name)}`
      );
      if (existing && existing.length) {
        await sb(`ratings?id=eq.${existing[0].id}`, "PATCH", row);
      } else {
        await sb("ratings", "POST", row);
      }
    } else {
      const rows = lsRead();
      const i = rows.findIndex(
        (r) => r.movie_id === row.movie_id && r.user_name === row.user_name
      );
      if (i >= 0) rows[i] = { ...rows[i], ...row };
      else rows.push(row);
      lsWrite(rows);
    }
    return row;
  }

  // Удалить оценку
  async function remove(movieId) {
    const profile = getProfile();
    const name = profile ? profile.name : "аноним";
    if (mode() === "cloud") {
      await sb(
        `ratings?movie_id=eq.${movieId}&user_name=eq.${encodeURIComponent(name)}`,
        "DELETE"
      );
    } else {
      lsWrite(lsRead().filter((r) => !(r.movie_id === movieId && r.user_name === name)));
    }
  }

  return { mode, list, save, remove, getProfile, setProfile };
})();
