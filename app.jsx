/* ClubMajors v4 — self-serve signup + Stripe checkout */
const { useState, useEffect, useRef } = React;

/* src/supa.js — Supabase client + data helpers.
   Members are anonymous (no login) and act through security-definer RPCs.
   Only the club pro and the owner sign in.
   No-build version: expects window.supabase (UMD) + SUPABASE_URL/KEY globals. */

const SUPA_URL = window.SUPABASE_URL;
const SUPA_KEY = window.SUPABASE_KEY;

/* "Remember me": when off, the auth session lives in sessionStorage and ends when the browser closes */
const authStore = () => { try { return localStorage.getItem("cm-remember") === "0" ? window.sessionStorage : window.localStorage; } catch (e) { return window.localStorage; } };
const sb = window.supabase.createClient(SUPA_URL, SUPA_KEY, { auth: { storage: {
  getItem: (k) => authStore().getItem(k),
  setItem: (k, v) => authStore().setItem(k, v),
  removeItem: (k) => { try { window.sessionStorage.removeItem(k); } catch (e) {} try { window.localStorage.removeItem(k); } catch (e) {} },
} } });

/* Demo mode: /?demo=masters — fictional club + entries, real 2026 Masters final scores, no DB */
const DEMO = new URLSearchParams(window.location.search).get("demo") === "masters";
const INVITE = new URLSearchParams(window.location.search).get("invite");
const REF = new URLSearchParams(window.location.search).get("ref");
if (REF) { try { localStorage.setItem("cm-ref", REF.trim().toLowerCase()); } catch (e) {} }

/* ----- admin (pro/owner) auth ----- */
function signInWithEmail(email) {
  return sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin },
  });
}
function signInWithPassword(email, password) {
  return sb.auth.signInWithPassword({ email, password });
}
function sendPasswordReset(email) {
  return sb.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
}
function signOut() {
  return sb.auth.signOut();
}

/* ----- edit-code storage (per pool, on this device) ----- */
function tokenKey(poolId) {
  return "cm_entry_" + poolId;
}
function saveEditCode(poolId, entryId, token) {
  try { localStorage.setItem(tokenKey(poolId), JSON.stringify({ entryId, token })); } catch (e) {}
}
function loadEditCode(poolId) {
  try { return JSON.parse(localStorage.getItem(tokenKey(poolId)) || "null"); } catch (e) { return null; }
}
function clearEditCode(poolId) {
  try { localStorage.removeItem(tokenKey(poolId)); } catch (e) {}
}

function isTbEl(x) {
  return typeof x === "string" && x.slice(0, 3) === "tb:";
}
function mapEntry(row) {
  const raw = row.picks || [];
  const tbEl = raw.find(isTbEl);
  const teamEl = raw.find(isTeamEl);
  const tbsEl = raw.find(isTbsEl);
  return {
    id: row.id,
    entry: row.entry_name,
    member: row.member_name,
    picks: raw.filter((x) => !isTbEl(x) && !isTeamEl(x) && !isTbsEl(x)),
    tb: tbEl && !isNaN(Number(tbEl.slice(3))) ? Number(tbEl.slice(3)) : null,
    team: teamEl ? teamEl.slice(5) : null,
    tbs: tbsEl ? tbsEl.slice(4) : null,
  };
}

/* ----- club signup (self-serve pro onboarding) ----- */
async function requestSignup(email, clubName, referredBy) {
  const row = { email, club_name: clubName };
  if (referredBy && referredBy.trim()) row.referred_by = referredBy.trim();
  let { error: reqErr } = await sb.from("signup_requests").insert(row);
  if (reqErr && row.referred_by) {
    /* referred_by column may not exist yet — don't lose the signup over it */
    ({ error: reqErr } = await sb.from("signup_requests").insert({ email, club_name: clubName }));
  }
  if (reqErr) throw reqErr;
  const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } });
  if (error) throw error;
}

/* ----- public bootstrap (works for anonymous members) -----
   Priority: signed-in pro/owner's own club → ?club=slug in URL → demo club */
async function fetchApp() {
  if (DEMO) return { club: DEMO_CLUB, pool: DEMO_POOL, entries: DEMO_ENTRIES.map(mapEntry), profile: null };
  const { data: userData } = await sb.auth.getUser();
  const user = userData && userData.user;
  let profile = null;
  if (user) {
    const prRes = await sb.from("profiles").select("*").eq("id", user.id).single();
    profile = prRes.data;
  }

  const params = new URLSearchParams(window.location.search);
  const slugParam = params.get("club");

  let club = null;
  if (profile && profile.club_id) {
    club = (await sb.from("clubs").select("*").eq("id", profile.club_id).single()).data;
  } else if (slugParam) {
    club = (await sb.from("clubs").select("*").eq("slug", slugParam).eq("status", "active").single()).data;
  }
  /* No slug and no profile → this visitor is a prospective BUYER, not a member:
     they get the platform landing page, not some arbitrary club's shell.
     (The old any-first-club fallback predates multi-club.) */

  let pool = null, entries = [];
  if (club) {
    const pRes = await sb.from("pools").select("*")
      .eq("club_id", club.id).eq("published", true)
      .order("created_at", { ascending: false }).limit(1);
    pool = pRes.data && pRes.data[0];
    /* the club's own admin also gets their unpublished draft (e.g. reload
       mid-checkout) so republishing reuses it instead of inserting a twin;
       tabs stay hidden because hasPublishedPool checks pool.published */
    if (!pool && profile && (profile.role === "pro" || profile.role === "owner") && profile.club_id === club.id) {
      const dRes = await sb.from("pools").select("*")
        .eq("club_id", club.id)
        .order("created_at", { ascending: false }).limit(1);
      pool = dRes.data && dRes.data[0];
    }
    if (pool) {
      const eRes = await sb.rpc("get_entries", { p_pool_id: pool.id });
      entries = (eRes.data || []).map(mapEntry);
    }
  }
  return { club, pool, entries, profile };
}

async function refetchEntries(poolId) {
  const { data } = await sb.rpc("get_entries", { p_pool_id: poolId });
  return (data || []).map(mapEntry);
}

/* ----- anonymous member actions (via RPC) ----- */
async function submitEntry(poolId, entryName, memberName, picks) {
  const { data, error } = await sb.rpc("submit_entry", {
    p_pool_id: poolId, p_entry_name: entryName, p_member_name: memberName, p_picks: picks,
  });
  if (error) throw error;
  const row = data && data[0];
  if (row) saveEditCode(poolId, row.entry_id, row.edit_token);
  const entries = await refetchEntries(poolId);
  return { entries, entryId: row && row.entry_id, token: row && row.edit_token };
}

async function editEntry(poolId, token, entryName, memberName, picks) {
  const { error } = await sb.rpc("update_entry", {
    p_edit_token: token, p_entry_name: entryName, p_member_name: memberName, p_picks: picks,
  });
  if (error) throw error;
  return refetchEntries(poolId);
}

/* look up an entry by its edit code (for cross-device edits) */
async function lookupByCode(token) {
  const { data, error } = await sb.rpc("get_entry_by_code", { p_edit_token: token });
  if (error) throw error;
  return data && data[0];  // {entry_id, pool_id, entry_name, member_name, picks, locked} or undefined
}

/* ----- Stripe hosted checkout (Payment Links) -----
   Links are created in the Stripe dashboard and set as globals in index.html.
   We append client_reference_id (club id) + prefilled_email so payments are
   traceable back to the club. No secret keys ever touch the app. */
function stripeCheckoutUrl(plan, club, email, eventType) {
  const base =
    plan === "annual" ? window.STRIPE_LINK_ANNUAL
    : plan === "season" ? window.STRIPE_LINK_SEASON
    : eventType === "major" ? (window.STRIPE_LINK_MAJOR || window.STRIPE_LINK_SINGLE)
    : (window.STRIPE_LINK_EVENT || window.STRIPE_LINK_SINGLE);
  if (!base || base.indexOf("REPLACE") >= 0) return null; // not configured yet
  const u = new URL(base);
  if (club && club.id) u.searchParams.set("client_reference_id", club.id);
  if (email) u.searchParams.set("prefilled_email", email);
  return u.toString();
}

/* ----- admin (pro/owner) actions ----- */
async function savePool(poolId, fields) {
  const { error } = await sb.from("pools").update(fields).eq("id", poolId);
  if (error) throw error;
}
async function saveClub(clubId, fields) {
  const { error } = await sb.from("clubs").update(fields).eq("id", clubId);
  if (error) throw error;
}

/* ----- owner dashboard ----- */
async function fetchOwnerData() {
  const clubs = (await sb.from("clubs").select("*").order("created_at")).data || [];
  const pools = (await sb.from("pools").select("*").order("created_at")).data || [];
  const entries = (await sb.from("entries").select("id,pool_id,created_at")).data || [];
  const members = (await sb.from("profiles").select("id,email,role,club_id")).data || [];
  let payments = [];
  try {
    payments = (await sb.from("payments").select("*").order("created_at", { ascending: false })).data || [];
  } catch (e) {}
  let signups = [];
  try {
    signups = (await sb.from("signup_requests").select("*").order("created_at", { ascending: false })).data || [];
  } catch (e) {}
  return { clubs, pools, entries, members, payments, signups };
}
async function addClub(name, slug) {
  const { error } = await sb.from("clubs").insert({ name, slug });
  if (error) throw error;
}
async function setClubStatus(clubId, status) {
  const { error } = await sb.from("clubs").update({ status }).eq("id", clubId);
  if (error) throw error;
}
async function setMemberRole(userId, role, clubId) {
  const patch = { role };
  if (clubId !== undefined) patch.club_id = clubId;
  const { error } = await sb.from("profiles").update(patch).eq("id", userId);
  if (error) throw error;
}

/* src/useLiveScores.js
   Polls the Netlify function for live SlashGolf scoring and maps players
   onto the app's internal ids by name. If the function is unreachable
   (local `vite` dev, missing key) or the tournament hasn't produced
   scores yet, it falls back to the original simulated Sunday feed so the
   demo always has a working leaderboard.

   Returns: { scores, lastMover, source, lastUpdated }
     scores    — { [appPlayerId]: { total, today, thru, mc } }
     lastMover — app id of the player whose score last changed (or null)
     source    — "live" | "sim" | "loading"
*/


const POLL_MS = 90_000; // leaderboard poll interval
const SIM_MS = 3_500; // simulated feed tick

/* Simulated Sunday-afternoon fallback — deterministic per player id so the
   demo board is stable across reloads and works for any tier field. */
function genSimScores(playerIndex) {
  const out = {};
  Object.keys(playerIndex).forEach((id) => {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 9973;
    const mc = h % 11 === 3; /* ~9% miss the cut */
    const total = (h % 17) - 8; /* -8 .. +8 */
    if (mc) out[id] = { total: total + 8, mc: true };
    else out[id] = { total, today: (h % 5) - 2, thru: 9 + (h % 10) };
  });
  return out;
}

/* "Ludvig Åberg" -> "ludvig aberg" — for matching API names to app ids */
function normName(s) {
  return String(s)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ø/gi, "o")
    .toLowerCase()
    .replace(/\(a\)/g, "")
    .replace(/[^a-z\s]/g, "")
    .trim();
}

function buildNameMap(playerIndex) {
  const map = new Map();
  Object.entries(playerIndex).forEach(([appId, p]) => {
    map.set(normName(p.name), appId);
    // also index by last name alone as a fallback
    const parts = normName(p.name).split(/\s+/);
    const last = parts[parts.length - 1];
    if (!map.has(last)) map.set(last, appId);
  });
  return map;
}

/* Convert the function's normalized players into app-shaped scores */
function mapLiveScores(players, nameMap) {
  const out = {};
  players.forEach((p) => {
    const full = normName(`${p.firstName} ${p.lastName}`);
    const appId = nameMap.get(full) || nameMap.get(normName(p.lastName));
    if (!appId) return;
    if (p.cut) {
      out[appId] = { total: p.total === null || p.total === undefined ? null : p.total, mc: true, rounds: p.rounds || null };
    } else if (p.total !== null) {
      out[appId] = {
        total: p.total,
        today: p.today ?? 0,
        thru: p.thru ?? 0,
        rounds: p.rounds || null,
      };
    }
  });
  return out;
}

/* Free public fallback: ESPN's golf scoreboard (no API key). Normalized to the
   same shape the Netlify leaderboard function returns. Tolerant of missing
   fields — pre-tournament it simply yields too few players and is skipped. */
async function fetchEspnScores() {
  const url =
    "https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard" +
    (EVENT.espnDates ? "?dates=" + EVENT.espnDates : "");
  const res = await fetch(url);
  if (!res.ok) throw new Error("espn http " + res.status);
  const data = await res.json();
  const events = data.events || [];
  const want = normName(EVENT.shortName);
  const ev =
    events.find((e) => normName(e.name || e.shortName || "") === want) ||
    events.find((e) => normName(e.name || e.shortName || "").indexOf(want) >= 0) ||
    events[0];
  const comp = ev && ev.competitions && ev.competitions[0];
  const list = (comp && comp.competitors) || [];
  const toPar = (s) => {
    if (s == null) return null;
    const t = String(s).trim().toUpperCase();
    if (t === "E") return 0;
    const n = Number(t.replace("+", ""));
    return isNaN(n) ? null : n;
  };
  const maxRounds = list.reduce((m, c) => Math.max(m, (c.linescores || []).length), 0);
  return list
    .map((c) => {
      const a = c.athlete || {};
      const name = a.displayName || a.fullName || "";
      const rounds = c.linescores || [];
      const last = rounds[rounds.length - 1] || {};
      const statusBlob = JSON.stringify(c.status || {});
      const cut = /"CUT"|"WD"|"DQ"|CUT/i.test(statusBlob) || (maxRounds >= 3 && rounds.length <= 2);
      /* between rounds ESPN reports thru 0 — treat a completed round as F */
      const thru =
        c.status && typeof c.status.thru === "number" && c.status.thru > 0
          ? c.status.thru
          : last.value != null
          ? 18
          : 0;
      const parts = name.trim().split(/\s+/);
      const roundStrokes = rounds
        .map((r) => (r && r.value != null ? Number(r.value) : null))
        .filter((x) => x != null && x > 50 && x < 110);
      return {
        firstName: parts.slice(0, -1).join(" "),
        lastName: parts[parts.length - 1] || "",
        total: toPar(c.score),
        today: toPar(last.displayValue),
        thru,
        cut,
        rounds: roundStrokes.length ? roundStrokes : null,
      };
    })
    .filter((x) => x.lastName && x.total !== null);
}

/* Optional third feed for validation. Configure in index.html:
     window.VALIDATION_FEED = { name: "R&A", url: "https://.../scores.json" }
   The endpoint must return { players: [{ firstName, lastName, total, thru, cut }] }
   (same shape as the Netlify leaderboard function). */
async function fetchCustomScores() {
  const cfg = window.VALIDATION_FEED;
  if (!cfg || !cfg.url) throw new Error("no custom validation feed configured");
  const res = await fetch(cfg.url);
  if (!res.ok) throw new Error("custom feed http " + res.status);
  const d = await res.json();
  return { name: cfg.name || "Custom", players: d.players || [] };
}

function useLiveScores(enabled, playerIndex) {
  const [scores, setScores] = useState(() => (DEMO ? DEMO_SCORES : genSimScores(playerIndex)));
  const [lastMover, setLastMover] = useState(null);
  const [source, setSource] = useState("loading");
  const [lastUpdated, setLastUpdated] = useState(null);
  const [staleAt, setStaleAt] = useState(null); // set when the feed is serving cached scores
  const [feedPar, setFeedPar] = useState(null); // vendor-reported course par (null when absent/ambiguous)
  const nameMapRef = useRef(null);
  const sourceRef = useRef("loading");
  const prevLiveRef = useRef(null);

  const indexRef = useRef(null);
  if (!nameMapRef.current || indexRef.current !== playerIndex) {
    indexRef.current = playerIndex;
    nameMapRef.current = buildNameMap(playerIndex);
  }

  /* ---- live polling ---- */
  useEffect(() => {
    if (DEMO) { setSource("demo"); sourceRef.current = "demo"; setFeedPar(72); setLastUpdated(DEMO_UPDATED); return; }
    if (!enabled) return;
    let cancelled = false;

    // Need real scores for at least half the field to trust a feed
    // (pre-tournament the endpoints return an empty/partial board).
    const enough = (mapped) => Object.keys(mapped).length >= Object.keys(playerIndex).length / 2;

    function applyLive(mapped, src, updatedAt) {
      // flag the last mover by diffing against the previous live snapshot
      let mover = null;
      const prev = prevLiveRef.current;
      if (prev) {
        for (const id of Object.keys(mapped)) {
          if (prev[id] && !mapped[id].mc && prev[id].total !== mapped[id].total) {
            mover = id;
            break;
          }
        }
      }
      prevLiveRef.current = mapped;
      sourceRef.current = src;
      setSource(src);
      setScores(mapped);
      setLastMover(mover);
      setLastUpdated(updatedAt || new Date().toISOString());
    }

    async function poll() {
      /* 1 · primary: SlashGolf via the Netlify function */
      try {
        const res = await fetch("/.netlify/functions/leaderboard");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        const mapped = mapLiveScores(data.players || [], nameMapRef.current);
        if (enough(mapped)) {
          setStaleAt(data.stale ? data.lastUpdated : null);
          setFeedPar(typeof data.coursePar === "number" ? data.coursePar : null);
          applyLive(mapped, "live", data.lastUpdated);
          return;
        }
        throw new Error("no live scores yet");
      } catch (e) {}
      /* 2 · automatic fallback: ESPN public scoreboard (real data, no key) */
      try {
        const players = await fetchEspnScores();
        if (cancelled) return;
        const mapped = mapLiveScores(players, nameMapRef.current);
        if (enough(mapped)) { applyLive(mapped, "espn"); return; }
        throw new Error("no espn scores yet");
      } catch (e) {}
      /* 3 · simulated demo feed — only when no real data exists anywhere */
      if (!cancelled && sourceRef.current !== "live" && sourceRef.current !== "espn") {
        sourceRef.current = "sim";
        setSource("sim");
      }
    }

    poll();
    const t = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [enabled, playerIndex]);

  /* ---- simulated fallback feed (original demo behavior) ---- */
  useEffect(() => {
    if (!enabled || source !== "sim") return;
    const t = setInterval(() => {
      setScores((prev) => {
        const activeIds = Object.keys(prev).filter(
          (id) => !prev[id].mc && prev[id].thru < 18
        );
        if (activeIds.length === 0) return prev;
        const id = activeIds[Math.floor(Math.random() * activeIds.length)];
        const roll = Math.random();
        const delta = roll < 0.28 ? -1 : roll < 0.82 ? 0 : 1;
        const s = prev[id];
        setLastMover(delta !== 0 ? id : null);
        return {
          ...prev,
          [id]: { ...s, total: s.total + delta, today: s.today + delta, thru: s.thru + 1 },
        };
      });
    }, SIM_MS);
    return () => clearInterval(t);
  }, [enabled, source]);

  return { scores, lastMover, source, lastUpdated, staleAt, feedPar };
}

/* src/OwnerDashboard.jsx — platform owner view: live ops, business metrics,
   club management, and multi-feed score validation (SlashGolf · ESPN · custom). */


const PLAN_PRICE = { annual: 330, single: 75, season: 30, season2026: 30 };

/* --- tiny chart + export primitives for the owner dashboard (no libraries) --- */
function MiniBars({ items, money }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 10, marginTop: 12 }}>
      {items.map((it) => (
        <div key={it.label} style={{ flex: 1, textAlign: "center" }}>
          <div className="mono" style={{ fontSize: 10, marginBottom: 3 }}>{money ? "$" + it.value : it.value}</div>
          <div style={{ background: "var(--brass)", height: Math.round((it.value / max) * 70) + 4, borderRadius: 2 }} />
          <div className="mono" style={{ fontSize: 9, marginTop: 4, color: "var(--muted)", textTransform: "uppercase" }}>{it.label}</div>
        </div>
      ))}
    </div>
  );
}
function HBar({ label, value, max, suffix }) {
  return (
    <div style={{ margin: "8px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingRight: 10 }}>{label}</span>
        <span className="mono">{value}{suffix || ""}</span>
      </div>
      <div style={{ background: "var(--paper-line)", height: 6, borderRadius: 3, marginTop: 3 }}>
        <div style={{ width: Math.round((value / Math.max(1, max)) * 100) + "%", background: "var(--pine)", height: 6, borderRadius: 3 }} />
      </div>
    </div>
  );
}
function csvDownload(filename, rows) {
  const csv = rows.map((r) => r.map((v) => '"' + String(v === null || v === undefined ? "" : v).replace(/"/g, '""') + '"').join(",")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function OwnerDashboard({ liveSource }) {
  const [data, setData] = useState(null);
  const [health, setHealth] = useState(null);
  const [validation, setValidation] = useState(null);
  const [scoreSource, setScoreSource] = useState(null);   // platform_config.score_provider
  const [sourceMsg, setSourceMsg] = useState("");
  const [validating, setValidating] = useState(false);
  const [newClub, setNewClub] = useState("");
  const [err, setErr] = useState(null);

  async function load() {
    try { setData(await fetchOwnerData()); } catch (e) { setErr(String(e.message || e)); }
  }
  useEffect(() => { load(); }, []);

  /* function health check */
  useEffect(() => {
    let dead = false;
    fetch("/.netlify/functions/leaderboard")
      .then((r) => r.json().then((b) => ({ ok: r.ok, status: r.status, body: b })))
      .then((res) => {
        if (dead) return;
        setHealth(
          res.ok
            ? { state: "live", detail: `${(res.body.players || []).length} players · round ${res.body.roundId || "—"}` }
            : { state: "waiting", detail: res.body.error || `HTTP ${res.status}` }
        );
      })
      .catch((e) => !dead && setHealth({ state: "down", detail: String(e.message || e) }));
    return () => { dead = true; };
  }, []);

  useEffect(() => {
    sb.from("platform_config").select("*").eq("key", "score_provider")
      .then(({ data }) => setScoreSource(data && data[0] ? data[0].value : "slashgolf"));
  }, []);

  async function switchSource(next) {
    setSourceMsg("");
    try {
      const { error } = await sb.from("platform_config").upsert({ key: "score_provider", value: next, updated_at: new Date().toISOString() });
      if (error) throw error;
      setScoreSource(next);
      setSourceMsg("Switched. Every club's feed picks this up within ~90 seconds (feed cache).");
    } catch (e) {
      setSourceMsg("Could not switch: " + ((e && e.message) || e));
    }
  }

  async function runValidation() {
    setValidating(true);
    setValidation(null);
    try {
      const feeds = [];
      /* 1 · SlashGolf via the Netlify function */
      try {
        const r = await fetch("/.netlify/functions/leaderboard");
        if (r.ok) {
          const d = await r.json();
          if (d.players && d.players.length) feeds.push({ name: "SlashGolf", players: d.players });
        }
      } catch (e) {}
      /* 2 · ESPN benched Jul 2026 — its scoreboard kept disagreeing with the
         paid feeds and flooded validation with false mismatches. The PGA Tour
         feed below is the free cross-check now. (ESPN remains available as the
         leaderboard's last-resort live fallback only.) */
      /* 3 · PGA Tour via the pga-validate Netlify function */
      try {
        const r = await fetch("/.netlify/functions/pga-validate");
        if (r.ok) {
          const d = await r.json();
          if (d.players && d.players.length) feeds.push({ name: "PGA Tour", players: d.players });
        }
      } catch (e) {}
      /* 4 · optional extra feed (window.VALIDATION_FEED) */
      try {
        const f = await fetchCustomScores();
        if (f.players.length) feeds.push(f);
      } catch (e) {}

      const srcLabel = liveSource === "live" ? "SlashGolf" : liveSource === "espn" ? "ESPN" : "simulated";
      if (feeds.length < 2) {
        setValidation({
          error:
            (feeds.length === 0
              ? "No score feeds responded."
              : "Only the " + feeds[0].name + " feed responded — at least two are needed to cross-check.") +
            " Pre-tournament most feeds return an empty board; try again once play begins. The live leaderboard is currently on the " + srcLabel + " feed.",
        });
      } else {
        const maps = feeds.map((f) => {
          const m = new Map();
          f.players.forEach((pl) => m.set(normName((pl.firstName || "") + " " + (pl.lastName || "")), pl));
          return m;
        });
        const names = new Set();
        maps.forEach((m) => m.forEach((_, k) => names.add(k)));
        const mismatches = [];
        let compared = 0;
        names.forEach((k) => {
          const present = maps
            .map((m, i) => ({ feed: feeds[i].name, pl: m.get(k) }))
            .filter((x) => x.pl);
          if (present.length < 2) return;
          compared++;
          const first = present[0].pl;
          const player = ((first.firstName || "") + " " + (first.lastName || "")).trim();
          const cuts = present.map((x) => !!x.pl.cut);
          const allCut = cuts.every(Boolean);
          const noneCut = cuts.every((c) => !c);
          /* 1 · cut status must agree before scores are even comparable */
          if (!allCut && !noneCut) {
            mismatches.push({
              player,
              detail: present.map((x, i) => x.feed + " " + (cuts[i] ? "MC" : fmtPar(x.pl.total == null ? 0 : x.pl.total))).join(" · ") + " — cut status disagrees",
            });
            return;
          }
          /* 2 · both say MC: feeds report cut players' numbers differently
             (36-hole raw vs to-par vs penalty-adjusted) — agreement on MC is
             the check, the numbers are not comparable */
          if (allCut) return;
          /* 3 · active players: compare to-par totals, ignoring raw-stroke
             style values (|x| > 30 means someone sent 72-hole strokes) */
          const vals = present.map((x) => (x.pl.total == null || Math.abs(x.pl.total) > 30 ? null : x.pl.total));
          const nums = vals.filter((v) => v !== null);
          /* vendors refresh on different cadences — a 1-2 stroke gap during live
             play is one un-refreshed hole (timing lag), not bad data. Match the
             validate-cron watchdog: only a 3+ stroke spread is a mismatch. */
          const spread = nums.length >= 2 ? Math.max.apply(null, nums) - Math.min.apply(null, nums) : 0;
          if (spread >= 3) {
            mismatches.push({
              player,
              detail: present.map((x, i) => x.feed + " " + (vals[i] == null ? "n/a" : fmtPar(vals[i]))).join(" · "),
            });
          }
        });
        mismatches.sort((a, b) => a.player.localeCompare(b.player));
        /* full per-source table: every golfer, every feed's current value */
        const tableRows = [];
        names.forEach((k) => {
          const cells = maps.map((m) => {
            const pl = m.get(k);
            if (!pl) return "—";
            if (pl.cut === true) return "MC";
            return pl.total == null ? "?" : fmtPar(pl.total);
          });
          const anyPl = maps.map((m) => m.get(k)).find(Boolean);
          const label = anyPl ? ((anyPl.firstName || "") + " " + (anyPl.lastName || "")).trim() : k;
          const disagree = new Set(cells.filter((c) => c !== "—" && c !== "?")).size > 1;
          tableRows.push({ player: label, cells, disagree });
        });
        tableRows.sort((a, b) => (a.disagree === b.disagree ? a.player.localeCompare(b.player) : a.disagree ? -1 : 1));
        setValidation({
          summary:
            "Cross-checked " + feeds.map((f) => f.name).join(" vs ") + ": " + compared + " players compared, " +
            mismatches.length + (mismatches.length === 1 ? " mismatch" : " mismatches") +
            ". Live leaderboard is currently on the " + srcLabel + " feed.",
          compared,
          mismatches,
          feedNames: feeds.map((f) => f.name),
          tableRows,
        });
      }
    } catch (e) {
      setValidation({ error: String(e.message || e) });
    }
    setValidating(false);
  }

  async function handleAddClub() {
    const name = newClub.trim();
    if (!name) return;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    try { await addClub(name, slug); setNewClub(""); load(); } catch (e) { setErr(String(e.message || e)); }
  }

  async function toggleStatus(club) {
    try { await setClubStatus(club.id, club.status === "active" ? "suspended" : "active"); load(); } catch (e) { setErr(String(e.message || e)); }
  }

  async function makePro(userId, clubId) {
    try { await setMemberRole(userId, "pro", clubId); load(); } catch (e) { setErr(String(e.message || e)); }
  }
  async function revokePro(userId) {
    try { await setMemberRole(userId, "pending", null); load(); } catch (e) { setErr(String(e.message || e)); }
  }

  if (!data) return <p className="sheet-sub">Loading platform data…</p>;

  const { clubs, pools, entries, members, payments = [], signups = [] } = data;
  const activeClubs = clubs.filter((c) => c.status === "active");
  const paidTotal = payments.reduce((s, p) => s + (Number(p.amount_cents) || 0), 0) / 100;
  const planEstimate = clubs.reduce((s, c) => s + (PLAN_PRICE[c.plan] || 0), 0);
  const annualClubs = clubs.filter((c) => c.plan === "annual" && (!c.paid_until || new Date(c.paid_until) > new Date()));
  const entriesPerPool = {};
  entries.forEach((e) => { entriesPerPool[e.pool_id] = (entriesPerPool[e.pool_id] || 0) + 1; });
  const prosOf = (clubId) => members.filter((m) => m.club_id === clubId && m.role === "pro");
  const paidBy = (clubId) => payments.filter((p) => p.club_id === clubId).reduce((s, p) => s + (Number(p.amount_cents) || 0), 0) / 100;
  const poolsOf = (clubId) => pools.filter((p) => p.club_id === clubId);
  const monthAnchors = [...Array(6)].map((_, i) => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth() - (5 - i), 1); });
  const mLabel = (d) => d.toLocaleDateString([], { month: "short" });
  const revByMonth = monthAnchors.map((d) => ({
    label: mLabel(d),
    value: Math.round(payments.filter((x) => { const t = new Date(x.created_at); return t.getFullYear() === d.getFullYear() && t.getMonth() === d.getMonth(); }).reduce((s, x) => s + (Number(x.amount_cents) || 0), 0) / 100),
  }));
  const clubsByMonth = monthAnchors.map((d) => {
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    return { label: mLabel(d), value: clubs.filter((c) => c.created_at && new Date(c.created_at) < end).length };
  });
  const topPools = pools
    .map((pl) => ({ label: (pl.event_name || "?") + " · " + ((clubs.find((c) => c.id === pl.club_id) || {}).name || "?"), value: entriesPerPool[pl.id] || 0 }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);
  const arr = annualClubs.length * ANNUAL_PRICE;
  const pendingCount = members.filter((m) => m.role === "pending").length;
  const clubsCsv = () => csvDownload("clubmajors-clubs.csv", [
    ["Club", "Plan", "Paid through", "Status", "Pros", "Pools", "Entries", "Revenue collected ($)"],
    ...clubs.map((c) => [c.name, c.plan || "single-event", c.paid_until ? new Date(c.paid_until).toISOString().slice(0, 10) : "", c.status,
      prosOf(c.id).map((m) => m.email).join("; "), poolsOf(c.id).length,
      poolsOf(c.id).reduce((s, pl) => s + (entriesPerPool[pl.id] || 0), 0), paidBy(c.id).toFixed(2)]),
  ]);
  const paymentsCsv = () => csvDownload("clubmajors-payments.csv", [
    ["Date", "Club", "Plan", "Amount ($)", "Promo code", "Customer email", "Stripe session"],
    ...payments.map((x) => [new Date(x.created_at).toISOString().slice(0, 10),
      (clubs.find((c) => c.id === x.club_id) || {}).name || "", x.plan || "", ((Number(x.amount_cents) || 0) / 100).toFixed(2),
      x.promo_code || "", x.customer_email || "", x.stripe_session_id || ""]),
  ]);

  return (
    <>
      <div className="sheet-head">
        <div className="sheet-title">Platform Dashboard</div>
        <div className="sheet-deadline mono" style={{ color: "var(--muted)" }}>Owner only</div>
      </div>
      <p className="sheet-sub">Business overview — subscriptions, revenue, engagement, and live operations.</p>
      {err && <p className="sheet-sub" style={{ color: "var(--under)" }}>{err}</p>}

      <div className="facts" style={{ border: "1px solid var(--paper-line)" }}>
        <div className="fact"><div className="fact-k">Active clubs</div><div className="fact-v mono">{activeClubs.length}</div></div>
        <div className="fact"><div className="fact-k">Annual subscribers</div><div className="fact-v mono">{annualClubs.length}</div></div>
        <div className="fact"><div className="fact-k">Annual run rate</div><div className="fact-v mono">${arr}</div></div>
        <div className="fact"><div className="fact-k">Cash collected</div><div className="fact-v mono">${paidTotal.toFixed(0)}</div></div>
        <div className="fact"><div className="fact-k">Booked (by plan)</div><div className="fact-v mono">${planEstimate}</div></div>
        <div className="fact"><div className="fact-k">Pools published</div><div className="fact-v mono">{pools.filter((p) => p.published).length}</div></div>
        <div className="fact"><div className="fact-k">Total entries</div><div className="fact-v mono">{entries.length}</div></div>
        <div className="fact"><div className="fact-k">Pending admins</div><div className="fact-v mono">{pendingCount}</div></div>
      </div>

      <div className="settings-grid" style={{ marginTop: 22 }}>
        <section className="set-block">
          <h3 className="set-title">Revenue collected · last 6 months</h3>
          <MiniBars items={revByMonth} money />
        </section>
        <section className="set-block">
          <h3 className="set-title">Clubs on platform · cumulative</h3>
          <MiniBars items={clubsByMonth} />
        </section>
        <section className="set-block">
          <h3 className="set-title">Entries by pool</h3>
          {topPools.length === 0 && <p className="sheet-sub">No pools yet.</p>}
          {topPools.map((t) => (
            <HBar key={t.label} label={t.label} value={t.value} max={topPools[0] ? topPools[0].value : 1} suffix=" entries" />
          ))}
        </section>
      </div>

      <div className="settings-grid" style={{ marginTop: 22 }}>
        <section className="set-block">
          <h3 className="set-title">Live operations</h3>
          <div className="payout-row"><span>Scoring feed (SlashGolf)</span>
            <span className="mono">{health ? `${health.state.toUpperCase()} · ${health.detail}` : "checking…"}</span>
          </div>
          {pools.map((p) => (
            <div className="payout-row" key={p.id}>
              <span>{p.event_name} · {(clubs.find((c) => c.id === p.club_id) || {}).name || "?"}</span>
              <span className="mono">{entriesPerPool[p.id] || 0} entries · locks {new Date(p.deadline).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
            </div>
          ))}
          <div className="payout-row"><span>Registered users</span><span className="mono">{members.length}</span></div>
        </section>

        <section className="set-block">
          <h3 className="set-title">Score data source</h3>
          <p className="set-sub">
            One-click platform-wide switch for every club's live scoring. Whatever you pick is tried first; if it
            errors, the feed automatically falls through the other providers within one poll cycle — no clicking
            required during an incident. DataGolf also powers the odds-tiered picksheets.
          </p>
          <div className="seg allow-wrap" role="radiogroup" aria-label="Score data source" style={{ maxWidth: 420 }}>
            {[
              { v: "datagolf", label: "DataGolf" },
              { v: "slashgolf", label: "SlashGolf" },
              { v: "espn", label: "ESPN (free)" },
            ].map((o) => (
              <button key={o.v} className={`seg-btn ${scoreSource === o.v ? "on" : ""}`} onClick={() => switchSource(o.v)} aria-pressed={scoreSource === o.v}>
                {o.label}
              </button>
            ))}
          </div>
          {sourceMsg && <p className="set-sub" style={{ marginTop: 10, color: "var(--pine)" }}>{sourceMsg}</p>}
        </section>

        <section className="set-block">
          <h3 className="set-title">Score validation</h3>
          <p className="set-sub">Cross-checks the SlashGolf feed (the one driving the leaderboard) against ESPN and the PGA Tour's published leaderboards, player by player, and flags any disagreement.</p>
          <button className="btn btn-ghost btn-small" onClick={runValidation} disabled={validating}>
            {validating ? "Comparing feeds…" : "Run validation"}
          </button>
          {validation && (
            <div style={{ marginTop: 14 }}>
              {validation.error && <p className="sheet-sub" style={{ color: "var(--under)" }}>{validation.error}</p>}
              {validation.summary && (
                <>
                  <p className="sheet-sub" style={{ marginBottom: 8 }}>{validation.summary}</p>
                  {(validation.mismatches || []).slice(0, 12).map((m, i) => (
                    <div className="payout-row" key={i}>
                      <span>{m.player}</span>
                      <span className="mono" style={{ color: "var(--under)" }}>{m.detail}</span>
                    </div>
                  ))}
                  {(validation.mismatches || []).length === 0 && validation.compared > 0 && (
                    <p className="sheet-sub" style={{ color: "var(--pine)" }}>All {validation.compared} compared players match.</p>
                  )}
                  {(validation.tableRows || []).length > 0 && (
                    <div style={{ marginTop: 16, overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
                      <div className="mono" style={{ fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 6 }}>
                        Every golfer, every source — disagreements first
                      </div>
                      <div style={{ minWidth: 460 }}>
                        <div className="mono" style={{ display: "grid", gridTemplateColumns: "2fr " + validation.feedNames.map(() => "1fr").join(" "), gap: 6, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--muted)", padding: "6px 0", borderBottom: "1px solid var(--paper-line)" }}>
                          <span>Golfer</span>
                          {validation.feedNames.map((n) => <span key={n}>{n}</span>)}
                        </div>
                        {validation.tableRows.map((r) => (
                          <div key={r.player} style={{ display: "grid", gridTemplateColumns: "2fr " + validation.feedNames.map(() => "1fr").join(" "), gap: 6, padding: "5px 0", borderBottom: "1px dotted var(--paper-line)", fontSize: 12.5, background: r.disagree ? "rgba(179,64,47,0.07)" : "transparent" }}>
                            <span>{r.player}</span>
                            {r.cells.map((c, i) => (
                              <span key={i} className="mono" style={{ color: r.disagree ? "var(--under)" : "var(--pine)" }}>{c}</span>
                            ))}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </section>

        <section className="set-block">
          <h3 className="set-title">Clubs & subscriptions <button className="remove-link" style={{ float: "right", fontSize: 12 }} onClick={clubsCsv}>Export CSV (Excel)</button></h3>
          <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}><div style={{ minWidth: 620 }}>
          <div className="mono" style={{ display: "grid", gridTemplateColumns: "2fr 1.2fr 1fr 0.6fr 0.7fr 0.9fr 0.9fr", gap: 6, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--muted)", padding: "6px 0", borderBottom: "1px solid var(--paper-line)" }}>
            <span>Club / pros</span><span>Plan</span><span>Paid thru</span><span>Pools</span><span>Entries</span><span>Revenue</span><span></span>
          </div>
          {clubs.map((c) => {
            const pros = prosOf(c.id);
            const clubPools = poolsOf(c.id);
            const clubEntries = clubPools.reduce((s, p) => s + (entriesPerPool[p.id] || 0), 0);
            const paid = paidBy(c.id);
            return (
              <div key={c.id} style={{ display: "grid", gridTemplateColumns: "2fr 1.2fr 1fr 0.6fr 0.7fr 0.9fr 0.9fr", gap: 6, alignItems: "center", padding: "9px 0", borderBottom: "1px dotted var(--paper-line)", fontSize: 12.5, opacity: c.status === "active" ? 1 : 0.55 }}>
                <span>
                  <strong>{c.name}</strong>
                  <span style={{ display: "block", fontSize: 11, color: "var(--muted)" }}>
                    {pros.length ? pros.map((m) => m.email).join(", ") : "no pro assigned"}
                  </span>
                </span>
                <span className="mono">{c.plan === "annual" ? "ANNUAL" : (c.plan || "single").toUpperCase()}</span>
                <span className="mono">{c.paid_until ? new Date(c.paid_until).toLocaleDateString([], { month: "short", day: "numeric", year: "2-digit" }) : "—"}</span>
                <span className="mono">{clubPools.length}</span>
                <span className="mono">{clubEntries}</span>
                <span className="mono">${paid.toFixed(0)}</span>
                <button className="remove-link" style={{ textAlign: "right" }} onClick={() => toggleStatus(c)}>
                  {c.status === "active" ? "Suspend" : "Reactivate"}
                </button>
              </div>
            );
          })}
          </div></div>
          <div className="field-row" style={{ marginTop: 12 }}>
            <input
              className="club-name-input" style={{ flex: "1 1 220px" }}
              placeholder="New club name"
              value={newClub}
              onChange={(e) => setNewClub(e.target.value)}
              aria-label="New club name"
            />
            <button className="btn btn-ghost btn-small" onClick={handleAddClub}>Add club</button>
          </div>
        </section>

        <section className="set-block">
          <h3 className="set-title">Payments received <button className="remove-link" style={{ float: "right", fontSize: 12 }} onClick={paymentsCsv}>Export CSV (Excel)</button></h3>
          {payments.length === 0 && (
            <p className="sheet-sub">No Stripe payments recorded yet. Once the webhook is live, every checkout lands here automatically with its club attached.</p>
          )}
          {payments.slice(0, 15).map((p) => (
            <div className="payout-row" key={p.id}>
              <span>
                {(clubs.find((c) => c.id === p.club_id) || {}).name || p.customer_email || "Unknown club"}
                <span style={{ color: "var(--muted)", marginLeft: 8, fontStyle: "italic", fontSize: 12 }}>
                  {p.plan || "single"}{p.promo_code ? " · code " + p.promo_code : ""}
                </span>
              </span>
              <span className="mono">${((Number(p.amount_cents) || 0) / 100).toFixed(2)} · {new Date(p.created_at).toLocaleDateString([], { month: "short", day: "numeric" })}</span>
            </div>
          ))}
        </section>

        <section className="set-block">
          <h3 className="set-title">Signups & referrals</h3>
          {signups.length === 0 && <p className="sheet-sub">No self-serve signups yet. Referrals entered at signup appear here so you know who earned a gift card.</p>}
          {signups.slice(0, 15).map((s) => (
            <div className="payout-row" key={s.id || s.email + s.created_at}>
              <span>
                {s.club_name}
                <span style={{ color: "var(--muted)", marginLeft: 8, fontStyle: "italic", fontSize: 12 }}>{s.email}</span>
                {s.referred_by && (
                  <span className="mono" style={{ display: "block", fontSize: 11.5, color: "var(--pine)", marginTop: 2 }}>
                    ⛳ referred by {s.referred_by}
                  </span>
                )}
              </span>
              <span className="mono">{s.created_at ? new Date(s.created_at).toLocaleDateString([], { month: "short", day: "numeric" }) : ""}</span>
            </div>
          ))}
        </section>

        <section className="set-block">
          <h3 className="set-title">Admin access</h3>
          <p className="set-sub">Anyone who signs in starts as “pending.” Grant a pro role and assign their club here.</p>
          {members.filter((m) => m.role !== "member").map((m) => {
            const club = clubs.find((c) => c.id === m.club_id);
            return (
              <div className="payout-row" key={m.id}>
                <span>
                  {m.email}
                  <span style={{ color: "var(--muted)", marginLeft: 8, fontStyle: "italic", fontSize: 12 }}>
                    {m.role}{club ? " · " + club.name : ""}
                  </span>
                </span>
                {m.role === "owner" ? (
                  <span className="mono" style={{ color: "var(--muted)", fontSize: 12 }}>you</span>
                ) : m.role === "pro" ? (
                  <button className="remove-link" onClick={() => revokePro(m.id)}>Revoke</button>
                ) : (
                  <select
                    className="club-name-input" style={{ width: 200, padding: "6px 10px" }}
                    defaultValue=""
                    onChange={(e) => e.target.value && makePro(m.id, e.target.value)}
                    aria-label={`Assign ${m.email} as pro`}
                  >
                    <option value="" disabled>Make pro at…</option>
                    {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                )}
              </div>
            );
          })}
          {members.filter((m) => m.role !== "member").length === 0 && (
            <p className="sheet-sub">No admin users yet.</p>
          )}
        </section>
      </div>
    </>
  );
}


/* ============================================================
   CLUBMAJORS — white-label major championship pools for clubs
   Field: 2026 Open Championship · Royal Birkdale (154th Open)
   Format: pick 1 golfer per tier (6 tiers × 8) · best 4 of 6 count
   Odds: DraftKings Jul 14 where published; others approximated
   ============================================================ */

/* Single source of truth for the current tournament — change this block
   (plus TIERS below) when pointing the app at a different event. */
const EVENT = {
  eyebrow: "154th Open Championship",
  name: "2026 Open Championship",
  shortName: "The Open",              /* must match the ESPN scoreboard event name */
  venue: "Royal Birkdale Golf Club",
  location: "Southport, England",
  dates: "July 16\u201319",
  deadlineFallback: "before Thursday's first tee",  /* display-only fallback when no DB pool */
  deadlineFallbackShort: "Thu \u00b7 before first tee",
  espnDates: "20260716",              /* YYYYMMDD of round 1, for ESPN ?dates= */
  deadlineISO: "2026-07-16T05:35:00Z", /* true first-tee instant (UTC) — rendered in each club's local time */
};

/* ClubMajors mark (identity "5a", claude.ai/design): fairway-green rounded
   tile, 2×2 grid — three cream cells + a clay pennant. Pure CSS, scales from
   the 104px reference; below 24px the pennant collapses to a solid clay cell
   (per the identity sheet, the four-square rhythm still reads). */
function CMLogo({ size = 40 }) {
  const cell = size * 0.288, gap = size * 0.048, r = size * 0.192;
  const pole = Math.max(1, Math.round(cell * 0.167));
  const cream = { width: cell, height: cell, background: "#FBFAF7" };
  return (
    <div aria-label="ClubMajors" style={{ width: size, height: size, borderRadius: r, background: "#1C5C3B", display: "grid", placeContent: "center", flex: "none" }}>
      <div style={{ display: "grid", gridTemplateColumns: cell + "px " + cell + "px", gridTemplateRows: cell + "px " + cell + "px", gap }}>
        <div style={cream} />
        {size >= 24 ? (
          <div style={{ position: "relative", width: cell, height: cell }}>
            <div style={{ position: "absolute", left: 0, top: 0, width: pole, height: cell, background: "#FBFAF7" }} />
            <div style={{ position: "absolute", left: pole, top: 0, width: cell - pole, height: cell * 0.633, background: "#C2410C", clipPath: "polygon(0 0, 100% 0, 0 100%)" }} />
          </div>
        ) : (
          <div style={{ width: cell, height: cell, background: "#C2410C" }} />
        )}
        <div style={cream} />
        <div style={cream} />
      </div>
    </div>
  );
}

/* datetime-local inputs are timezone-naive: always feed them LOCAL wall-clock
   strings so a club in California and a club in New York both see the same
   real-world moment expressed in their own time. */
/* An event deadline must be one real-world instant for every club. Defaults
   are computed as 7:00 AM US Eastern on round-1 day (safely before the first
   tee at any US venue), converted to a true UTC instant with DST handled —
   then rendered in each viewer's own timezone everywhere it's displayed. */
function etInstant(dateStr, hh, mm) {
  const pad = (n) => String(n).padStart(2, "0");
  const guess = new Date(dateStr + "T" + pad(hh) + ":" + pad(mm) + ":00Z");
  const parts = {};
  new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(guess).forEach((p) => { parts[p.type] = p.value; });
  const asET = Date.UTC(+parts.year, +parts.month - 1, +parts.day, parts.hour === "24" ? 0 : +parts.hour, +parts.minute);
  const want = Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10), hh, mm);
  return new Date(guess.getTime() + (want - asET)).toISOString();
}
function defaultDeadline(ev) {
  /* if this is the event our hardcoded feed block was built for, we know the
     exact first-tee instant — otherwise 7:00 AM ET on round-1 day */
  if (ev && ev.start === EVENT.deadlineISO.slice(0, 10)) return EVENT.deadlineISO;
  return ev ? etInstant(ev.start, 7, 0) : EVENT.deadlineISO;
}
function toLocalInput(dt) {
  const d = new Date(dt);
  const pad = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

const BASE_TIERS = [
  {
    label: "I",
    players: [
      { id: "scheffler", name: "Scottie Scheffler", odds: "+620", note: "Defending champion" },
      { id: "mcilroy", name: "Rory McIlroy", odds: "+860" },
      { id: "fleetwood", name: "Tommy Fleetwood", odds: "+1800", note: "Southport native" },
      { id: "fitzpatrick", name: "Matt Fitzpatrick", odds: "+1850" },
      { id: "rahm", name: "Jon Rahm", odds: "+1850" },
      { id: "schauffele", name: "Xander Schauffele", odds: "+2500", note: "2024 champion" },
      { id: "gotterup", name: "Chris Gotterup", odds: "+3000" },
      { id: "hovland", name: "Viktor Hovland", odds: "+3300" },
    ],
  },
  {
    label: "II",
    players: [
      { id: "young", name: "Cameron Young", odds: "+3100" },
      { id: "aberg", name: "Ludvig Åberg", odds: "+3300" },
      { id: "morikawa", name: "Collin Morikawa", odds: "+3400", note: "2021 champion" },
      { id: "hatton", name: "Tyrrell Hatton", odds: "+3600" },
      { id: "macintyre", name: "Robert MacIntyre", odds: "+3600" },
      { id: "rose", name: "Justin Rose", odds: "+3900" },
      { id: "clark", name: "Wyndham Clark", odds: "+4100", note: "2026 U.S. Open champion" },
      { id: "tomkim", name: "Tom Kim", odds: "+4500", note: "Scottish Open winner" },
    ],
  },
  {
    label: "III",
    players: [
      { id: "siwoo", name: "Si Woo Kim", odds: "+4300" },
      { id: "burns", name: "Sam Burns", odds: "+4700" },
      { id: "henley", name: "Russell Henley", odds: "+5100" },
      { id: "dechambeau", name: "Bryson DeChambeau", odds: "+5300" },
      { id: "thomas", name: "Justin Thomas", odds: "+5300" },
      { id: "koepka", name: "Brooks Koepka", odds: "+5500" },
      { id: "rai", name: "Aaron Rai", odds: "+6000", note: "2026 PGA champion" },
      { id: "alexfitz", name: "Alex Fitzpatrick", odds: "+6500" },
      { id: "poston", name: "J.T. Poston", odds: "+7000" },
      { id: "duplessis", name: "Hennie Du Plessis", odds: "+7500" },
    ],
  },
  {
    label: "IV",
    players: [
      { id: "spaun", name: "J.J. Spaun", odds: "+8000", note: "2025 U.S. Open champion" },
      { id: "lowry", name: "Shane Lowry", odds: "+8000", note: "2019 champion" },
      { id: "harman", name: "Brian Harman", odds: "+9000", note: "2023 champion" },
      { id: "matsuyama", name: "Hideki Matsuyama", odds: "+9200" },
      { id: "hojgaard", name: "Nicolai Højgaard", odds: "+9200" },
      { id: "cantlay", name: "Patrick Cantlay", odds: "+10000" },
      { id: "spieth", name: "Jordan Spieth", odds: "+10000", note: "2017 champion at Birkdale" },
      { id: "chacarra", name: "Eugenio Chacarra", odds: "+15500", note: "Two DP World wins in June" },
      { id: "bhatia", name: "Akshay Bhatia", odds: "+12000" },
      { id: "ecole", name: "Eric Cole", odds: "+15000" },
      { id: "jsmith", name: "Jordan Smith", odds: "+15000" },
      { id: "reitan", name: "Kristoffer Reitan", odds: "+16000" },
    ],
  },
  {
    label: "V",
    players: [
      { id: "niemann", name: "Joaquin Niemann", odds: "+12000" },
      { id: "griffin", name: "Ben Griffin", odds: "+12000" },
      { id: "kitayama", name: "Kurt Kitayama", odds: "+14000" },
      { id: "reed", name: "Patrick Reed", odds: "+15000" },
      { id: "gerard", name: "Ryan Gerard", odds: "+18000" },
      { id: "mckibbin", name: "Tom McKibbin", odds: "+18000" },
      { id: "parry", name: "John Parry", odds: "+20000" },
      { id: "mjordan", name: "Matthew Jordan", odds: "+25000" },
      { id: "rhojgaard", name: "Rasmus Højgaard", odds: "+20000" },
      { id: "mcnealy", name: "Maverick McNealy", odds: "+20000" },
      { id: "cauley", name: "Bud Cauley", odds: "+20000" },
      { id: "thorbjornsen", name: "Michael Thorbjornsen", odds: "+22000" },
      { id: "kaneko", name: "Kota Kaneko", odds: "+25000" },
      { id: "suber", name: "Jackson Suber", odds: "+25000" },
    ],
  },
  {
    label: "VI",
    players: [
      { id: "bradley", name: "Keegan Bradley", odds: "+15000" },
      { id: "conners", name: "Corey Conners", odds: "+16000" },
      { id: "straka", name: "Sepp Straka", odds: "+20000" },
      { id: "minwoo", name: "Min Woo Lee", odds: "+20000" },
      { id: "fowler", name: "Rickie Fowler", odds: "+20000" },
      { id: "day", name: "Jason Day", odds: "+25000" },
      { id: "camsmith", name: "Cameron Smith", odds: "+25000", note: "2022 champion" },
      { id: "stenson", name: "Henrik Stenson", odds: "+50000", note: "2016 champion" },
      { id: "english", name: "Harris English", odds: "+30000" },
      { id: "im", name: "Sungjae Im", odds: "+30000" },
      { id: "theegala", name: "Sahith Theegala", odds: "+30000" },
      { id: "ascott", name: "Adam Scott", odds: "+35000" },
      { id: "fox", name: "Ryan Fox", odds: "+35000" },
      { id: "homa", name: "Max Homa", odds: "+40000" },
      { id: "horschel", name: "Billy Horschel", odds: "+40000" },
      { id: "harrington", name: "Padraig Harrington", odds: "+60000" },
    ],
  },
];

/* mc = missed cut → pool score is cut total +8 per missed round */
const MC_PENALTY_PER_ROUND = 8;

const MOCK_ENTRIES = [
  { id: "e1", entry: "Breakfast Ball Boys", member: "C. Whitfield", picks: ["scheffler", "aberg", "siwoo", "spieth", "niemann", "fowler"], tb: -14 },
  { id: "e2", entry: "Pin High Society", member: "M. Okafor", picks: ["mcilroy", "clark", "rai", "lowry", "reed", "minwoo"], tb: -11 },
  { id: "e3", entry: "The Birkdale Irregulars", member: "R. Vance", picks: ["fleetwood", "young", "koepka", "spaun", "griffin", "camsmith"], tb: -12 },
  { id: "e4", entry: "Grill Room Gamblers", member: "T. Callahan", picks: ["fitzpatrick", "morikawa", "burns", "harman", "kitayama", "straka"], tb: -9 },
  { id: "e5", entry: "Dormie & Tonic", member: "S. Park", picks: ["schauffele", "hatton", "henley", "matsuyama", "gerard", "day"], tb: -15 },
  { id: "e6", entry: "The Mulligan Trust", member: "J. Hartley", picks: ["hovland", "rose", "thomas", "cantlay", "parry", "bradley"], tb: -10 },
  { id: "e7", entry: "Four Putt Phil", member: "P. Donnelly", picks: ["rahm", "macintyre", "dechambeau", "chacarra", "mckibbin", "conners"], tb: -8 },
  { id: "e8", entry: "Lift Clean & Cocktails", member: "D. Russo", picks: ["gotterup", "tomkim", "alexfitz", "hojgaard", "mjordan", "stenson"], tb: -13 },
];

/* White-label theme palettes — classic clubhouse colorways */
const THEMES = [
  { id: "pine", name: "Pine & Brass", pine: "#15382B", pineDeep: "#0D261D", board: "#0F3024", boardRow: "#123828", brass: "#B98F2F", brassBright: "#D8B45A" },
  { id: "mono", name: "Classic Black & White", pine: "#1C1C1C", pineDeep: "#0D0D0D", board: "#161616", boardRow: "#242424", brass: "#8F8F8F", brassBright: "#EDEDED" },
  { id: "navy", name: "Championship Navy", pine: "#1C2C4F", pineDeep: "#111B33", board: "#172441", boardRow: "#1C2C4F", brass: "#B6953C", brassBright: "#D9BC6A" },
  { id: "burgundy", name: "Burgundy & Gold", pine: "#5A1F26", pineDeep: "#3D1218", board: "#4A181F", boardRow: "#562028", brass: "#B6953C", brassBright: "#DCBE70" },
  { id: "fairway", name: "Fairway & Linen", pine: "#205B38", pineDeep: "#143D25", board: "#1B4E30", boardRow: "#236340", brass: "#AC9C74", brassBright: "#E4D9BB" },
  { id: "slate", name: "Slate & Platinum", pine: "#2A3238", pineDeep: "#1A2024", board: "#232A2F", boardRow: "#2E373D", brass: "#8E989F", brassBright: "#C3CCD3" },
  { id: "espresso", name: "Espresso & Saddle", pine: "#3D2B1F", pineDeep: "#271A12", board: "#34251A", boardRow: "#43301F", brass: "#9C7B4A", brassBright: "#C9A671" },
  { id: "royal", name: "Royal & Sterling", pine: "#23346E", pineDeep: "#17224A", board: "#1E2C5E", boardRow: "#26397A", brass: "#8A96B8", brassBright: "#C6D0E8" },
  { id: "midnight", name: "Midnight & Gold", pine: "#14161C", pineDeep: "#0B0D11", board: "#101218", boardRow: "#171A22", brass: "#B6953C", brassBright: "#D9BC6A" },
  { id: "olive", name: "Olive & Bone", pine: "#3E4224", pineDeep: "#292C16", board: "#363A1F", boardRow: "#42472A", brass: "#A8A278", brassBright: "#D6CFA8" },
  { id: "azalea", name: "Magnolia & Pine", pine: "#164A33", pineDeep: "#0E3423", board: "#133F2B", boardRow: "#175038", brass: "#BFAE85", brassBright: "#EFE3C4" },
  { id: "harbor", name: "Harbor & Sand", pine: "#17444A", pineDeep: "#0E2E33", board: "#133A3F", boardRow: "#1A4D54", brass: "#B99E6B", brassBright: "#DCC697" },
  { id: "ivy", name: "Ivy & Chalk", pine: "#2F6B45", pineDeep: "#1F4A2F", board: "#295D3C", boardRow: "#33754C", brass: "#A9B3A6", brassBright: "#EFF3EC" },
  /* --- country club classics --- */
  { id: "patrons", name: "Patrons Green & Gold", pine: "#0A5137", pineDeep: "#063521", board: "#084628", boardRow: "#0C5A34", brass: "#C9A227", brassBright: "#F2CE60" },
  { id: "heather", name: "Old Course Heather", pine: "#1F3F66", pineDeep: "#142B47", board: "#1A3757", boardRow: "#234670", brass: "#8FA3BC", brassBright: "#D7E1EC" },
  { id: "wicker", name: "Wicker & Hunter", pine: "#1E4633", pineDeep: "#123021", board: "#193D2B", boardRow: "#245139", brass: "#C68A3F", brassBright: "#E9B663" },
  { id: "tartan", name: "Tartan Navy & Claret", pine: "#20304F", pineDeep: "#141F36", board: "#1B2944", boardRow: "#263A5E", brass: "#8C2F38", brassBright: "#C05561" },
  { id: "fescue", name: "Seaside Fescue", pine: "#3A5A40", pineDeep: "#27402C", board: "#324F38", boardRow: "#426749", brass: "#B49B57", brassBright: "#E3CE8F" },
  { id: "carolina", name: "Carolina Sky", pine: "#14395C", pineDeep: "#0C2740", board: "#11324F", boardRow: "#1A4266", brass: "#6E9FC4", brassBright: "#9FC9E8" },
];

/* Upcoming events + platform pricing (what the CLUB pays ClubMajors to run a pool).
   Events carry real start/end dates: the dropdown sorts chronologically and
   drops events more than 3 days past their finish — no manual pruning. */
const EVENTS_ALL = [
  { id: "open2026", name: "The Open Championship · Royal Birkdale", start: "2026-07-16", end: "2026-07-19", type: "major" },
  { id: "3m", name: "3M Open · TPC Twin Cities", start: "2026-07-23", end: "2026-07-26", type: "standard" },
  { id: "rocket", name: "Rocket Classic · Detroit GC", start: "2026-07-30", end: "2026-08-02", type: "standard" },
  { id: "wyndham", name: "Wyndham Championship · Sedgefield", start: "2026-08-06", end: "2026-08-09", type: "standard" },
  { id: "stjude", name: "FedEx St. Jude Championship · Memphis", start: "2026-08-13", end: "2026-08-16", type: "signature" },
  { id: "bmw", name: "BMW Championship · Baltimore", start: "2026-08-20", end: "2026-08-23", type: "signature" },
  { id: "tourchamp", name: "TOUR Championship · East Lake", start: "2026-08-27", end: "2026-08-30", type: "signature" },
  { id: "prescup", name: "Presidents Cup · Medinah", start: "2026-09-24", end: "2026-09-27", type: "team", teamEvent: true },
  { id: "bankutah", name: "Bank of Utah Championship", start: "2026-10-01", end: "2026-10-04", type: "standard" },
  { id: "baycurrent", name: "Baycurrent Classic · Yokohama", start: "2026-10-08", end: "2026-10-11", type: "standard" },
  { id: "bermuda", name: "Butterfield Bermuda Championship", start: "2026-10-22", end: "2026-10-25", type: "standard" },
  { id: "mexico", name: "VidantaWorld Mexico Open", start: "2026-10-29", end: "2026-11-01", type: "standard" },
  { id: "wwt", name: "World Wide Technology Championship", start: "2026-11-05", end: "2026-11-08", type: "standard" },
  { id: "rsm", name: "The RSM Classic · Sea Island", start: "2026-11-19", end: "2026-11-22", type: "standard" },
];
function eventDates(e) {
  const opts = { month: "short", day: "numeric" };
  const s = new Date(e.start + "T12:00:00");
  const n = new Date(e.end + "T12:00:00");
  return s.toLocaleDateString([], opts) + "\u2013" + n.toLocaleDateString([], opts) + ", " + s.getFullYear();
}
/* ---- Presidents Cup (team match play) ---- */
const PC_USA = ["Scottie Scheffler", "Xander Schauffele", "Collin Morikawa", "Russell Henley", "Justin Thomas", "Patrick Cantlay", "Sam Burns", "Keegan Bradley", "Ben Griffin", "Harris English", "Jordan Spieth", "Cameron Young"];
const PC_INTL = ["Hideki Matsuyama", "Sungjae Im", "Tom Kim", "Si Woo Kim", "Corey Conners", "Taylor Pendrith", "Adam Scott", "Min Woo Lee", "Cam Davis", "Ryan Fox", "Christiaan Bezuidenhout", "Aldrich Potgieter"];
const pcId = (n) => "pc_" + normName(n).replace(/\s+/g, "");
const pcPlayers = (names) => names.map((n) => ({ id: pcId(n), name: n, odds: "" }));
const TEAM_TIERS = [
  { label: "USA-1", side: "USA", players: pcPlayers(PC_USA) },
  { label: "USA-2", side: "USA", players: pcPlayers(PC_USA) },
  { label: "USA-3", side: "USA", players: pcPlayers(PC_USA) },
  { label: "INTL-1", side: "INTL", players: pcPlayers(PC_INTL) },
  { label: "INTL-2", side: "INTL", players: pcPlayers(PC_INTL) },
  { label: "INTL-3", side: "INTL", players: pcPlayers(PC_INTL) },
];
const TEAM_INDEX = (() => { const m = {}; TEAM_TIERS.forEach((t) => t.players.forEach((p) => { m[p.id] = { name: p.name, tier: t.side }; })); return m; })();
const isTeamEl = (x) => typeof x === "string" && x.slice(0, 5) === "team:";
const isTbsEl = (x) => typeof x === "string" && x.slice(0, 4) === "tbs:";

const EVENTS = EVENTS_ALL
  .filter((e) => new Date(e.end + "T23:59:00").getTime() > Date.now() - 3 * 86400000)
  .sort((a, b) => a.start.localeCompare(b.start))
  .map((e) => ({ ...e, dates: eventDates(e) }));
const PLATFORM_PRICING = { major: 75, signature: 30, standard: 30, team: 30 };
const PRICING_LABEL = { major: "Major", signature: "Signature Event", standard: "Standard Event", team: "Team Event" };
const ANNUAL_PRICE = 330; /* 4 × major ($75) + $30 · all PGA Tour events */
const SEASON_PRICE = 30;  /* 2026 Season Pass — flat $30 for every remaining 2026 PGA Tour event */

/* ----- custom color helpers: club picks 2 colors, we derive the rest ----- */
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(rgb) {
  return "#" + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
}
function shade(hex, amt) {
  const c = hexToRgb(hex);
  if (!c) return hex;
  return rgbToHex(c.map((v) => (amt < 0 ? v * (1 + amt) : v + (255 - v) * amt)));
}
function luminance(hex) {
  const c = hexToRgb(hex);
  if (!c) return 0;
  const [r, g, b] = c.map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function deriveCustomTheme(primary, accent) {
  /* keep the primary dark enough that cream text stays readable,
     and the accent bright enough to read on the dark scoreboard */
  let pine = hexToRgb(primary) ? primary : "#15382B";
  let guard = 0;
  while (luminance(pine) > 0.18 && guard++ < 16) pine = shade(pine, -0.12);
  let bright = hexToRgb(accent) ? accent : "#D8B45A";
  guard = 0;
  while (luminance(bright) < 0.28 && guard++ < 16) bright = shade(bright, 0.15);
  return {
    id: "custom",
    name: "Custom",
    pine,
    pineDeep: shade(pine, -0.35),
    board: shade(pine, -0.15),
    boardRow: shade(pine, 0.07),
    brass: shade(bright, -0.25),
    brassBright: bright,
  };
}

function buildIndex(tiers) {
  const idx = {};
  tiers.forEach((t) =>
    t.players.forEach((p) => {
      idx[p.id] = { ...p, tier: t.label };
    })
  );
  return idx;
}

/* Build the FULL-FIELD picksheet from the live feed: curated players keep
   their odds-based tiers and ids (so existing entries stay valid); everyone
   else in the field fills tiers V and VI alphabetically, EOP-style. */
/* With live odds (DataGolf), tiers are built purely by the odds board:
   favorites first, EOP-style tier sizes. No curation, works for any event. */
function buildOddsTiers(players, oddsList) {
  const oddsBy = new Map();
  oddsList.forEach((o) => oddsBy.set(normName((o.firstName || "") + " " + (o.lastName || "")), o.odds));
  const seen = new Set();
  const field = [];
  players.forEach((pl) => {
    const name = ((pl.firstName || "") + " " + (pl.lastName || "")).trim();
    if (!name) return;
    const key = normName(name);
    if (seen.has(key)) return;
    seen.add(key);
    field.push({ id: "f_" + key.replace(/\s+/g, ""), name, oddsNum: oddsBy.has(key) ? oddsBy.get(key) : null });
  });
  const priced = field.filter((f) => f.oddsNum !== null).sort((a, b) => a.oddsNum - b.oddsNum);
  const unpriced = field.filter((f) => f.oddsNum === null).sort((a, b) => (a.name.split(" ").pop() || "").localeCompare(b.name.split(" ").pop() || ""));
  if (priced.length < field.length / 2) return null; /* odds too sparse to tier honestly */
  const sizes = [8, 10, 12, 14, 16];
  const labels = ["I", "II", "III", "IV", "V", "VI"];
  const tiers = [];
  let idx = 0;
  for (let t = 0; t < 5; t++) {
    const chunk = priced.slice(idx, idx + sizes[t]);
    idx += sizes[t];
    if (chunk.length) tiers.push({ label: labels[t], players: chunk.map((f) => ({ id: f.id, name: f.name, odds: (f.oddsNum > 0 ? "+" : "") + f.oddsNum })) });
  }
  const rest = priced.slice(idx).map((f) => ({ id: f.id, name: f.name, odds: (f.oddsNum > 0 ? "+" : "") + f.oddsNum }))
    .concat(unpriced.map((f) => ({ id: f.id, name: f.name, odds: "" })));
  if (rest.length) tiers.push({ label: labels[Math.min(tiers.length, 5)], players: rest });
  return tiers.length >= 4 ? tiers : null;
}

function buildDynamicTiers(players, curatedEvent) {
  const curated = {};
  BASE_TIERS.forEach((t) => t.players.forEach((p) => { curated[normName(p.name)] = { ...p, tier: t.label }; }));
  const byTier = { I: [], II: [], III: [], IV: [], V: [], VI: [] };
  const extras = [];
  const seen = new Set();
  players.forEach((pl) => {
    const name = ((pl.firstName || "") + " " + (pl.lastName || "")).trim();
    if (!name) return;
    const key = normName(name);
    if (seen.has(key)) return;
    seen.add(key);
    const cur = curated[key];
    /* curated odds/notes belong to ONE tournament — for any other event the
       curated names only seed tier placement, with no stale odds shown */
    if (cur) byTier[cur.tier].push({ id: cur.id, name: cur.name, odds: curatedEvent ? cur.odds : "", note: curatedEvent ? cur.note : undefined });
    else extras.push({ id: "f_" + key.replace(/\s+/g, ""), name, odds: "" });
  });
  extras.sort((a, b) => (a.name.split(" ").pop() || "").localeCompare(b.name.split(" ").pop() || ""));
  const half = Math.ceil(extras.length / 2);
  byTier.V.push(...extras.slice(0, half));
  byTier.VI.push(...extras.slice(half));
  const out = ["I", "II", "III", "IV", "V", "VI"].map((l) => ({ label: l, players: byTier[l] })).filter((t) => t.players.length > 0);
  return out.length >= 4 ? out : BASE_TIERS;
}

/* ---------- DEMO MODE (?demo=masters) — fictional club, real 2026 Masters final scores ---------- */
const DEMO_TIERS = [{"label": "I", "players": [{"id": "d_scottiescheffler", "name": "Scottie Scheffler", "odds": "+400"}, {"id": "d_rorymcilroy", "name": "Rory McIlroy", "odds": "+650"}, {"id": "d_brysondechambeau", "name": "Bryson DeChambeau", "odds": "+1100"}, {"id": "d_jonrahm", "name": "Jon Rahm", "odds": "+1400"}, {"id": "d_collinmorikawa", "name": "Collin Morikawa", "odds": "+1800"}, {"id": "d_xanderschauffele", "name": "Xander Schauffele", "odds": "+1800"}, {"id": "d_ludvigaberg", "name": "Ludvig Åberg", "odds": "+2000"}, {"id": "d_viktorhovland", "name": "Viktor Hovland", "odds": "+2200"}, {"id": "d_justinthomas", "name": "Justin Thomas", "odds": "+2500"}, {"id": "d_cameronsmith", "name": "Cameron Smith", "odds": "+2800"}]}, {"label": "II", "players": [{"id": "d_tyrrellhatton", "name": "Tyrrell Hatton", "odds": "+2800"}, {"id": "d_tommyfleetwood", "name": "Tommy Fleetwood", "odds": "+3000"}, {"id": "d_patrickcantlay", "name": "Patrick Cantlay", "odds": "+3000"}, {"id": "d_samburns", "name": "Sam Burns", "odds": "+3500"}, {"id": "d_jordanspieth", "name": "Jordan Spieth", "odds": "+3500"}, {"id": "d_russellhenley", "name": "Russell Henley", "odds": "+4000"}, {"id": "d_hidekimatsuyama", "name": "Hideki Matsuyama", "odds": "+4000"}, {"id": "d_maxhoma", "name": "Max Homa", "odds": "+4500"}, {"id": "d_shanelowry", "name": "Shane Lowry", "odds": "+4500"}, {"id": "d_brookskoepka", "name": "Brooks Koepka", "odds": "+5000"}, {"id": "d_jasonday", "name": "Jason Day", "odds": "+5500"}, {"id": "d_minwoolee", "name": "Min Woo Lee", "odds": "+5500"}]}, {"label": "III", "players": [{"id": "d_cameronyoung", "name": "Cameron Young", "odds": "+5000"}, {"id": "d_patrickreed", "name": "Patrick Reed", "odds": "+6000"}, {"id": "d_wyndhamclark", "name": "Wyndham Clark", "odds": "+6500"}, {"id": "d_mattfitzpatrick", "name": "Matt Fitzpatrick", "odds": "+6500"}, {"id": "d_seppstraka", "name": "Sepp Straka", "odds": "+7000"}, {"id": "d_jjspaun", "name": "J.J. Spaun", "odds": "+7000"}, {"id": "d_robertmacintyre", "name": "Robert MacIntyre", "odds": "+7500"}, {"id": "d_bengriffin", "name": "Ben Griffin", "odds": "+8000"}, {"id": "d_harrisenglish", "name": "Harris English", "odds": "+8000"}, {"id": "d_sungjaeim", "name": "Sungjae Im", "odds": "+9000"}, {"id": "d_keeganbradley", "name": "Keegan Bradley", "odds": "+9000"}, {"id": "d_akshaybhatia", "name": "Akshay Bhatia", "odds": "+9500"}, {"id": "d_andrewnovak", "name": "Andrew Novak", "odds": "+10000"}]}, {"label": "IV", "players": [{"id": "d_justinrose", "name": "Justin Rose", "odds": "+7500"}, {"id": "d_chrisgotterup", "name": "Chris Gotterup", "odds": "+10000"}, {"id": "d_jakeknapp", "name": "Jake Knapp", "odds": "+10000"}, {"id": "d_nicolaihojgaard", "name": "Nicolai Højgaard", "odds": "+11000"}, {"id": "d_coreyconners", "name": "Corey Conners", "odds": "+11000"}, {"id": "d_dustinjohnson", "name": "Dustin Johnson", "odds": "+12000"}, {"id": "d_sergiogarcia", "name": "Sergio García", "odds": "+12000"}, {"id": "d_brianharman", "name": "Brian Harman", "odds": "+15000"}, {"id": "d_maverickmcnealy", "name": "Maverick McNealy", "odds": "+15000"}, {"id": "d_ryanfox", "name": "Ryan Fox", "odds": "+16000"}, {"id": "d_nicktaylor", "name": "Nick Taylor", "odds": "+18000"}, {"id": "d_alexnoren", "name": "Alex Norén", "odds": "+18000"}, {"id": "d_maxgreyserman", "name": "Max Greyserman", "odds": "+18000"}, {"id": "d_aldrichpotgieter", "name": "Aldrich Potgieter", "odds": "+16000"}]}, {"label": "V", "players": [{"id": "d_aaronrai", "name": "Aaron Rai", "odds": "+20000"}, {"id": "d_siwookim", "name": "Si Woo Kim", "odds": "+20000"}, {"id": "d_kurtkitayama", "name": "Kurt Kitayama", "odds": "+22000"}, {"id": "d_adamscott", "name": "Adam Scott", "odds": "+22000"}, {"id": "d_samstevens", "name": "Sam Stevens", "odds": "+25000"}, {"id": "d_garywoodland", "name": "Gary Woodland", "odds": "+25000"}, {"id": "d_ryangerard", "name": "Ryan Gerard", "odds": "+30000"}, {"id": "d_haotongli", "name": "Haotong Li", "odds": "+30000"}, {"id": "d_nicoechavarria", "name": "Nico Echavarría", "odds": "+30000"}, {"id": "d_harryhall", "name": "Harry Hall", "odds": "+35000"}, {"id": "d_samivalimaki", "name": "Sami Välimäki", "odds": "+40000"}, {"id": "d_michaelkim", "name": "Michael Kim", "odds": "+40000"}, {"id": "d_jacobbridgeman", "name": "Jacob Bridgeman", "odds": "+40000"}, {"id": "d_kristofferreitan", "name": "Kristoffer Reitan", "odds": "+40000"}, {"id": "d_zachjohnson", "name": "Zach Johnson", "odds": "+50000"}, {"id": "d_bubbawatson", "name": "Bubba Watson", "odds": "+50000"}]}, {"label": "VI", "players": [{"id": "d_michaelbrennan", "name": "Michael Brennan", "odds": "+50000"}, {"id": "d_briancampbell", "name": "Brian Campbell", "odds": "+50000"}, {"id": "d_mattmccarty", "name": "Matt McCarty", "odds": "+60000"}, {"id": "d_marcopenge", "name": "Marco Penge", "odds": "+60000"}, {"id": "d_rasmushojgaard", "name": "Rasmus Højgaard", "odds": "+75000"}, {"id": "d_johnnykeefer", "name": "Johnny Keefer", "odds": "+75000"}, {"id": "d_charlschwartzel", "name": "Charl Schwartzel", "odds": "+90000"}, {"id": "d_dannywillett", "name": "Danny Willett", "odds": "+90000"}, {"id": "d_fredcouples", "name": "Fred Couples", "odds": "+100000"}, {"id": "d_josemariaolazabal", "name": "José María Olazábal", "odds": "+150000"}, {"id": "d_angelcabrera", "name": "Ángel Cabrera", "odds": "+150000"}, {"id": "d_vijaysingh", "name": "Vijay Singh", "odds": "+150000"}, {"id": "d_mikeweir", "name": "Mike Weir", "odds": "+150000"}, {"id": "d_jacksonherringtona", "name": "Jackson Herrington (a)", "odds": "+100000"}, {"id": "d_masonhowella", "name": "Mason Howell (a)", "odds": "+100000"}, {"id": "d_ethanfanga", "name": "Ethan Fang (a)", "odds": "+150000"}]}];
const DEMO_SCORES = {"d_scottiescheffler":{"total": -11, "today": -4, "thru": 18, "rounds": [70, 74, 65, 68]},"d_rorymcilroy":{"total": -12, "today": -1, "thru": 18, "rounds": [67, 65, 73, 71]},"d_brysondechambeau":{"total": 6, "mc": true, "rounds": [76, 74]},"d_jonrahm":{"total": 1, "today": -4, "thru": 18, "rounds": [78, 70, 73, 68]},"d_collinmorikawa":{"total": -9, "today": -4, "thru": 18, "rounds": [74, 69, 68, 68]},"d_xanderschauffele":{"total": -8, "today": -4, "thru": 18, "rounds": [70, 72, 70, 68]},"d_ludvigaberg":{"total": -3, "today": 0, "thru": 18, "rounds": [74, 70, 69, 72]},"d_viktorhovland":{"total": -4, "today": -5, "thru": 18, "rounds": [75, 71, 71, 67]},"d_justinthomas":{"total": 2, "today": 1, "thru": 18, "rounds": [72, 74, 71, 73]},"d_cameronsmith":{"total": 5, "mc": true, "rounds": [73, 76]},"d_tyrrellhatton":{"total": -10, "today": -6, "thru": 18, "rounds": [74, 66, 72, 66]},"d_tommyfleetwood":{"total": 0, "today": 4, "thru": 18, "rounds": [71, 68, 73, 76]},"d_patrickcantlay":{"total": -5, "today": 1, "thru": 18, "rounds": [77, 67, 66, 73]},"d_samburns":{"total": -9, "today": 1, "thru": 18, "rounds": [67, 71, 68, 73]},"d_jordanspieth":{"total": -5, "today": -4, "thru": 18, "rounds": [72, 73, 70, 68]},"d_russellhenley":{"total": -10, "today": -4, "thru": 18, "rounds": [73, 71, 66, 68]},"d_hidekimatsuyama":{"total": -5, "today": -3, "thru": 18, "rounds": [72, 70, 72, 69]},"d_maxhoma":{"total": -8, "today": -5, "thru": 18, "rounds": [72, 70, 71, 67]},"d_shanelowry":{"total": -1, "today": 8, "thru": 18, "rounds": [70, 69, 68, 80]},"d_brookskoepka":{"total": -5, "today": -1, "thru": 18, "rounds": [72, 69, 71, 71]},"d_jasonday":{"total": -5, "today": 3, "thru": 18, "rounds": [69, 71, 68, 75]},"d_minwoolee":{"total": 5, "mc": true, "rounds": [72, 77]},"d_cameronyoung":{"total": -10, "today": 1, "thru": 18, "rounds": [73, 67, 65, 73]},"d_patrickreed":{"total": -5, "today": 1, "thru": 18, "rounds": [69, 69, 72, 73]},"d_wyndhamclark":{"total": -3, "today": 1, "thru": 18, "rounds": [72, 68, 72, 73]},"d_mattfitzpatrick":{"total": -4, "today": -1, "thru": 18, "rounds": [74, 69, 70, 71]},"d_seppstraka":{"total": 2, "today": 4, "thru": 18, "rounds": [73, 72, 69, 76]},"d_jjspaun":{"total": 6, "mc": true, "rounds": [74, 76]},"d_robertmacintyre":{"total": 6, "mc": true, "rounds": [73, 77]},"d_bengriffin":{"total": 0, "today": 5, "thru": 18, "rounds": [72, 69, 70, 77]},"d_harrisenglish":{"total": -1, "today": 0, "thru": 18, "rounds": [73, 71, 71, 72]},"d_sungjaeim":{"total": 3, "today": 5, "thru": 18, "rounds": [76, 69, 69, 77]},"d_keeganbradley":{"total": -3, "today": -6, "thru": 18, "rounds": [72, 74, 73, 66]},"d_akshaybhatia":{"total": 5, "mc": true, "rounds": [73, 76]},"d_andrewnovak":{"total": 6, "mc": true, "rounds": [73, 77]},"d_justinrose":{"total": -10, "today": -2, "thru": 18, "rounds": [70, 69, 69, 70]},"d_chrisgotterup":{"total": -2, "today": 1, "thru": 18, "rounds": [72, 69, 72, 73]},"d_jakeknapp":{"total": -7, "today": -2, "thru": 18, "rounds": [73, 69, 69, 70]},"d_nicolaihojgaard":{"total": 7, "mc": true, "rounds": [76, 75]},"d_coreyconners":{"total": 6, "today": 3, "thru": 18, "rounds": [75, 73, 71, 75]},"d_dustinjohnson":{"total": 0, "today": -3, "thru": 18, "rounds": [73, 71, 75, 69]},"d_sergiogarcia":{"total": 8, "today": 3, "thru": 18, "rounds": [72, 75, 74, 75]},"d_brianharman":{"total": 0, "today": 1, "thru": 18, "rounds": [79, 69, 67, 73]},"d_maverickmcnealy":{"total": -4, "today": -5, "thru": 18, "rounds": [77, 70, 70, 67]},"d_ryanfox":{"total": 7, "mc": true, "rounds": [77, 74]},"d_nicktaylor":{"total": 2, "today": 5, "thru": 18, "rounds": [71, 72, 70, 77]},"d_alexnoren":{"total": -1, "today": -2, "thru": 18, "rounds": [77, 71, 69, 70]},"d_maxgreyserman":{"total": 6, "mc": true, "rounds": [75, 75]},"d_aldrichpotgieter":{"total": 7, "mc": true, "rounds": [74, 77]},"d_aaronrai":{"total": 5, "today": -2, "thru": 18, "rounds": [71, 74, 78, 70]},"d_siwookim":{"total": 4, "today": 0, "thru": 18, "rounds": [75, 73, 72, 72]},"d_kurtkitayama":{"total": 7, "today": 0, "thru": 18, "rounds": [69, 79, 75, 72]},"d_adamscott":{"total": -2, "today": -2, "thru": 18, "rounds": [72, 74, 70, 70]},"d_samstevens":{"total": -2, "today": -2, "thru": 18, "rounds": [72, 74, 70, 70]},"d_garywoodland":{"total": 0, "today": -6, "thru": 18, "rounds": [71, 75, 76, 66]},"d_ryangerard":{"total": 1, "today": 5, "thru": 18, "rounds": [72, 72, 68, 77]},"d_haotongli":{"total": 1, "today": 8, "thru": 18, "rounds": [71, 69, 69, 80]},"d_nicoechavarria":{"total": 6, "mc": true, "rounds": [76, 74]},"d_harryhall":{"total": 7, "mc": true, "rounds": [76, 75]},"d_samivalimaki":{"total": 8, "mc": true, "rounds": [75, 77]},"d_michaelkim":{"total": 8, "mc": true, "rounds": [76, 76]},"d_jacobbridgeman":{"total": 2, "today": 4, "thru": 18, "rounds": [71, 74, 69, 76]},"d_kristofferreitan":{"total": 3, "today": 5, "thru": 18, "rounds": [72, 69, 73, 77]},"d_zachjohnson":{"total": 8, "mc": true, "rounds": [75, 77]},"d_bubbawatson":{"total": 8, "mc": true, "rounds": [74, 78]},"d_michaelbrennan":{"total": -2, "today": 1, "thru": 18, "rounds": [72, 71, 70, 73]},"d_briancampbell":{"total": -2, "today": 1, "thru": 18, "rounds": [71, 73, 69, 73]},"d_mattmccarty":{"total": -2, "today": -3, "thru": 18, "rounds": [72, 73, 72, 69]},"d_marcopenge":{"total": 6, "today": 6, "thru": 18, "rounds": [76, 69, 71, 78]},"d_rasmushojgaard":{"total": 10, "today": 5, "thru": 18, "rounds": [78, 70, 73, 77]},"d_johnnykeefer":{"total": 6, "mc": true, "rounds": [74, 76]},"d_charlschwartzel":{"total": 9, "mc": true, "rounds": [76, 77]},"d_dannywillett":{"total": 9, "mc": true, "rounds": [77, 76]},"d_fredcouples":{"total": 10, "mc": true, "rounds": [78, 76]},"d_josemariaolazabal":{"total": 13, "mc": true, "rounds": [79, 78]},"d_angelcabrera":{"total": 13, "mc": true, "rounds": [78, 79]},"d_vijaysingh":{"total": 12, "mc": true, "rounds": [77, 79]},"d_mikeweir":{"total": 11, "mc": true, "rounds": [76, 79]},"d_jacksonherringtona":{"total": 10, "mc": true, "rounds": [76, 78]},"d_masonhowella":{"total": 11, "mc": true, "rounds": [77, 78]},"d_ethanfanga":{"total": 10, "mc": true, "rounds": [75, 79]}};
const DEMO_UPDATED = "2026-04-12T23:05:00Z";
const DEMO_CLUB = { id: "demo-club", name: "Cypress Hollow Country Club", slug: "demo", status: "active", theme: { tagline: "Est. 1931 · A Fictional Club · ClubMajors Demo", noLogo: false, pros: [{ first: "Chip", last: "Anderson" }, { first: "Danny", last: "Noonan" }] } };
const DEMO_POOL = { id: "demo-pool", club_id: "demo-club", event_name: "The Masters", entry_fee: 25, deadline: "2026-04-09T11:00:00Z", published: true, tiebreaker_on: true, payouts: [60, 30, 10], description: "Open to all members and their guests. All payouts are made in club pro shop credit. Winners announced Sunday evening in the grill room.", rules: "• Pick six — one golfer from each odds-based tier, before Thursday's first tee.\n• Best four count — your four lowest 72-hole scores to par make your total. Lowest total Sunday wins.\n• Missed cuts score their 36-hole total +8 per weekend round (withdrawals too — same-tier swaps OK before the deadline).\n• Tiebreaker — closest guess at the winning score, then a scorecard playoff of best pick vs. best pick. Golf shop has final say.\n• Entries — up to 2 per member." };
const DEMO_ENTRIES = [{"id": "demo-e1", "entry_name": "Green Jackets Only", "member_name": "Tommy R.", "picks": ["d_rorymcilroy", "d_tyrrellhatton", "d_cameronyoung", "d_justinrose", "d_garywoodland", "d_johnnykeefer", "tb:274"]}, {"id": "demo-e2", "entry_name": "Pimento Cheese Party", "member_name": "Linda K.", "picks": ["d_scottiescheffler", "d_russellhenley", "d_cameronyoung", "d_justinrose", "d_haotongli", "d_briancampbell", "tb:277"]}, {"id": "demo-e3", "entry_name": "Caddyshack Revival", "member_name": "Pete L.", "picks": ["d_rorymcilroy", "d_samburns", "d_mattfitzpatrick", "d_justinrose", "d_adamscott", "d_michaelbrennan", "tb:275"]}, {"id": "demo-e4", "entry_name": "The Sandbaggers", "member_name": "Mary Lou T.", "picks": ["d_scottiescheffler", "d_russellhenley", "d_mattfitzpatrick", "d_justinrose", "d_garywoodland", "d_jacksonherringtona", "tb:274"]}, {"id": "demo-e5", "entry_name": "The Azalea Aces", "member_name": "Margaret W.", "picks": ["d_scottiescheffler", "d_samburns", "d_patrickreed", "d_jakeknapp", "d_samstevens", "d_mattmccarty", "tb:275"]}, {"id": "demo-e6", "entry_name": "Amen Corner Crew", "member_name": "Dave P.", "picks": ["d_rorymcilroy", "d_maxhoma", "d_keeganbradley", "d_nicktaylor", "d_adamscott", "d_michaelbrennan", "tb:272"]}, {"id": "demo-e7", "entry_name": "Butler Cabin Bound", "member_name": "Cheryl D.", "picks": ["d_rorymcilroy", "d_hidekimatsuyama", "d_patrickreed", "d_alexnoren", "d_jacobbridgeman", "d_rasmushojgaard", "tb:276"]}, {"id": "demo-e8", "entry_name": "Rae's Creek Waders", "member_name": "Sally P.", "picks": ["d_collinmorikawa", "d_tyrrellhatton", "d_jjspaun", "d_alexnoren", "d_jacobbridgeman", "d_michaelbrennan", "tb:276"]}, {"id": "demo-e9", "entry_name": "Sunday Red", "member_name": "Marcus T.", "picks": ["d_xanderschauffele", "d_jordanspieth", "d_wyndhamclark", "d_nicktaylor", "d_siwookim", "d_briancampbell", "tb:278"]}, {"id": "demo-e10", "entry_name": "The 19th Hole", "member_name": "Barb S.", "picks": ["d_cameronsmith", "d_brookskoepka", "d_patrickreed", "d_maverickmcnealy", "d_ryangerard", "d_mattmccarty", "tb:275"]}, {"id": "demo-e11", "entry_name": "Two Putts Max", "member_name": "Gene O.", "picks": ["d_collinmorikawa", "d_patrickcantlay", "d_mattfitzpatrick", "d_coreyconners", "d_siwookim", "d_mattmccarty", "tb:279"]}, {"id": "demo-e12", "entry_name": "Dawn Patrol", "member_name": "Hank M.", "picks": ["d_justinthomas", "d_shanelowry", "d_cameronyoung", "d_brianharman", "d_garywoodland", "d_briancampbell", "tb:277"]}, {"id": "demo-e13", "entry_name": "Fore! Please", "member_name": "Bill N.", "picks": ["d_ludvigaberg", "d_jasonday", "d_akshaybhatia", "d_chrisgotterup", "d_samstevens", "d_rasmushojgaard", "tb:273"]}, {"id": "demo-e14", "entry_name": "Magnolia Lane Express", "member_name": "Chip W.", "picks": ["d_rorymcilroy", "d_jordanspieth", "d_bengriffin", "d_coreyconners", "d_harryhall", "d_fredcouples", "tb:271"]}, {"id": "demo-e15", "entry_name": "Mulligan's Law", "member_name": "Patty G.", "picks": ["d_viktorhovland", "d_tommyfleetwood", "d_andrewnovak", "d_jakeknapp", "d_siwookim", "d_marcopenge", "tb:280"]}, {"id": "demo-e16", "entry_name": "Tea Olive Society", "member_name": "Nancy F.", "picks": ["d_viktorhovland", "d_maxhoma", "d_robertmacintyre", "d_nicolaihojgaard", "d_aaronrai", "d_mattmccarty", "tb:280"]}, {"id": "demo-e17", "entry_name": "Eagle Hunters", "member_name": "Frank D.", "picks": ["d_jonrahm", "d_patrickcantlay", "d_harrisenglish", "d_dustinjohnson", "d_zachjohnson", "d_vijaysingh", "tb:279"]}, {"id": "demo-e18", "entry_name": "Three Off The Tee", "member_name": "Walt B.", "picks": ["d_ludvigaberg", "d_maxhoma", "d_wyndhamclark", "d_sergiogarcia", "d_kurtkitayama", "d_josemariaolazabal", "tb:283"]}, {"id": "demo-e19", "entry_name": "The Grill Room Gang", "member_name": "Susan H.", "picks": ["d_jonrahm", "d_tommyfleetwood", "d_seppstraka", "d_ryanfox", "d_kurtkitayama", "d_marcopenge", "tb:281"]}, {"id": "demo-e20", "entry_name": "Hogan's Alley Cats", "member_name": "Ernie V.", "picks": ["d_xanderschauffele", "d_hidekimatsuyama", "d_akshaybhatia", "d_maxgreyserman", "d_aaronrai", "d_ethanfanga", "tb:282"]}, {"id": "demo-e21", "entry_name": "Bomb & Gouge", "member_name": "Rick S.", "picks": ["d_brysondechambeau", "d_brookskoepka", "d_seppstraka", "d_dustinjohnson", "d_ryangerard", "d_marcopenge", "tb:270"]}, {"id": "demo-e22", "entry_name": "Grip It & Sip It", "member_name": "Doug F.", "picks": ["d_brysondechambeau", "d_jasonday", "d_keeganbradley", "d_aldrichpotgieter", "d_samivalimaki", "d_mikeweir", "tb:268"]}, {"id": "demo-e23", "entry_name": "Pin High Society", "member_name": "Al G.", "picks": ["d_viktorhovland", "d_tyrrellhatton", "d_wyndhamclark", "d_maxgreyserman", "d_adamscott", "d_johnnykeefer", "tb:284"]}, {"id": "demo-e24", "entry_name": "Birdie Machine", "member_name": "Rhonda C.", "picks": ["d_rorymcilroy", "d_russellhenley", "d_harrisenglish", "d_jakeknapp", "d_kristofferreitan", "d_michaelbrennan", "tb:272"]}, {"id": "demo-e25", "entry_name": "The Yips", "member_name": "Stu M.", "picks": ["d_justinthomas", "d_jordanspieth", "d_harrisenglish", "d_maverickmcnealy", "d_nicoechavarria", "d_jacksonherringtona", "tb:288"]}, {"id": "demo-e26", "entry_name": "Fried Egg Lies", "member_name": "Carol B.", "picks": ["d_cameronsmith", "d_brookskoepka", "d_bengriffin", "d_sergiogarcia", "d_jacobbridgeman", "d_rasmushojgaard", "tb:278"]}, {"id": "demo-e27", "entry_name": "Mashie Niblicks", "member_name": "Herb S.", "picks": ["d_rorymcilroy", "d_patrickcantlay", "d_sungjaeim", "d_alexnoren", "d_samivalimaki", "d_mikeweir", "tb:284"]}, {"id": "demo-e28", "entry_name": "Downhill Sliders", "member_name": "Vic R.", "picks": ["d_viktorhovland", "d_minwoolee", "d_robertmacintyre", "d_coreyconners", "d_aaronrai", "d_rasmushojgaard", "tb:279"]}, {"id": "demo-e29", "entry_name": "Texas Wedge", "member_name": "Dottie H.", "picks": ["d_ludvigaberg", "d_minwoolee", "d_akshaybhatia", "d_maverickmcnealy", "d_kurtkitayama", "d_rasmushojgaard", "tb:277"]}, {"id": "demo-e30", "entry_name": "The Lumberjacks", "member_name": "Cal N.", "picks": ["d_ludvigaberg", "d_minwoolee", "d_jjspaun", "d_maxgreyserman", "d_michaelkim", "d_angelcabrera", "tb:270"]}, {"id": "demo-e31", "entry_name": "Worm Burners", "member_name": "Midge P.", "picks": ["d_collinmorikawa", "d_russellhenley", "d_akshaybhatia", "d_sergiogarcia", "d_ryangerard", "d_masonhowella", "tb:281"]}, {"id": "demo-e32", "entry_name": "Cart Path Only", "member_name": "Ron T.", "picks": ["d_collinmorikawa", "d_tommyfleetwood", "d_robertmacintyre", "d_dustinjohnson", "d_aaronrai", "d_jacksonherringtona", "tb:281"]}, {"id": "demo-e33", "entry_name": "Sunday Pin Seekers", "member_name": "Gail V.", "picks": ["d_cameronsmith", "d_patrickcantlay", "d_sungjaeim", "d_nicolaihojgaard", "d_ryangerard", "d_mikeweir", "tb:280"]}, {"id": "demo-e34", "entry_name": "Breakfast Ball", "member_name": "Art F.", "picks": ["d_cameronsmith", "d_russellhenley", "d_patrickreed", "d_ryanfox", "d_harryhall", "d_josemariaolazabal", "tb:266"]}, {"id": "demo-e35", "entry_name": "The Foot Wedge", "member_name": "Lois D.", "picks": ["d_scottiescheffler", "d_patrickcantlay", "d_cameronyoung", "d_maverickmcnealy", "d_jacobbridgeman", "d_josemariaolazabal", "tb:269"]}, {"id": "demo-e36", "entry_name": "Draw vs. Fade", "member_name": "Sid K.", "picks": ["d_scottiescheffler", "d_minwoolee", "d_jjspaun", "d_sergiogarcia", "d_aaronrai", "d_masonhowella", "tb:267"]}, {"id": "demo-e37", "entry_name": "Bogey Train", "member_name": "Flo W.", "picks": ["d_xanderschauffele", "d_samburns", "d_andrewnovak", "d_sergiogarcia", "d_adamscott", "d_marcopenge", "tb:273"]}, {"id": "demo-e38", "entry_name": "Chunk & Run", "member_name": "Gus E.", "picks": ["d_jonrahm", "d_shanelowry", "d_harrisenglish", "d_dustinjohnson", "d_nicoechavarria", "d_rasmushojgaard", "tb:287"]}, {"id": "demo-e39", "entry_name": "Lip Out Lounge", "member_name": "Vera S.", "picks": ["d_xanderschauffele", "d_maxhoma", "d_bengriffin", "d_nicktaylor", "d_adamscott", "d_mattmccarty", "tb:271"]}, {"id": "demo-e40", "entry_name": "The Shankopotamus", "member_name": "Mel B.", "picks": ["d_xanderschauffele", "d_tommyfleetwood", "d_seppstraka", "d_sergiogarcia", "d_garywoodland", "d_vijaysingh", "tb:280"]}, {"id": "demo-e41", "entry_name": "Tap-In Titans", "member_name": "Ada R.", "picks": ["d_viktorhovland", "d_minwoolee", "d_seppstraka", "d_sergiogarcia", "d_nicoechavarria", "d_mattmccarty", "tb:280"]}, {"id": "demo-e42", "entry_name": "Amateur Hour", "member_name": "Chet O.", "picks": ["d_scottiescheffler", "d_tommyfleetwood", "d_seppstraka", "d_coreyconners", "d_jacobbridgeman", "d_charlschwartzel", "tb:266"]}, {"id": "demo-e43", "entry_name": "Plugged Lie Posse", "member_name": "Ida M.", "picks": ["d_collinmorikawa", "d_tommyfleetwood", "d_cameronyoung", "d_justinrose", "d_samstevens", "d_ethanfanga", "tb:276"]}, {"id": "demo-e44", "entry_name": "Gimme Three", "member_name": "Bud L.", "picks": ["d_collinmorikawa", "d_hidekimatsuyama", "d_sungjaeim", "d_nicolaihojgaard", "d_adamscott", "d_mattmccarty", "tb:273"]}, {"id": "demo-e45", "entry_name": "The Flop Shots", "member_name": "Peg C.", "picks": ["d_cameronsmith", "d_tommyfleetwood", "d_bengriffin", "d_dustinjohnson", "d_haotongli", "d_mikeweir", "tb:288"]}, {"id": "demo-e46", "entry_name": "Stinger Kings", "member_name": "Roy H.", "picks": ["d_collinmorikawa", "d_russellhenley", "d_harrisenglish", "d_ryanfox", "d_jacobbridgeman", "d_briancampbell", "tb:272"]}, {"id": "demo-e47", "entry_name": "Divot Diggers", "member_name": "Elsie T.", "picks": ["d_brysondechambeau", "d_brookskoepka", "d_andrewnovak", "d_chrisgotterup", "d_adamscott", "d_fredcouples", "tb:275"]}, {"id": "demo-e48", "entry_name": "Up & Down Club", "member_name": "Moe D.", "picks": ["d_cameronsmith", "d_hidekimatsuyama", "d_andrewnovak", "d_jakeknapp", "d_michaelkim", "d_masonhowella", "tb:272"]}, {"id": "demo-e49", "entry_name": "Snowman Builders", "member_name": "Fay N.", "picks": ["d_ludvigaberg", "d_hidekimatsuyama", "d_harrisenglish", "d_ryanfox", "d_bubbawatson", "d_angelcabrera", "tb:279"]}, {"id": "demo-e50", "entry_name": "The Grinders", "member_name": "Abe W.", "picks": ["d_cameronsmith", "d_tyrrellhatton", "d_wyndhamclark", "d_maverickmcnealy", "d_siwookim", "d_johnnykeefer", "tb:266"]}, {"id": "demo-e51", "entry_name": "Fescue Rescue", "member_name": "June B.", "picks": ["d_jonrahm", "d_maxhoma", "d_keeganbradley", "d_chrisgotterup", "d_zachjohnson", "d_ethanfanga", "tb:281"]}, {"id": "demo-e52", "entry_name": "Cabbage Pounders", "member_name": "Ned S.", "picks": ["d_rorymcilroy", "d_hidekimatsuyama", "d_mattfitzpatrick", "d_aldrichpotgieter", "d_samstevens", "d_michaelbrennan", "tb:269"]}, {"id": "demo-e53", "entry_name": "Short Grass Gang", "member_name": "Olive K.", "picks": ["d_jonrahm", "d_jordanspieth", "d_bengriffin", "d_maverickmcnealy", "d_kristofferreitan", "d_mikeweir", "tb:267"]}, {"id": "demo-e54", "entry_name": "Punch Out Crew", "member_name": "Saul R.", "picks": ["d_viktorhovland", "d_minwoolee", "d_keeganbradley", "d_jakeknapp", "d_aaronrai", "d_mikeweir", "tb:275"]}, {"id": "demo-e55", "entry_name": "The Waggle", "member_name": "Tess F.", "picks": ["d_brysondechambeau", "d_jordanspieth", "d_wyndhamclark", "d_sergiogarcia", "d_nicoechavarria", "d_vijaysingh", "tb:270"]}, {"id": "demo-e56", "entry_name": "Bunker Party", "member_name": "Hal J.", "picks": ["d_xanderschauffele", "d_patrickcantlay", "d_andrewnovak", "d_coreyconners", "d_zachjohnson", "d_michaelbrennan", "tb:269"]}, {"id": "demo-e57", "entry_name": "Ham & Egg It", "member_name": "Rae Q.", "picks": ["d_xanderschauffele", "d_tommyfleetwood", "d_akshaybhatia", "d_jakeknapp", "d_ryangerard", "d_dannywillett", "tb:274"]}, {"id": "demo-e58", "entry_name": "Center Cut", "member_name": "Ken Y.", "picks": ["d_xanderschauffele", "d_patrickcantlay", "d_cameronyoung", "d_dustinjohnson", "d_samstevens", "d_rasmushojgaard", "tb:283"]}, {"id": "demo-e59", "entry_name": "Toe Hook City", "member_name": "Bea Z.", "picks": ["d_collinmorikawa", "d_hidekimatsuyama", "d_mattfitzpatrick", "d_nicolaihojgaard", "d_siwookim", "d_rasmushojgaard", "tb:272"]}, {"id": "demo-e60", "entry_name": "The Provisional", "member_name": "Duke A.", "picks": ["d_brysondechambeau", "d_maxhoma", "d_andrewnovak", "d_maxgreyserman", "d_garywoodland", "d_michaelbrennan", "tb:280"]}, {"id": "demo-e61", "entry_name": "Double Cross", "member_name": "Nell G.", "picks": ["d_rorymcilroy", "d_hidekimatsuyama", "d_akshaybhatia", "d_nicolaihojgaard", "d_siwookim", "d_briancampbell", "tb:278"]}, {"id": "demo-e62", "entry_name": "Hosel Rockets", "member_name": "Ike V.", "picks": ["d_brysondechambeau", "d_tyrrellhatton", "d_bengriffin", "d_nicolaihojgaard", "d_harryhall", "d_fredcouples", "tb:284"]}, {"id": "demo-e63", "entry_name": "Velvet Touch", "member_name": "Cora J.", "picks": ["d_justinthomas", "d_brookskoepka", "d_bengriffin", "d_dustinjohnson", "d_aaronrai", "d_mattmccarty", "tb:276"]}, {"id": "demo-e64", "entry_name": "Two Club Wind", "member_name": "Lem P.", "picks": ["d_jonrahm", "d_shanelowry", "d_jjspaun", "d_ryanfox", "d_haotongli", "d_briancampbell", "tb:268"]}, {"id": "demo-e65", "entry_name": "The Carry Crew", "member_name": "Ruth E.", "picks": ["d_collinmorikawa", "d_minwoolee", "d_seppstraka", "d_sergiogarcia", "d_siwookim", "d_fredcouples", "tb:288"]}, {"id": "demo-e66", "entry_name": "Soft Hands", "member_name": "Gil T.", "picks": ["d_justinthomas", "d_shanelowry", "d_wyndhamclark", "d_coreyconners", "d_haotongli", "d_jacksonherringtona", "tb:278"]}, {"id": "demo-e67", "entry_name": "Hardpan Heroes", "member_name": "Myra L.", "picks": ["d_justinthomas", "d_maxhoma", "d_keeganbradley", "d_chrisgotterup", "d_adamscott", "d_josemariaolazabal", "tb:272"]}, {"id": "demo-e68", "entry_name": "First Off The Tee", "member_name": "Ott B.", "picks": ["d_brysondechambeau", "d_minwoolee", "d_keeganbradley", "d_jakeknapp", "d_kurtkitayama", "d_charlschwartzel", "tb:266"]}, {"id": "demo-e69", "entry_name": "Dew Sweepers", "member_name": "Enid W.", "picks": ["d_justinthomas", "d_hidekimatsuyama", "d_jjspaun", "d_coreyconners", "d_aaronrai", "d_michaelbrennan", "tb:284"]}, {"id": "demo-e70", "entry_name": "The Back Tees", "member_name": "Rex M.", "picks": ["d_scottiescheffler", "d_shanelowry", "d_keeganbradley", "d_sergiogarcia", "d_siwookim", "d_fredcouples", "tb:274"]}, {"id": "demo-e71", "entry_name": "Range Rats", "member_name": "Cleo D.", "picks": ["d_viktorhovland", "d_hidekimatsuyama", "d_sungjaeim", "d_coreyconners", "d_adamscott", "d_masonhowella", "tb:270"]}, {"id": "demo-e72", "entry_name": "Iron Byron", "member_name": "Sal H.", "picks": ["d_viktorhovland", "d_maxhoma", "d_mattfitzpatrick", "d_chrisgotterup", "d_samivalimaki", "d_jacksonherringtona", "tb:271"]}, {"id": "demo-e73", "entry_name": "Pure Contact", "member_name": "Wanda R.", "picks": ["d_collinmorikawa", "d_russellhenley", "d_sungjaeim", "d_justinrose", "d_michaelkim", "d_marcopenge", "tb:273"]}, {"id": "demo-e74", "entry_name": "The Clubhouse Turn", "member_name": "Big Jim F.", "picks": ["d_xanderschauffele", "d_tyrrellhatton", "d_jjspaun", "d_maxgreyserman", "d_samivalimaki", "d_josemariaolazabal", "tb:280"]}, {"id": "demo-e75", "entry_name": "Scramble Squad", "member_name": "Etta S.", "picks": ["d_collinmorikawa", "d_minwoolee", "d_jjspaun", "d_coreyconners", "d_samivalimaki", "d_masonhowella", "tb:280"]}, {"id": "demo-e76", "entry_name": "Mud Ball Mafia", "member_name": "Newt C.", "picks": ["d_scottiescheffler", "d_minwoolee", "d_andrewnovak", "d_nicolaihojgaard", "d_michaelkim", "d_briancampbell", "tb:279"]}, {"id": "demo-e77", "entry_name": "Silky Tempo", "member_name": "Prue V.", "picks": ["d_justinthomas", "d_minwoolee", "d_andrewnovak", "d_ryanfox", "d_adamscott", "d_charlschwartzel", "tb:277"]}, {"id": "demo-e78", "entry_name": "Ball Above Feet", "member_name": "Otis K.", "picks": ["d_scottiescheffler", "d_tyrrellhatton", "d_mattfitzpatrick", "d_alexnoren", "d_zachjohnson", "d_mattmccarty", "tb:267"]}, {"id": "demo-e79", "entry_name": "The Nineteenth Men", "member_name": "Zelda M.", "picks": ["d_viktorhovland", "d_jordanspieth", "d_cameronyoung", "d_coreyconners", "d_kristofferreitan", "d_fredcouples", "tb:280"]}, {"id": "demo-e80", "entry_name": "Green Reading Society", "member_name": "Cliff B.", "picks": ["d_viktorhovland", "d_minwoolee", "d_jjspaun", "d_ryanfox", "d_michaelkim", "d_mikeweir", "tb:273"]}];

let TIERS = DEMO ? DEMO_TIERS : BASE_TIERS;
let PLAYER_INDEX = buildIndex(TIERS);

/* Rules are generated as plain bullets from the pool format, then freely
   editable in a single textbox — one line per bullet. */
function generateRules(s) {
  const ev = EVENTS_ALL.find((e) => e.id === s.eventId);
  if (ev && ev.teamEvent) {
    const lines = [
      "Pick six — three golfers from Team USA and three from the Internationals, before Thursday's first session.",
      "Match points — every match your golfer plays counts: team sessions (foursomes & four-ball) score Win 2 / Halve 1; Sunday singles score Win 4 / Halve 2.",
      "Cup call — pick the side that lifts the Cup for 8 bonus points (no bonus if it ends 15\u201315).",
      "Most total points wins the pool.",
    ];
    if (s.tiebreakerOn) lines.push("Tiebreaker — closest guess at the final Cup score (e.g., 17\u201313). Golf shop has final say.");
    lines.push(s.maxEntries === "unlimited" ? "Entries — no limit per member." : "Entries — up to " + s.maxEntries + " per member.");
  lines.push("All entries are final once submitted — pick carefully.");
    return lines;
  }
  const lines = [];
  lines.push(
    s.tierMethod === "open"
      ? "Pick six — any six golfers from the field, before Thursday's first tee."
      : s.tierMethod === "owgr6"
      ? "Pick six — one golfer from each ranking-based tier, before Thursday's first tee."
      : "Pick six — one golfer from each odds-based tier, before Thursday's first tee."
  );
  lines.push(
    s.scoring === "all6"
      ? "All six count — the sum of all six 72-hole scores to par is your total. Lowest total Sunday wins."
      : s.scoring === "daily"
      ? "Daily bests — your best scores each round count; lowest combined total Sunday wins."
      : s.scoring === "money"
      ? "Money list — your six golfers' combined official earnings; highest total Sunday wins."
      : "Best four count — your four lowest 72-hole scores to par make your total. Lowest total Sunday wins."
  );
  const swapTail = " (withdrawals too).";
  lines.push(
    s.cutRule === "score80"
      ? "Missed cuts are scored 80 for each weekend round" + swapTail
      : s.cutRule === "worst"
      ? "Missed cuts take the field's highest carded round for rounds 3 & 4" + swapTail
      : "Missed cuts score their 36-hole total +8 per weekend round" + swapTail
  );
  if (s.tiebreakerOn) lines.push("Tiebreaker — closest guess at the winning score, then a scorecard playoff of best pick vs. best pick. Golf shop has final say.");
  lines.push(s.maxEntries === "unlimited" ? "Entries — no limit per member." : "Entries — up to " + s.maxEntries + " per member.");
  lines.push("All entries are final once submitted — pick carefully.");
  return lines;
}

function poolScore(id, scores) {
  const s = scores[id];
  if (!s) return 99;
  if (s.total == null) return 99; /* WD before posting a total — worst score, like a missing pick */
  if (s.mc) return s.total + MC_PENALTY_PER_ROUND * 2;
  return s.total;
}

function fmtPar(n) {
  if (n === 0) return "E";
  return n > 0 ? `+${n}` : `${n}`;
}

function scoreEntry(picks, scores, scoring) {
  /* scoring comes from the POOL's saved format — never assume best-4 */
  const countN = scoring === "all6" ? 6 : 4;
  const detailed = picks.map((id) => ({ id, score: poolScore(id, scores) }));
  const sorted = [...detailed].sort((a, b) => a.score - b.score);
  const counted = new Set(sorted.slice(0, countN).map((d) => d.id));
  const total = sorted.slice(0, countN).reduce((sum, d) => sum + d.score, 0);
  return { total, counted };
}

function Crest() {
  return (
    <svg viewBox="0 0 64 64" className="crest" aria-hidden="true">
      <circle cx="32" cy="32" r="29" fill="none" stroke="currentColor" strokeWidth="2.5" />
      <circle cx="32" cy="32" r="24" fill="none" stroke="currentColor" strokeWidth="1" />
      <line x1="20" y1="44" x2="40" y2="18" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <line x1="44" y1="44" x2="24" y2="18" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M40 18 l9 3 -7 4 z" fill="currentColor" />
      <path d="M24 18 l-9 3 7 4 z" fill="currentColor" />
      <circle cx="32" cy="47" r="3" fill="currentColor" />
    </svg>
  );
}

function ClubMajorsPrototype() {
  const [view, setView] = useState("home");
  const [live, setLive] = useState(true);
  const [picks, setPicks] = useState({});
  const [cupCall, setCupCall] = useState(""); // team events: "usa" | "intl"
  const [entryName, setEntryName] = useState("");
  const [memberName, setMemberName] = useState("");
  const [tiebreak, setTiebreak] = useState("");        // guess at winning score to par (EOP-style)
  const [agree, setAgree] = useState(false);           // pool rules & terms agreement
  const [myEntryId, setMyEntryId] = useState(null);
  const [entries, setEntries] = useState(DEMO ? MOCK_ENTRIES : []); /* real site starts empty — sample entries live only on /demo */
  const [expanded, setExpanded] = useState(null);
  const [boardQuery, setBoardQuery] = useState("");
  const [themeId, setThemeId] = useState("pine");
  const [custom, setCustom] = useState({ primary: "#15382B", accent: "#D8B45A" });
  const [hexDraft, setHexDraft] = useState({ primary: "#15382B", accent: "#D8B45A" });
  const [logoUrl, setLogoUrl] = useState(null);
  const [noLogo, setNoLogo] = useState(true); /* name-only is the default — the placeholder crest is weaker than no crest; clubs opt back in via settings or by uploading a logo */
  const [logoBg, setLogoBg] = useState("transparent");  // transparent | white | cream | club
  const COLOR_BOARD = {
    primary: ["#1C1C1C", "#15382B", "#0A5137", "#1E4633", "#2F6B45", "#3A5A40", "#1C2C4F", "#1F3F66", "#14395C", "#20304F", "#23346E", "#17444A", "#5A1F26", "#4A2430", "#3D2B1F", "#2A3238"],
    accent: ["#EDEDED", "#D8B45A", "#C9A227", "#F2CE60", "#E4A95C", "#C68A3F", "#C3CCD3", "#D7E1EC", "#E58270", "#B04A3A", "#F0A0B8", "#A8D8DA", "#9CD3D5", "#E3CE8F", "#D49058", "#EFF3EC"],
  };
  const [tagline, setTagline] = useState("Est. 1921 · Member Pools");  // "" hides the line
  const [pros, setPros] = useState([]); // optional pool managers [{first, last}] — stored in clubs.theme
  const [inviteMsg, setInviteMsg] = useState("");   // co-admin invite flow status
  const [inviteLink, setInviteLink] = useState(""); // this club's admin invite link
  const [clubAdmins, setClubAdmins] = useState([]); // registered admins of this club
  const logoBgColor =
    logoBg === "white" ? "#FFFFFF" :
    logoBg === "cream" ? "#F7F2E4" :
    logoBg === "club" ? "var(--pine)" : "transparent";
  const [clubName, setClubName] = useState("Your Golf Club");

  /* Live SlashGolf scoring (2026 Open Championship) with simulated fallback */
  const [fieldVersion, setFieldVersion] = useState(0);
  const [fieldEventName, setFieldEventName] = useState("");
  useEffect(() => {
    if (DEMO) return;
    let dead = false;
    Promise.all([
      fetch("/.netlify/functions/leaderboard").then((r) => r.json()).catch(() => null),
      fetch("/.netlify/functions/leaderboard?view=odds").then((r) => r.json()).catch(() => null),
    ])
      .then(([d, oddsResp]) => {
        if (dead) return;
        const liveOdds = oddsResp && Array.isArray(oddsResp.odds) ? oddsResp.odds : [];
        /* preferred: the odds board IS the announced field for whatever event
           the books are pricing — build the picksheet from it ALONE. Joining
           it against the scoring feed produced a franken-field on transition
           weekends (odds roll to next week while scores finish this week),
           which collapsed tiers to 1-3 players. */
        let dyn = liveOdds.length >= 40 ? buildOddsTiers(liveOdds, liveOdds) : null;
        if (dyn && oddsResp.eventName) setFieldEventName(String(oddsResp.eventName));
        if (!dyn && d && Array.isArray(d.players) && d.players.length >= 60) {
          /* fallback: curated seeding (odds shown only for the curated event) */
          const curatedEvent = String(d.tournId) === "100" && String(d.year) === "2026";
          dyn = buildDynamicTiers(d.players, curatedEvent);
        }
        if (dyn && dyn !== BASE_TIERS) {
          TIERS = dyn;
          /* merge, never replace: entries picked from an earlier field must
             keep resolving on the leaderboard after the odds board rolls over */
          PLAYER_INDEX = Object.assign({}, PLAYER_INDEX, buildIndex(dyn));
          setFieldVersion((v) => v + 1);
        }
      })
      .catch(() => {});
    return () => { dead = true; };
  }, []);

  const { scores, lastMover, source, lastUpdated, staleAt, feedPar } = useLiveScores(live, PLAYER_INDEX);

  /* ----- auth & persistent data (Supabase) ----- */
  const [session, setSession] = useState(null);
  const justSignedInRef = useRef(false);  // true only right after a fresh sign-in (registration or login)
  const rulesTouchedRef = useRef(false);  // pro has hand-edited rules; stop auto-regenerating
  const [profile, setProfile] = useState(null);
  const [dbClub, setDbClub] = useState(null);
  const [dbPool, setDbPool] = useState(null);
  const [authEmail, setAuthEmail] = useState("");
  const [authState, setAuthState] = useState("idle");
  const [authPassword, setAuthPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(true);
  const [newPassword, setNewPassword] = useState("");
  const [recovery, setRecovery] = useState(false);   // arrived via password-reset link
  const [pwMsg, setPwMsg] = useState("");
  const [saveMsg, setSaveMsg] = useState("");
  const [editCode, setEditCode] = useState(null);      // {entryId, token} for this device
  const [showCode, setShowCode] = useState(null);      // code to display after submit
  const [locked, setLocked] = useState(false);         // past deadline?
  const [codeInput, setCodeInput] = useState("");      // manual edit-code entry
  const [golferQuery, setGolferQuery] = useState("");  // picksheet name filter
  const [pastResults, setPastResults] = useState([]);  // archived final leaderboards (admin)
  const [expandedResult, setExpandedResult] = useState(null);
  const [signupClub, setSignupClub] = useState("");    // self-serve club signup
  const [signupReferral, setSignupReferral] = useState(() => { try { return localStorage.getItem("cm-ref") || ""; } catch (e) { return ""; } });
  const [refPromo, setRefPromo] = useState(""); // referral promotion copy — empty until the owner launches one
  const [signupEmail, setSignupEmail] = useState("");
  const [signupState, setSignupState] = useState("idle");
  const role = profile ? profile.role : "guest";  // anonymous visitors are treated as members


  useEffect(() => {
    sb.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = sb.auth.onAuthStateChange((evt, sess) => {
      setSession(sess);
      if (evt === "SIGNED_IN") justSignedInRef.current = true;
      if (evt === "PASSWORD_RECOVERY") {
        setRecovery(true);
        setView("signin");
      }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  /* Public bootstrap — runs for everyone, signed in or not */
  function loadApp() {
    fetchApp().then(({ profile, club, pool, entries }) => {
      setProfile(profile || null);
      if (justSignedInRef.current) {
        justSignedInRef.current = false;
        /* very first sign-in on this device lands on Club Settings; every later one on Pool Setup */
        if (profile && (profile.role === "pro" || profile.role === "owner")) {
          const seenKey = "cm-admin-seen-" + profile.id;
          let seen = null; try { seen = localStorage.getItem(seenKey); } catch (e) {}
          if (seen) setView("setup");
          else { try { localStorage.setItem(seenKey, "1"); } catch (e) {} setView("settings"); }
        }
        else if (profile && profile.role === "pending") setView("signin");
      }
      if (club) {
        setDbClub(club);
        setClubName(club.name);
        if (club.theme && club.theme.themeId) setThemeId(club.theme.themeId);
        if (club.theme && club.theme.logoBg) setLogoBg(club.theme.logoBg);
        if (club.theme && typeof club.theme.noLogo === "boolean") setNoLogo(club.theme.noLogo);
        if (club.theme && typeof club.theme.tagline === "string") setTagline(club.theme.tagline);
        if (club.theme && Array.isArray(club.theme.pros)) setPros(club.theme.pros);
      }
      if (pool) {
        setDbPool(pool);
        const past = new Date(pool.deadline).getTime() < Date.now();
        setLocked(past);
        const saved = loadEditCode(pool.id);
        if (saved) {
          /* validate against the DB — a wiped/reset pool leaves stale codes behind */
          lookupByCode(saved.token).then((row) => {
            if (row && row.entry_id === saved.entryId) {
              setEditCode(saved);
              setMyEntryId(saved.entryId);
            } else {
              clearEditCode(pool.id);
            }
          }).catch(() => {});
        }
        const legacyRules = !pool.rules || !pool.rules.trim() ||
          pool.rules.indexOf("Ties split the affected places evenly") !== -1 ||
          (pool.rules.indexOf("\n") === -1 && pool.rules.length > 140);
        rulesTouchedRef.current = !legacyRules;
        setSetup((prev) => ({
          ...prev,
          entryFee: Number(pool.entry_fee),
          deadline: pool.deadline ? toLocalInput(pool.deadline) : prev.deadline,
          description: pool.description || prev.description,
          rules: pool.rules && pool.rules.trim() && pool.rules.indexOf("Ties split the affected places evenly") === -1 && !(pool.rules.indexOf("\n") === -1 && pool.rules.length > 140)
            ? pool.rules
            : prev.rules,
          payouts: pool.payouts || prev.payouts,
          tiebreakerOn: typeof pool.tiebreaker_on === "boolean" ? pool.tiebreaker_on : prev.tiebreakerOn,
          /* the saved format drives scoring and every member-facing format
             string — local defaults are only for pools that predate the columns */
          scoring: pool.scoring || prev.scoring,
          cutRule: pool.cut_rule || prev.cutRule,
          tierMethod: pool.tier_method || prev.tierMethod,
          maxEntries: pool.max_entries || prev.maxEntries,
          memberEdits: typeof pool.member_edits === "boolean" ? pool.member_edits : prev.memberEdits,
        }));
      }
      if (club || pool) setEntries(entries || []); else if (entries && entries.length) setEntries(entries);
      if (profile && (profile.role === "pro" || profile.role === "owner") && club) {
        sb.from("pool_results").select("*").eq("club_id", club.id).order("finalized_at", { ascending: false })
          .then(({ data }) => setPastResults(data || []));
      }
    }).catch(() => {});
  }
  useEffect(loadApp, [session]);

  /* Invite link flow: once signed in with ?invite=<token>, join the club as a pro */
  const inviteHandledRef = useRef(false);
  useEffect(() => {
    if (!INVITE || !session || inviteHandledRef.current) return;
    inviteHandledRef.current = true;
    sb.rpc("join_club_by_invite", { p_token: INVITE }).then(({ data, error }) => {
      if (error) {
        setInviteMsg("Could not join: " + String((error && error.message) || error));
      } else {
        try { window.history.replaceState({}, "", window.location.pathname); } catch (e) {}
        setInviteMsg("You're in — you now manage " + ((data && data.club) || "this club") + ".");
        loadApp();
        setView("settings");
      }
    });
  }, [session]);

  /* Self-serve onboarding: a fresh signup (role "pending", no invite link) gets
     a club created automatically and lands on Club Settings — no owner approval.
     Failures retry on a backoff and surface the real error — a silent "refresh
     the page" dead end once masked a missing RPC in production for days. */
  const selfServeRef = useRef(false);
  const [selfServeTry, setSelfServeTry] = useState(0);
  const [selfServeErr, setSelfServeErr] = useState("");
  const [signupNotice, setSignupNotice] = useState("");

  /* Someone used the signup form (club name stored locally) but this email
     already has a club: say so instead of silently ignoring the typed name. */
  useEffect(() => {
    if (DEMO || !session || !profile || !dbClub) return;
    if (!(profile.role === "pro" || profile.role === "owner")) return;
    let requested = "";
    try { requested = localStorage.getItem("cm-signup-club") || ""; } catch (e) {}
    if (!requested) return;
    try { localStorage.removeItem("cm-signup-club"); } catch (e) {}
    if (requested.trim() && requested.trim().toLowerCase() !== String(dbClub.name || "").trim().toLowerCase()) {
      setSignupNotice(
        "A club is already set up under this email address — you're signed in to “" + dbClub.name + "”, so “" +
        requested.trim() + "” wasn't created. You can rename your club any time here in Club Settings."
      );
    }
  }, [session, profile, dbClub]);
  useEffect(() => {
    if (DEMO || INVITE || !session || selfServeRef.current) return;
    if (!profile || profile.role !== "pending") return;
    selfServeRef.current = true;
    let nm = "", rb = "";
    try { nm = localStorage.getItem("cm-signup-club") || ""; rb = localStorage.getItem("cm-ref") || ""; } catch (e) {}
    sb.rpc("self_serve_signup", { p_club_name: nm, p_referred_by: rb || null }).then(({ error }) => {
      if (!error) {
        setSelfServeErr("");
        try { localStorage.removeItem("cm-signup-club"); } catch (e) {}
        loadApp();
        setView("settings");
      } else {
        selfServeRef.current = false;
        setSelfServeErr(String((error && error.message) || error));
        if (selfServeTry < 5) setTimeout(() => setSelfServeTry((t) => t + 1), 2000 * (selfServeTry + 1));
      }
    });
  }, [session, profile, selfServeTry]);

  /* Account tab: referral promo message (empty = program silent) */
  useEffect(() => {
    if (DEMO || view !== "signin" || !session) return;
    sb.from("platform_config").select("value").eq("key", "referral_promo").maybeSingle()
      .then(({ data }) => setRefPromo(data && data.value ? String(data.value) : ""))
      .catch(() => {});
  }, [view, session]);

  /* Club Settings: load the invite link + registered admins (admins only, never in demo) */
  useEffect(() => {
    if (DEMO || view !== "settings" || !dbClub || !(role === "pro" || role === "owner")) return;
    sb.from("club_invites").select("token").eq("club_id", dbClub.id).single()
      .then(({ data }) => { if (data && data.token) setInviteLink(window.location.origin + "/?invite=" + data.token); });
    sb.rpc("list_club_admins").then(({ data }) => setClubAdmins(data || []));
  }, [view, dbClub, role]);

  async function handleInviteSignup() {
    if (!authEmail.trim() || authPassword.length < 8) { setAuthState("badpass"); return; }
    setAuthState("signing");
    try { localStorage.setItem("cm-remember", rememberMe ? "1" : "0"); } catch (e) {}
    const { error } = await sb.auth.signUp({
      email: authEmail.trim(),
      password: authPassword,
      options: { emailRedirectTo: window.location.origin + "/?invite=" + INVITE },
    });
    setAuthState(error ? "error" : "sent");
  }

  async function handleSignIn() {
    if (!authEmail.trim()) return;
    setAuthState("sending");
    try { localStorage.setItem("cm-remember", rememberMe ? "1" : "0"); } catch (e) {}
    const { error } = await signInWithEmail(authEmail.trim());
    setAuthState(error ? "error" : "sent");
  }

  async function handlePasswordSignIn() {
    if (!authEmail.trim() || !authPassword) return;
    setAuthState("signing");
    try { localStorage.setItem("cm-remember", rememberMe ? "1" : "0"); } catch (e) {}
    const { error } = await signInWithPassword(authEmail.trim(), authPassword);
    if (error) {
      setAuthState("badpass");
    } else {
      setAuthState("idle");
      setAuthPassword("");
    }
  }

  async function handlePasswordReset() {
    if (!authEmail.trim()) { setAuthState("error"); return; }
    setAuthState("sending");
    const { error } = await sendPasswordReset(authEmail.trim());
    setAuthState(error ? "error" : "sent");
  }

  async function handleSignup() {
    if (!signupClub.trim() || !signupEmail.trim()) return;
    setSignupState("sending");
    try {
      try { localStorage.setItem("cm-signup-club", signupClub.trim()); } catch (e) {}
      await requestSignup(signupEmail.trim(), signupClub.trim(), signupReferral); setSignupState("sent");
    }
    catch (e) { setSignupState("error"); }
  }

  const memberLink = dbClub ? `${window.location.origin}/?club=${dbClub.slug}` : "";

  /* Event display derives from the club's own pool (pools.event_name); the
     EVENT constant is only the demo/scoring default. */
  const poolEvent = (() => {
    if (!dbPool || !dbPool.event_name) return null;
    const n = String(dbPool.event_name).toLowerCase();
    const match = EVENTS_ALL.find((e) => {
      const base = e.name.split(" · ")[0].toLowerCase();
      return n.includes(base) || base.includes(n);
    });
    return { name: dbPool.event_name, match: match || null };
  })();
  const teamMode = !!(poolEvent && poolEvent.match && poolEvent.match.teamEvent);
  const ACTIVE_TIERS = teamMode ? TEAM_TIERS : TIERS;
  /* Does the odds-board field belong to THIS pool's event? On transition
     weekends the books price next week's event while this pool may be for a
     different one — offering the wrong field for picking is worse than
     waiting. Token match on distinctive words; fail-open when ambiguous. */
  const fieldMatchesPool = (() => {
    if (DEMO || teamMode || !fieldEventName || !dbPool || !dbPool.event_name) return true;
    const stop = ["the", "championship", "classic", "open", "invitational", "tournament", "golf"];
    const toks = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w && stop.indexOf(w) === -1);
    const a = toks(fieldEventName), b = toks(dbPool.event_name);
    if (!a.length || !b.length) return true;
    return a.some((w) => b.indexOf(w) !== -1) || b.some((w) => a.indexOf(w) !== -1);
  })();
  /* The EVENT constant is only correct for the one hardcoded tournament — a
     club with no published pool must never inherit its branding. */
  const isPlatformEvent = !!(poolEvent && poolEvent.match && poolEvent.match.start === EVENT.deadlineISO.slice(0, 10));
  const heroTitle = (poolEvent ? poolEvent.name : (dbClub && dbClub.name) || "Members'") + " Pool";
  const heroEyebrow = DEMO
    ? "Major Championship \u00b7 April 9\u201312, 2026"
    : isPlatformEvent
    ? EVENT.eyebrow
    : poolEvent && poolEvent.match
    ? PRICING_LABEL[poolEvent.match.type] + " · " + eventDates(poolEvent.match)
    : "Members' Pool";
  const heroVenue = isPlatformEvent
    ? EVENT.venue + " · " + EVENT.location + " · " + EVENT.dates
    : DEMO
    ? "Augusta National Golf Club \u00b7 Augusta, GA"
    : poolEvent && poolEvent.match
    ? poolEvent.match.name.split(" · ").slice(1).join(" · ")
    : "";
  const boardTitle = (poolEvent ? poolEvent.name : (dbClub && dbClub.name) || "Members'") + " Pool";
  /* custom rules from the pool, one bullet per line; legacy paragraph-style
     rules (pre-bullet era) fall back to the standard bullets */
  const customRules =
    dbPool && dbPool.rules && dbPool.rules.indexOf("Ties split the affected places evenly") === -1
      ? dbPool.rules.split(/\n+|\\n|(?=\u2022)/).map((l) => l.replace(/^[\u2022\u00b7\-\s]+/, "").trim()).filter(Boolean)
      : null;

  /* prefill picks + names from an edit code (works cross-device) */
  async function beginEditByCode(token) {
    if (!token) return;
    if (!memberEditsAllowed) { setSaveMsg("Entries in this pool are final once submitted — see the pro shop for changes."); return; }
    try {
      const row = await lookupByCode(token.trim());
      if (!row) { setSaveMsg("That code doesn't match any entry."); return; }
      if (row.locked) { setSaveMsg("That entry's pool is already locked."); return; }
      const byTier = {};
      const corePicks = (row.picks || []).filter((x) => !isTbEl(x) && !isTeamEl(x) && !isTbsEl(x));
      ACTIVE_TIERS.forEach((t, i) => { byTier[t.label] = corePicks[i]; });
      const teamEl = (row.picks || []).find(isTeamEl);
      setCupCall(teamEl ? teamEl.slice(5) : "");
      const tbsEl = (row.picks || []).find(isTbsEl);
      if (tbsEl) setTiebreak(tbsEl.slice(4));
      setPicks(byTier);
      setEntryName(row.entry_name);
      setMemberName(row.member_name);
      const tbEl = (row.picks || []).find(isTbEl);
      setTiebreak(tbEl && !isNaN(Number(tbEl.slice(3))) ? String(Number(tbEl.slice(3))) : "");
      setEditCode({ entryId: row.entry_id, token: token.trim() });
      setMyEntryId(row.entry_id);
      if (dbPool) saveEditCode(dbPool.id, row.entry_id, token.trim());
      setCodeInput("");
      setSaveMsg("");
      setView("picks");
    } catch (e) { setSaveMsg("Could not load that code: " + (e.message || e)); }
  }

  const TABS = [
    { id: "home", label: "Pool Home", roles: ["guest", "member", "pending", "pro", "owner"] },
    { id: "picks", label: "Picksheet", roles: ["guest", "member", "pending", "pro", "owner"] },
    { id: "board", label: "Leaderboard", roles: ["guest", "member", "pending", "pro", "owner"] },
    { id: "setup", label: "Pool Setup", roles: ["pro", "owner"] },
    { id: "settings", label: "Club Settings", roles: ["pro", "owner"] },
    { id: "signin", label: session ? "Account" : "Club Admin", roles: ["guest", "member", "pending", "pro", "owner"] },
  ].filter((t) => t.roles.includes(role) && !(DEMO && t.id === "signin")); /* demo shows the pure member view — no account tab */

  const theme =
    themeId === "custom"
      ? deriveCustomTheme(custom.primary, custom.accent)
      : THEMES.find((t) => t.id === themeId) || THEMES[0];

  function setCustomColor(key, value) {
    setHexDraft((d) => ({ ...d, [key]: value }));
    if (hexToRgb(value)) {
      const normalized = value.startsWith("#") ? value : "#" + value;
      setCustom((c) => ({ ...c, [key]: normalized }));
      setThemeId("custom");
    }
  }

  /* ----- Pool Setup (club pro admin) ----- */
  const [setup, setSetup] = useState({
    eventId: EVENTS.length ? EVENTS[0].id : "open2026",
    entryFee: 50,
    deadline: toLocalInput(defaultDeadline(EVENTS[0])),
    description:
      "Open to all members and their guests. All payouts are made in club pro shop credit. Winners announced Sunday evening.",
    rules: "",
    scoring: "best4",
    tierMethod: "odds6",
    tiebreakerOn: true,
    cutRule: "plus8",
    maxEntries: "2",
    memberEdits: true, /* members may edit/delete their entry until the deadline */
    adminFeeOn: false,
    adminFeeType: "flat",
    adminFeeVal: 100,
    payouts: [60, 30, 10],
    billing: "single",
    published: false,
  });

  /* No published pool → the member-facing tabs don't exist yet, for ANYONE.
     A draft row created on the way to checkout does not count — only a pool
     that is actually paid-and-published (dbPool.published, or this session
     just published one). */
  const hasPublishedPool = !!(dbPool && dbPool.published) || setup.published || pastResults.length > 0;
  const isAdminRole = role === "pro" || role === "owner";
  const guestNoPool = !DEMO && !isAdminRole && !hasPublishedPool;
  /* Anonymous visitor, no club link → the ClubMajors front door (the buyer's
     page), not a club shell. Invite links keep their sign-in flow. */
  const platformLanding = !DEMO && !INVITE && !session && !dbClub;
  /* Jul 2026: member editing DISABLED product-wide — entries are final once
     submitted. To resurrect the feature, restore:
     DEMO || !dbPool || dbPool.member_edits !== false */
  const memberEditsAllowed = false;
  const NAV_TABS = platformLanding
    ? [{ id: "landing", label: "Overview", roles: ["guest"] }, { id: "signin", label: "Club Admin", roles: ["guest"] }]
    : !DEMO && !hasPublishedPool
    ? TABS.filter((t) => (isAdminRole ? !["home", "picks", "board"].includes(t.id) : !["picks", "board"].includes(t.id)))
    : TABS;

  useEffect(() => {
    if (platformLanding && ["home", "picks", "board"].includes(view)) setView("landing");
    if (!platformLanding && view === "landing") setView("home");
  }, [platformLanding, view]);

  /* if anyone lands on a hidden member view (e.g. page reload or deep link),
     route them somewhere real: admins to Pool Setup, guests to Pool Home
     (which shows the no-active-pool notice) */
  useEffect(() => {
    if (DEMO || hasPublishedPool) return;
    if (isAdminRole && ["home", "picks", "board"].includes(view)) setView("setup");
    if (!isAdminRole && ["picks", "board"].includes(view)) setView("home");
  }, [role, hasPublishedPool, view]);

  /* rules follow the format until the pro edits them by hand */
  useEffect(() => {
    if (rulesTouchedRef.current) return;
    setSetup((s) => ({ ...s, rules: generateRules(s).map((l) => "\u2022 " + l).join("\n") }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setup.tierMethod, setup.scoring, setup.cutRule, setup.tiebreakerOn, setup.maxEntries, setup.memberEdits, setup.eventId]);

  /* the saved event can age out of the dropdown (auto-hidden after it ends);
     roll forward to the next event and suggest its deadline — never keep a
     stale deadline from a finished tournament */
  useEffect(() => {
    if (!EVENTS.length) return;
    if (!EVENTS.find((e) => e.id === setup.eventId)) {
      const next = EVENTS[0];
      setSetup((s) => ({ ...s, eventId: next.id, deadline: toLocalInput(defaultDeadline(next)) }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setup.eventId]);

  const selectedEvent = EVENTS.find((e) => e.id === setup.eventId) || EVENTS[0];
  const eventFee = PLATFORM_PRICING[selectedEvent.type];
  const payoutSum = setup.payouts.reduce((a, b) => a + (Number(b) || 0), 0);
  /* Platform fee already covered? Single-event pools carry paid=true once the
     Stripe webhook lands; annual/season passes cover every pool while active.
     Editing a paid pool must never route the pro through checkout again. */
  const passActive = !!(dbClub && (dbClub.plan === "annual" || dbClub.plan === "season2026") && dbClub.paid_until && new Date(dbClub.paid_until).getTime() > Date.now());
  const feeCovered = passActive || !!(dbPool && dbPool.paid && dbPool.event_name === selectedEvent.name.split(" · ")[0]);
  const ORDINALS = ["1st", "2nd", "3rd", "4th", "5th", "6th"];
  const examplePurse = 40 * (Number(setup.entryFee) || 0);
  const exampleFee = setup.adminFeeOn
    ? setup.adminFeeType === "flat"
      ? Math.min(Number(setup.adminFeeVal) || 0, examplePurse)
      : Math.round((examplePurse * (Number(setup.adminFeeVal) || 0)) / 100)
    : 0;
  const examplePot = examplePurse - exampleFee;

  function setPayout(i, val) {
    setSetup((s) => {
      const payouts = [...s.payouts];
      payouts[i] = val === "" ? "" : Math.max(0, Math.min(100, Number(val)));
      return { ...s, payouts };
    });
  }

  function handleLogoUpload(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setLogoUrl(reader.result);
    reader.readAsDataURL(file);
    e.target.value = "";
  }

  const pickCount = Object.keys(picks).length;
  const tbValid = !setup.tiebreakerOn || (teamMode
    ? /^\d{1,2}(\.5)?\s*[-\u2013]\s*\d{1,2}(\.5)?$/.test(tiebreak.trim())
    : tiebreak.trim() !== "" && !isNaN(Number(tiebreak)));
  const nameTaken =
    !editCode &&
    entryName.trim() !== "" &&
    entries.some((x) => (x.entry || "").trim().toLowerCase() === entryName.trim().toLowerCase());
  /* Course par must be CERTAIN before we show rounds as +/-.
     Certainty means: every player with final numbers solves
     (strokes − to-par total) / rounds to the SAME integer par (an exact
     identity, not an estimate), independently confirmed by each finisher's
     "today" value equaling their last round minus that par. Vendor-reported
     par, when present, must agree too. Any disagreement anywhere → raw
     strokes are shown instead. Unanimity or nothing. */
  const coursePar = (() => {
    const cands = new Set();
    let checked = 0, todayChecked = 0, todayOk = 0;
    Object.values(scores).forEach((s) => {
      if (!s || !s.rounds || !s.rounds.length || s.total == null) return;
      const done = s.mc ? s.rounds.length : s.thru >= 18 ? s.rounds.length : 0;
      if (!done) return;
      const sum = s.rounds.slice(0, done).reduce((a, b) => a + b, 0);
      const par = (sum - s.total) / done;
      /* degenerate rows (mid-round WDs, partial data) can't solve cleanly —
         they're skipped; only CONFLICTING clean solves disqualify the par */
      if (!Number.isInteger(par) || par < 66 || par > 74) return;
      cands.add(par);
      checked++;
      if (!s.mc && typeof s.today === "number") {
        todayChecked++;
        if (s.rounds[s.rounds.length - 1] - par === s.today) todayOk++;
      }
    });
    if (cands.size > 1) return null;
    if (cands.size === 0) return typeof feedPar === "number" ? feedPar : null;
    const par = [...cands][0];
    if (checked < 10) return typeof feedPar === "number" && feedPar === par ? par : null;
    if (typeof feedPar === "number" && feedPar !== par) return null;
    if (todayChecked >= 5 && todayOk / todayChecked < 0.95) return null;
    return par;
  })();

  const winnerScore = (() => {
    const vals = Object.values(scores).filter((s) => s && !s.mc && typeof s.total === "number").map((s) => s.total);
    return vals.length ? Math.min(...vals) : null;
  })();
  function cmpEntries(a, b) {
    if (a.total !== b.total) return a.total - b.total;
    /* 1. closest tiebreaker guess to the winning golfer's score (higher or lower) */
    if (winnerScore !== null) {
      const da = a.tb == null ? Infinity : Math.abs(a.tb - winnerScore);
      const db = b.tb == null ? Infinity : Math.abs(b.tb - winnerScore);
      if (da !== db) return da - db;
    }
    /* 2. scorecard playoff — best pick vs best pick until the tie breaks */
    const sa = a.picks.map((id) => poolScore(id, scores)).sort((x, y) => x - y);
    const sb = b.picks.map((id) => poolScore(id, scores)).sort((x, y) => x - y);
    for (let i = 0; i < Math.min(sa.length, sb.length); i++) if (sa[i] !== sb[i]) return sa[i] - sb[i];
    return 0;
  }
  /* Blank board, never the 99-stroke missing-pick penalty (the "+396" bug),
     when scoring hasn't genuinely begun for THIS pool: either no feed has any
     live numbers yet, or the feed is still on a different event and doesn't
     cover the players these entries actually picked. */
  const anyLiveScores = Object.values(scores).some((s) => s && (s.mc || (s.thru || 0) > 0 || (s.total != null && s.total !== 0)));
  const pickedIds = entries.flatMap((e) => e.picks || []);
  const coveredPicks = pickedIds.filter((id) => scores[id]).length;
  const feedCoversPool = pickedIds.length === 0 || coveredPicks / pickedIds.length >= 0.3;
  const preTee = !DEMO && (!anyLiveScores || !feedCoversPool);
  const ranked = entries
    .map((e) => ({ ...e, ...(preTee ? { total: 0, counted: new Set(e.picks) } : scoreEntry(e.picks, scores, setup.scoring)) }))
    .sort(cmpEntries)
    .map((e, i, arr) => ({
      ...e,
      pos: i > 0 && arr[i - 1].total === e.total ? null : i + 1,
    }));
  // carry tied positions forward as T-notation
  let lastPos = 1;
  const board = ranked.map((e, i) => {
    if (e.pos !== null) lastPos = e.pos;
    const tied = ranked.filter((x) => x.total === e.total).length > 1;
    return { ...e, posLabel: `${tied ? "T" : ""}${lastPos}` };
  });

  async function openBillingPortal() {
    try {
      const { data } = await sb.auth.getSession();
      const token = data && data.session && data.session.access_token;
      if (!token) { alert("Sign in first."); return; }
      const r = await fetch("/.netlify/functions/billing-portal", { headers: { Authorization: "Bearer " + token } });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "portal unavailable");
      window.open(j.url, "_blank", "noopener");
    } catch (e) {
      alert("Could not open the billing portal: " + ((e && e.message) || e));
    }
  }

  async function deleteMyEntry() {
    if (!dbPool || !editCode) return;
    if (!window.confirm("Delete your entry from this pool? This can't be undone.")) return;
    try {
      const { error } = await sb.rpc("delete_entry", { p_edit_token: editCode.token });
      if (error) throw error;
      clearEditCode(dbPool.id);
      setEditCode(null);
      setMyEntryId(null);
      setPicks({});
      setEntryName("");
      setMemberName("");
      setTiebreak("");
      setEntries(await refetchEntries(dbPool.id));
      setSaveMsg("Your entry was deleted. You can submit a fresh one any time before the deadline.");
    } catch (e) {
      alert("Could not delete your entry: " + ((e && e.message) || e));
    }
  }

  async function submitPicks() {
    if (pickCount < ACTIVE_TIERS.length || !tbValid || nameTaken || !agree || (teamMode && !cupCall)) return;
    if (!editCode && !window.confirm("Entries are final once submitted — picks can't be changed or deleted afterward. Submit now?")) return;
    const picksArr = ACTIVE_TIERS.map((t) => picks[t.label]);
    if (teamMode) {
      picksArr.push("team:" + cupCall);
      if (setup.tiebreakerOn && tiebreak.trim()) picksArr.push("tbs:" + tiebreak.trim());
    }
    const tbNum = Number(tiebreak);
    /* tiebreaker rides along as a 7th picks element ("tb:-12"); if the DB
       rejects the extra element we quietly fall back to plain 6 picks */
    const picksPayload =
      setup.tiebreakerOn && !isNaN(tbNum) && tiebreak.trim() !== ""
        ? [...picksArr, "tb:" + tbNum]
        : picksArr;
    const nm = memberName.trim() || "Member";
    const en = entryName.trim() || "My Entry";

    if (dbPool) {
      try {
        if (editCode) {
          // editing an existing entry
          let fresh;
          try {
            fresh = await editEntry(dbPool.id, editCode.token, en, nm, picksPayload);
          } catch (err) {
            fresh = await editEntry(dbPool.id, editCode.token, en, nm, picksArr);
          }
          setEntries(fresh);
          setMyEntryId(editCode.entryId);
          setExpanded(editCode.entryId);
          setSaveMsg("");
          setView("board");
        } else {
          let res;
          try {
            res = await submitEntry(dbPool.id, en, nm, picksPayload);
          } catch (err) {
            res = await submitEntry(dbPool.id, en, nm, picksArr);
          }
          const { entries: fresh, entryId, token } = res;
          setEntries(fresh);
          setEditCode({ entryId, token });
          setMyEntryId(entryId);
          setExpanded(entryId);
          setShowCode(token);   // surface the edit code once
          setView("board");
        }
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (editCode && /not found|bad code/i.test(msg)) {
          clearEditCode(dbPool.id);
          setEditCode(null);
          setMyEntryId(null);
          alert("Your saved entry no longer exists (the pool may have been reset). Your picks are still on the sheet — press Submit again to enter fresh.");
        } else {
          alert("Could not save your entry: " + msg);
        }
      }
      return;
    }

    // offline fallback (no DB)
    const id = "you-" + Date.now();
    setEntries((prev) => [...prev, { id, entry: en, member: nm, picks: picksArr, tb: isNaN(tbNum) ? null : tbNum }]);
    setMyEntryId(id);
    setExpanded(id);
    setView("board");
  }

  return (
    <div
      className="cm-root"
      style={{
        "--pine": theme.pine,
        "--pine-deep": theme.pineDeep,
        "--board": theme.board,
        "--board-row": theme.boardRow,
        "--brass": theme.brass,
        "--brass-bright": theme.brassBright,
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Archivo+Black&family=IBM+Plex+Mono:wght@400;500;600&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600;8..60,700&display=swap');

        .cm-root {
          --pine: #15382B;
          --pine-deep: #0D261D;
          --board: #0F3024;
          --board-row: #123828;
          --cream: #F7F2E4;
          --paper-line: #D9CFAF;
          --brass: #B98F2F;
          --brass-bright: #D8B45A;
          --ink: #20261E;
          --under: #E8503F;
          --under-bright: #FF6B57;
          --muted: #6E7468;
          font-family: 'Source Serif 4', Georgia, serif;
          color: var(--ink);
          background: var(--cream);
          min-height: 100vh;
          -webkit-font-smoothing: antialiased;
        }
        .cm-root * { box-sizing: border-box; }
        .mono { font-family: 'IBM Plex Mono', monospace; }
        .display { font-family: 'Source Serif 4', Georgia, serif; font-weight: 600; letter-spacing: 0.06em; }

        /* ---------- demo banner ---------- */
        .demo-band { position: sticky; top: 0; z-index: 120; background: repeating-linear-gradient(135deg, #7A1F1F 0 24px, #6A1919 24px 48px); color: #F7F2E4; font-family: 'IBM Plex Mono', monospace; font-size: 11.5px; letter-spacing: 0.14em; text-transform: uppercase; text-align: center; padding: 9px 14px; line-height: 1.6; }
        .demo-band b { color: #E9C46A; }
        .demo-band a { color: #E9C46A; text-decoration: underline; }
        /* ---------- masthead ---------- */
        .masthead {
          background: var(--pine);
          color: var(--cream);
          border-bottom: 3px solid var(--brass);
          padding: 18px 24px 0;
        }
        .masthead-inner { max-width: 920px; margin: 0 auto; }
        .club-line { display: flex; align-items: center; gap: 14px; }
        .crest { width: 44px; height: 44px; color: var(--brass-bright); flex-shrink: 0; }
        .club-name { font-size: 23px; font-weight: 600; line-height: 1.15; }
        .club-sub { font-size: 12.5px; letter-spacing: 0.22em; text-transform: uppercase; color: var(--brass-bright); margin-top: 4px; font-family: 'IBM Plex Mono', monospace; }
        .tabs { display: flex; gap: 4px; margin-top: 18px; flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; }
        .tab {
          appearance: none; border: none; cursor: pointer;
          background: transparent; color: rgba(247,242,228,0.85);
          font-family: 'IBM Plex Mono', monospace; font-size: 13px; font-weight: 700; letter-spacing: 0.06em;
          text-transform: uppercase; padding: 10px 12px 12px; white-space: nowrap; flex-shrink: 0;
          border-bottom: 3px solid transparent; margin-bottom: -3px;
        }
        .tab:hover { color: var(--cream); }
        .tab.active { color: var(--cream); border-bottom-color: var(--brass-bright); }
        .tab:focus-visible { outline: 2px solid var(--brass-bright); outline-offset: -2px; }

        .shell { max-width: 920px; margin: 0 auto; padding: 28px 24px 56px; display: flex; flex-direction: column; min-height: calc(100vh - 170px); }
        .shell > footer.powered { margin-top: auto; padding-top: 160px; }

        /* ---------- pool home ---------- */
        .champ-banner {
          text-align: center; padding: 30px 16px 26px;
          border: 1px solid var(--paper-line); border-top: 4px solid var(--pine);
          background: #FCF9EF;
        }
        .champ-eyebrow { font-family: 'IBM Plex Mono', monospace; font-size: 11px; letter-spacing: 0.3em; color: var(--brass); text-transform: uppercase; }
        .champ-title { font-size: clamp(26px, 5vw, 40px); font-weight: 600; margin: 10px 0 6px; color: var(--pine); }
        .champ-venue { font-size: 15px; color: var(--muted); font-style: italic; }
        .facts {
          display: grid; grid-template-columns: repeat(4, 1fr);
          border: 1px solid var(--paper-line); border-top: none; background: #FCF9EF;
        }
        .fact { padding: 16px 12px; text-align: center; border-left: 1px solid var(--paper-line); }
        .fact:nth-child(4n+1) { border-left: none; }
        .fact:nth-child(n+5) { border-top: 1px solid var(--paper-line); }
        .fact:first-child { border-left: none; }
        .fact-k { font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--muted); }
        .fact-v { font-size: 17px; font-weight: 600; margin-top: 6px; color: var(--pine); }
        .home-body { margin-top: 26px; display: grid; grid-template-columns: 1.4fr 1fr; gap: 22px; }
        .rules h3, .payout h3 { font-family: 'Source Serif 4', Georgia, serif; font-weight: 700; font-size: 13px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--pine); border-bottom: 2px solid var(--brass); display: inline-block; padding-bottom: 4px; margin: 0 0 12px; }
        .rules p { font-size: 15px; line-height: 1.65; margin: 0 0 10px; }
        .rules ul { margin: 0; padding-left: 19px; }
        .rules li { font-size: 14.5px; line-height: 1.6; margin: 0 0 8px; }
        .payout-row { display: flex; justify-content: space-between; font-size: 15px; padding: 9px 2px; border-bottom: 1px dotted var(--paper-line); }
        .payout-row .mono { color: var(--pine); font-weight: 600; }
        .cta-row { display: flex; gap: 12px; margin-top: 30px; flex-wrap: wrap; }
        .btn {
          appearance: none; cursor: pointer; font-family: 'IBM Plex Mono', monospace;
          font-size: 13px; letter-spacing: 0.1em; text-transform: uppercase;
          padding: 14px 26px; border: 1.5px solid var(--pine);
        }
        .btn-primary { background: var(--pine); color: var(--cream); }
        .btn-primary:hover { background: var(--pine-deep); }
        .btn-ghost { background: transparent; color: var(--pine); }
        .btn-ghost:hover { background: rgba(21,56,43,0.07); }
        .btn:focus-visible { outline: 2px solid var(--brass); outline-offset: 2px; }
        .pro-note { margin-top: 26px; font-size: 13px; color: var(--muted); border-left: 3px solid var(--brass); padding: 6px 0 6px 14px; line-height: 1.6; }

        /* ---------- picksheet ---------- */
        .sheet-head { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 8px; margin-bottom: 6px; }
        .sheet-title { font-family: 'Source Serif 4', Georgia, serif; font-weight: 600; font-size: 20px; color: var(--pine); letter-spacing: 0.06em; }
        .sheet-deadline { font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: var(--under); }
        .sheet-sub { font-size: 14px; color: var(--muted); margin-bottom: 22px; }
        .tier-block { border: 1px solid var(--paper-line); background: #FCF9EF; margin-bottom: 18px; }
        .tier-head { display: flex; align-items: baseline; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--paper-line); }
        .tier-roman { font-family: 'Source Serif 4', Georgia, serif; font-size: 18px; font-weight: 700; color: var(--brass); width: 34px; }
        .tier-note { font-family: 'IBM Plex Mono', monospace; font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); }
        .tier-grid { display: grid; grid-template-columns: 1fr 1fr; }
        .pick-card {
          appearance: none; border: none; background: transparent; cursor: pointer;
          display: flex; justify-content: space-between; align-items: center; gap: 10px;
          padding: 14px 16px; text-align: left; font-family: inherit; font-size: 15px;
          border-top: 1px solid var(--paper-line); border-left: 1px solid var(--paper-line);
          color: var(--ink);
        }
        .pick-card:nth-child(-n+2) { border-top: none; }
        .pick-card:nth-child(odd) { border-left: none; }
        .pick-card:hover { background: rgba(185,143,47,0.08); }
        .pick-card.selected { background: var(--pine); color: var(--cream); }
        .pick-card.selected .odds { color: var(--brass-bright); }
        .pick-card:focus-visible { outline: 2px solid var(--brass); outline-offset: -2px; }
        .pick-name { font-weight: 600; }
        .pick-note { display: block; font-size: 11.5px; font-style: italic; font-weight: 400; opacity: 0.75; margin-top: 2px; }
        .odds { font-family: 'IBM Plex Mono', monospace; font-size: 13px; color: var(--muted); }
        .submit-bar {
          position: sticky; bottom: 0; background: var(--cream);
          border-top: 2px solid var(--pine); padding: 14px 0;
          display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
        }
        .submit-bar input {
          font-family: inherit; font-size: 14px; padding: 11px 12px;
          border: 1px solid var(--paper-line); background: #FFF; color: var(--ink);
          flex: 1 1 160px; min-width: 0;
        }
        .submit-bar input:focus-visible { outline: 2px solid var(--brass); }
        .count { font-family: 'IBM Plex Mono', monospace; font-size: 13px; color: var(--pine); white-space: nowrap; }
        .btn[disabled] { opacity: 0.4; cursor: not-allowed; }

        /* ---------- scoreboard (signature) ---------- */
        .board-wrap { background: var(--board); border: 1px solid var(--pine-deep); box-shadow: 0 1px 0 var(--brass) inset, 0 -1px 0 var(--brass) inset; }
        .board-title {
          display: flex; justify-content: space-between; align-items: center; gap: 10px;
          padding: 14px 18px; border-bottom: 1px solid rgba(216,180,90,0.4);
          color: var(--cream);
        }
        .board-title .display { font-size: 14px; color: var(--brass-bright); }
        .live-chip { display: inline-flex; align-items: center; gap: 8px; font-family: 'IBM Plex Mono', monospace; font-size: 11px; letter-spacing: 0.18em; color: var(--cream); }
        .live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--under-bright); }
        @media (prefers-reduced-motion: no-preference) {
          .live-dot.on { animation: pulse 1.6s ease-in-out infinite; }
          @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.25; } }
        }
        .live-toggle { appearance: none; cursor: pointer; background: transparent; border: 1px solid rgba(247,242,228,0.35); color: var(--cream); font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: 0.12em; padding: 5px 10px; text-transform: uppercase; }
        .live-toggle:hover { border-color: var(--brass-bright); }
        .board-cols { display: grid; grid-template-columns: 56px 1fr 86px 34px; padding: 8px 18px; font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: 0.2em; text-transform: uppercase; color: rgba(247,242,228,0.5); border-bottom: 1px solid rgba(216,180,90,0.25); }
        .board-row { border-bottom: 1px solid rgba(216,180,90,0.18); }
        .row-main {
          appearance: none; border: none; background: transparent; width: 100%;
          display: grid; grid-template-columns: 56px 1fr 86px 34px; align-items: center;
          padding: 13px 18px; cursor: pointer; text-align: left; font-family: inherit;
          color: var(--cream);
        }
        .row-main:hover { background: var(--board-row); }
        .row-main:focus-visible { outline: 2px solid var(--brass-bright); outline-offset: -2px; }
        .row-pos { font-family: 'IBM Plex Mono', monospace; font-size: 14px; color: var(--brass-bright); }
        .row-entry { font-size: 15.5px; font-weight: 600; }
        .row-member { display: block; font-size: 12px; font-weight: 400; color: rgba(247,242,228,0.55); font-style: italic; margin-top: 1px; }
        .row-total { font-family: 'IBM Plex Mono', monospace; font-size: 17px; font-weight: 600; text-align: right; color: var(--cream); }
        .row-total.under { color: var(--under-bright); }
        .chev { text-align: right; color: rgba(247,242,228,0.5); font-size: 12px; }
        .mine .row-entry::after { content: 'YOU'; font-family: 'IBM Plex Mono', monospace; font-size: 9px; letter-spacing: 0.14em; color: var(--pine-deep); background: var(--brass-bright); padding: 2px 6px; margin-left: 9px; vertical-align: 2px; }
        .row-detail { background: var(--pine-deep); padding: 6px 18px 14px; }
        .pick-line { display: grid; grid-template-columns: 30px 1fr 112px 72px; align-items: center; padding: 7px 0; border-bottom: 1px dotted rgba(216,180,90,0.2); color: var(--cream); font-size: 14px; }
        .pick-line:last-child { border-bottom: none; }
        .pick-line.dropped { opacity: 0.38; }
        .pl-tier { font-family: 'Source Serif 4', Georgia, serif; font-weight: 600; font-size: 12px; color: var(--brass-bright); }
        .pl-score { font-family: 'IBM Plex Mono', monospace; text-align: right; }
        .pl-score.under { color: var(--under-bright); }
        .pl-thru { font-family: 'IBM Plex Mono', monospace; font-size: 11.5px; text-align: right; color: rgba(247,242,228,0.55); padding-left: 14px; }
        .drop-tag { font-family: 'IBM Plex Mono', monospace; font-size: 9px; letter-spacing: 0.12em; }
        .board-foot { padding: 10px 18px 14px; font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; letter-spacing: 0.06em; color: rgba(247,242,228,0.45); line-height: 1.7; }

        /* ---------- footer ---------- */
        .landing-h1 { margin: 0; font-family: 'Source Serif 4', Georgia, serif; font-weight: 700; font-size: 44px; line-height: 1.08; letter-spacing: -0.015em; color: #16130F; }
        .rate-item { padding: 2px 30px; }
        .rate-item.first { padding-left: 0; }
        .rate-price { font-family: 'Source Serif 4', Georgia, serif; font-weight: 700; font-size: 30px; color: #16130F; line-height: 1; }
        .btn-link { background: none; border: none; cursor: pointer; color: var(--pine); font-family: 'IBM Plex Mono', monospace; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; text-decoration: underline; text-underline-offset: 4px; padding: 10px 4px; }
        .btn-link:hover { color: var(--under); }
        .powered { margin-top: 140px; text-align: center; font-family: 'IBM Plex Mono', monospace; font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--muted); }
        .powered b { color: var(--pine); }

        /* ---------- club settings ---------- */
        .club-logo { width: 44px; height: 44px; object-fit: contain; flex-shrink: 0; }
        .club-logo-tile { display: inline-flex; border-radius: 4px; flex-shrink: 0; }
        .settings-grid { display: grid; grid-template-columns: 1fr; gap: 18px; margin-top: 4px; }
        .set-block { border: 1px solid var(--paper-line); background: #FCF9EF; padding: 20px; }
        .set-title { font-family: 'Source Serif 4', Georgia, serif; font-weight: 700; font-size: 13px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--pine); border-bottom: 2px solid var(--brass); display: inline-block; padding-bottom: 4px; margin: 0 0 14px; }
        .set-sub { font-size: 13.5px; color: var(--muted); margin: 0 0 16px; line-height: 1.55; }
        .club-name-input { width: 100%; font-family: inherit; font-size: 16px; padding: 0 13px; height: 47px; box-sizing: border-box; border: 1px solid var(--paper-line); background: #FFF; color: var(--ink); }
        /* iOS Safari gives date/time inputs an intrinsic min-width that blows
           past the container on phones — zero it and cap every form control */
        input[type="datetime-local"], input[type="date"], input[type="time"] { min-width: 0; max-width: 100%; display: block; -webkit-appearance: none; appearance: none; border-radius: 0; }
        input, select, textarea { max-width: 100%; min-width: 0; box-sizing: border-box; }
        .field { min-width: 0; }
        .club-name-input:focus-visible { outline: 2px solid var(--brass); }
        .swatches { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
        .swatch { appearance: none; cursor: pointer; border: 1.5px solid var(--paper-line); background: #FFF; padding: 0 0 9px; text-align: center; font-family: inherit; }
        .swatch:hover { border-color: var(--brass); }
        .swatch.selected { border-color: var(--pine); box-shadow: 0 0 0 1.5px var(--pine); }
        .swatch:focus-visible { outline: 2px solid var(--brass); outline-offset: 2px; }
        .swatch-chip { display: flex; height: 40px; }
        .swatch-chip span:first-child { flex: 3; }
        .swatch-chip span:last-child { flex: 1; }
        .swatch-name { font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink); display: block; margin-top: 9px; padding: 0 4px; }
        .logo-row { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
        .logo-preview { width: 72px; height: 72px; background: var(--pine); color: var(--brass-bright); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .logo-preview img { max-width: 58px; max-height: 58px; object-fit: contain; }
        .logo-preview .crest { width: 48px; height: 48px; }
        .upload-label { display: inline-block; }
        .file-hidden { display: none; }
        .remove-link { appearance: none; background: none; border: none; cursor: pointer; font-family: 'IBM Plex Mono', monospace; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--under); padding: 4px 0; }
        .remove-link:focus-visible { outline: 2px solid var(--under); outline-offset: 2px; }

        /* ---------- pool setup ---------- */
        .field { display: block; margin-top: 14px; flex: 1 1 200px; }
        .field-k { display: block; font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); margin-bottom: 7px; }
        .field-row { display: flex; gap: 16px; flex-wrap: wrap; align-items: flex-start; }
        .field-k { min-height: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        textarea.club-name-input { resize: vertical; line-height: 1.55; font-size: 14.5px; height: auto; min-height: 90px; padding: 12px 13px; }
        select.club-name-input { appearance: auto; }
        .payout-edit { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
        .payout-place { width: 38px; font-size: 13px; color: var(--pine); font-weight: 600; }
        .payout-input { width: 90px; flex: none; }
        .payout-foot { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-top: 6px; }
        .btn-small { padding: 9px 16px; font-size: 11px; }
        .payout-sum { font-size: 12.5px; }
        .payout-sum.ok { color: var(--pine); }
        .payout-sum.warn { color: var(--under); }
        .bill-option { display: flex; gap: 12px; align-items: flex-start; border: 1.5px solid var(--paper-line); background: #FFF; padding: 14px 16px; margin-bottom: 10px; cursor: pointer; }
        .bill-option:hover { border-color: var(--brass); }
        .bill-option.selected { border-color: var(--pine); box-shadow: 0 0 0 1.5px var(--pine); }
        .bill-option input { margin-top: 4px; accent-color: var(--pine); }
        .bill-name { display: block; font-weight: 600; font-size: 15.5px; color: var(--pine); }
        .bill-desc { display: block; font-size: 13px; color: var(--muted); margin-top: 3px; line-height: 1.5; }
        .publish-confirm { border-left: 4px solid var(--brass); }
        .fee-toggle { display: flex; gap: 12px; align-items: flex-start; cursor: pointer; padding: 4px 0; }
        .fee-toggle input { margin-top: 5px; accent-color: var(--pine); }
        .seg { display: flex; width: 100%; height: 47px; border: 1px solid var(--paper-line); background: #FFF; box-sizing: border-box; }
        .seg.allow-wrap .seg-btn { white-space: normal; line-height: 1.25; padding: 4px 6px; }
        .seg-btn { appearance: none; border: none; background: transparent; cursor: pointer; font-family: 'IBM Plex Mono', monospace; font-size: 13px; padding: 0; flex: 1 1 0; min-width: 0; color: var(--ink); border-left: 1px solid var(--paper-line); display: flex; align-items: center; justify-content: center; }
        .seg-btn:first-child { border-left: none; }
        .seg-btn:hover { background: rgba(185,143,47,0.1); }
        .seg-btn.on { background: var(--pine); color: var(--cream); }
        .seg-btn:focus-visible { outline: 2px solid var(--brass); outline-offset: -2px; }
        .seg-hint { display: block; margin-top: 8px; font-family: 'IBM Plex Mono', monospace; font-size: 11px; letter-spacing: 0.04em; color: var(--muted); }
        .custom-colors { margin-top: 20px; border-top: 1px dotted var(--paper-line); padding-top: 16px; }
        .color-row { display: flex; align-items: center; gap: 14px; margin-top: 12px; }
        .color-input { width: 54px; height: 46px; padding: 3px; border: 1.5px solid var(--paper-line); background: #FFF; cursor: pointer; flex-shrink: 0; }
        .color-input:hover { border-color: var(--brass); }
        .color-input:focus-visible { outline: 2px solid var(--brass); outline-offset: 2px; }
        .hex-input { width: 108px; flex: none; text-transform: uppercase; font-size: 13.5px; }
        .color-label { min-width: 0; }

        @media (max-width: 640px) {
          /* layout: single column everywhere */
          .facts { grid-template-columns: 1fr 1fr; }
          .fact { border-left: none; }
          .fact:nth-child(even) { border-left: 1px solid var(--paper-line); }
          .fact:nth-child(n+3) { border-top: 1px solid var(--paper-line); }
          .home-body { grid-template-columns: 1fr; }
          .tier-grid { grid-template-columns: 1fr; }
          .pick-card { border-left: none !important; border-top: 1px solid var(--paper-line) !important; }
          .pick-card:first-child { border-top: none !important; }
          .shell { padding: 18px 12px 48px; }
          .masthead { padding: 14px 12px 0; }
          .champ-banner { padding: 22px 12px 20px; }
          .set-block { padding: 16px 13px; }
          .swatches { grid-template-columns: 1fr 1fr; }

          /* tabs: horizontal swipe, no visible scrollbar */
          .tabs { overflow-x: auto; scrollbar-width: none; -webkit-overflow-scrolling: touch; }
          .tabs::-webkit-scrollbar { display: none; }
          .tab { white-space: nowrap; padding: 10px 11px 12px; flex-shrink: 0; }

          /* inputs: 16px minimum so iOS Safari doesn't zoom on focus */
          .club-name-input, .submit-bar input, .hex-input { font-size: 16px; }

          /* forms stack full-width */
          .field { flex: 1 1 100%; }
          .field-row { gap: 4px; }
          .field-k { white-space: normal; overflow: visible; text-overflow: clip; }
          .seg.allow-wrap { flex-wrap: wrap; height: auto; }
          .seg.allow-wrap .seg-btn { flex: 1 1 50%; min-height: 44px; border-top: 1px solid var(--paper-line); border-left: none; }
          .seg.allow-wrap .seg-btn:nth-child(-n+2) { border-top: none; }
          .seg.allow-wrap .seg-btn:nth-child(even) { border-left: 1px solid var(--paper-line); }
          .payout-edit { flex-wrap: wrap; row-gap: 6px; }
          .payout-edit .payout-input { flex: 1 1 90px; min-width: 0; }
          .logo-preview { width: 64px; height: 64px; }
          .bill-option { padding: 12px 12px; }
          .fact-v { font-size: 15px; overflow-wrap: anywhere; }
          .submit-bar { position: static; flex-direction: row; flex-wrap: wrap; gap: 8px; padding: 12px 0; }
          .submit-bar input { flex: 1 1 45%; padding: 9px 10px; }
          .submit-bar input[aria-label^="Tiebreaker"] { flex: 1 1 100%; }
          .submit-bar .count { flex: 1 1 auto; align-self: center; text-align: left; }
          .submit-bar .btn { flex: 1 1 100%; text-align: center; }
          .cta-row .btn { flex: 1 1 100%; text-align: center; }
          .color-row { flex-wrap: wrap; }
          .color-label { flex: 1 1 100%; margin-top: 2px; }

          /* platform landing + masthead on phones */
          .landing-h1 { font-size: 29px; }
          .board-mock { flex: 1 1 100% !important; min-width: 0 !important; }
          .board-mock > div { transform: none !important; }
          .club-name { font-size: 20px; }
          .club-sub { font-size: 11px; }
          .rate-item { padding: 8px 24px 8px 0; border-left: none !important; flex: 1 1 45%; }
          .rate-price { font-size: 24px; }
          .sheet-head { flex-wrap: wrap; gap: 4px; }

          /* scoreboard: tighter grid, no overflow */
          .board-cols, .row-main { grid-template-columns: 40px 1fr 64px 20px; padding-left: 12px; padding-right: 12px; }
          .row-entry { font-size: 14.5px; }
          .row-total { font-size: 15.5px; }
          .row-detail { padding-left: 12px; padding-right: 12px; }
          .pick-line { grid-template-columns: 22px 1fr 92px 58px; font-size: 13px; }
          .board-title { flex-wrap: wrap; row-gap: 8px; }
          .board-title .display { font-size: 12.5px; }

          /* touch targets stay comfortable */
          .seg-btn { padding: 12px 13px; min-width: 44px; }
          .tab, .btn, .pick-card, .row-main { -webkit-tap-highlight-color: rgba(185,143,47,0.18); }
        }
      `}</style>

      {DEMO && (
        <div className="demo-band">
          <b>Demo</b> — this is the member view. Fictional club &amp; entries, shown with the real final scores of the 2026 Masters.{" "}
          <a href="https://clubmajorsgolf.com">Get this for your club &rarr;</a>
        </div>
      )}
      {/* ============ masthead (white-label zone) ============ */}
      <header className="masthead">
        <div className="masthead-inner">
          {platformLanding ? (
            <div className="club-line" style={{ cursor: "pointer" }} onClick={() => setView("landing")} title="ClubMajors home">
              <CMLogo size={40} />
              <div>
                <div className="club-name" style={{ fontFamily: "'Archivo Black', sans-serif", letterSpacing: "-0.02em" }}>ClubMajors</div>
                <div className="club-sub">Pools for private clubs</div>
              </div>
            </div>
          ) : (
          <div className="club-line">
            {logoUrl ? <span className="club-logo-tile" style={{ background: logoBgColor, padding: logoBg === "transparent" ? 0 : 5 }}><img src={logoUrl} alt="Club logo" className="club-logo" /></span> : (noLogo ? null : <Crest />)}
            <div>
              <div className="club-name display">{clubName || "Your Club Name"}</div>
              {tagline.trim() !== "" && <div className="club-sub">{tagline.trim()}</div>}
            </div>
          </div>
          )}
          <nav className="tabs" aria-label="Pool sections">
            {NAV_TABS.map((t, i) => {
              const memberTab = ["home", "picks", "board"].includes(t.id);
              const isAdmin = role === "pro" || role === "owner";
              const firstAdminTab = isAdmin && !memberTab && i > 0 && ["home", "picks", "board"].includes(NAV_TABS[i - 1].id);
              return (
                <React.Fragment key={t.id}>
                  {isAdmin && i === 0 && memberTab && (
                    <span className="tab-group-label mono" title="Members only see these three tabs" style={{ alignSelf: "center", fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--brass-bright)", opacity: 0.8, padding: "0 6px 2px 2px", whiteSpace: "nowrap" }}>
                      Member view ▸
                    </span>
                  )}
                  {firstAdminTab && (
                    <span className="tab-group-label mono" title="Only golf shop admins see these tabs — members never do" style={{ alignSelf: "center", fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--brass-bright)", opacity: 0.8, padding: "0 6px 2px 14px", borderLeft: "1px solid rgba(255,255,255,0.25)", marginLeft: 8, whiteSpace: "nowrap" }}>
                      Admin only ▸
                    </span>
                  )}
                  <button className={`tab ${view === t.id ? "active" : ""}`} onClick={() => setView(t.id)}>
                    {t.label}
                  </button>
                </React.Fragment>
              );
            })}
          </nav>
        </div>
      </header>

      <main className="shell">
        {/* ============ POOL HOME ============ */}
        {/* ============ PLATFORM FRONT DOOR (buyers: pros & GMs) ============ */}
        {view === "landing" && (
          <div style={{ maxWidth: 880, margin: "34px auto 0" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "40px 56px", alignItems: "center" }}>
              <div style={{ flex: "1 1 400px", minWidth: 300 }}>
                <h1 className="landing-h1">
                  Major-championship pools for your club
                </h1>
                <p className="set-sub" style={{ fontSize: 16.5, margin: "18px 0 24px" }}>
                  Your members pick six golfers before Thursday's first tee. After that the pool runs itself:
                  live scores, the cut, the standings. You share one link and hand out the trophy.
                  Entry fees stay in your shop. We charge a flat software fee and touch nothing else.
                </p>
                <div className="cta-row">
                  <button className="btn btn-primary" onClick={() => { window.location.href = "/demo"; }}>See the live demo</button>
                  <button className="btn btn-ghost" onClick={() => setView("signup")}>Set up your club</button>
                </div>
              </div>
              <div className="board-mock" style={{ flex: "0 1 300px", minWidth: 270 }}>
                {/* the signature leaderboard, in miniature — a real artifact, not a stock illustration */}
                <div style={{ background: "#15382B", borderRadius: 6, padding: "18px 18px 8px", boxShadow: "0 18px 44px rgba(22,19,15,0.22)", transform: "rotate(-1.2deg)" }}>
                  <div className="mono" style={{ fontSize: 9.5, letterSpacing: "0.26em", textTransform: "uppercase", color: "#D8B45A", marginBottom: 10 }}>
                    Clubhouse Leaderboard · Rd 4
                  </div>
                  {[["1", "Breakfast Ball Boys", "-31"], ["2", "Cart Path Only", "-28"], ["T3", "Mulligan Stew", "-26"], ["T3", "The Shankopotamus", "-26"], ["5", "Fore Play", "-24"]].map(([pos, name, sc], i) => (
                    <div key={name} style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "7px 2px", borderTop: i ? "1px solid rgba(255,255,255,0.08)" : "none" }}>
                      <span className="mono" style={{ color: "#D8B45A", fontSize: 11, width: 24, flex: "none" }}>{pos}</span>
                      <span style={{ flex: 1, color: "#F7F2E4", fontFamily: "'Source Serif 4', serif", fontSize: 14.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>
                      <span className="mono" style={{ color: "#E3CE8F", fontSize: 13 }}>{sc}</span>
                    </div>
                  ))}
                  <div className="mono" style={{ fontSize: 8.5, letterSpacing: "0.2em", textTransform: "uppercase", color: "rgba(247,242,228,0.5)", padding: "10px 2px 8px" }}>
                    Live · best 4 of 6 count
                  </div>
                </div>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "26px 40px", marginTop: 44, borderTop: "1px dotted var(--paper-line)", paddingTop: 32 }}>
              {[
                ["Made for private clubs", "Your crest, your colors, your rules, your payouts. To your members it looks and feels like the club's own pool, not third-party software."],
                ["Set up in minutes", "Pick the event, set the entry fee, choose your rules — we write them out for you, and the picksheet and leaderboard build themselves from the tournament field."],
                ["Support that answers", "A real person reads and answers every email — tournament weekends included."],
                ["Scores you can trust", "We check every score against multiple independent data feeds, around the clock. If a feed goes stale or two sources disagree, we catch it before your members do."],
              ].map(([k, v]) => (
                <div key={k}>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 8 }}>
                    <span aria-hidden="true" style={{ position: "relative", flex: "none", width: 14, height: 18, marginTop: 2 }}>
                      <span style={{ position: "absolute", left: 0, top: 0, width: 2.5, height: 18, background: "#15382B" }} />
                      <span style={{ position: "absolute", left: 2.5, top: 0, width: 11.5, height: 9.5, background: "#C2410C", clipPath: "polygon(0 0, 100% 0, 0 100%)" }} />
                    </span>
                    <div style={{ fontFamily: "'Source Serif 4', Georgia, serif", fontWeight: 700, fontSize: 19, letterSpacing: "-0.01em", color: "#16130F" }}>{k}</div>
                  </div>
                  <p className="set-sub" style={{ margin: 0 }}>{v}</p>
                </div>
              ))}
            </div>

            <div style={{ borderTop: "1px dotted var(--paper-line)", paddingTop: 26, marginTop: 34 }}>
              <div className="mono" style={{ fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 20 }}>
                Flat software fee — entry fees never touch the platform
              </div>
              <div style={{ display: "flex", flexWrap: "wrap" }}>
                {[["$30", "2026 Season Pass"], ["$75", "majors"], ["$30", "non-major events"], ["$330", "annual pass · 2027 onward"]].map(([p, l], i) => (
                  <div key={l} className={"rate-item" + (i ? "" : " first")} style={{ borderLeft: i ? "1px dotted var(--paper-line)" : "none" }}>
                    <div className="rate-price">{p}</div>
                    <div className="mono" style={{ fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--muted)", marginTop: 8 }}>{l}</div>
                  </div>
                ))}
              </div>
              <p className="pro-note" style={{ marginTop: 22 }}>
                Every pool comes with the odds-tiered picksheet, a live leaderboard, and a printable
                picksheet for the grill room.
              </p>
            </div>
          </div>
        )}

        {view === "home" && guestNoPool && (
          <section className="set-block" style={{ maxWidth: 560, margin: "40px auto 0", textAlign: "center" }}>
            <h3 className="set-title" style={{ borderColor: "var(--brass)" }}>No active pool right now</h3>
            <p className="set-sub" style={{ marginTop: 10 }}>
              {(dbClub && dbClub.name) || "This club"} hasn't published a pool yet. When the golf shop opens
              one, the picksheet and leaderboard will be right here.
            </p>
          </section>
        )}
        {view === "home" && !guestNoPool && (
          <>
            <div className="champ-banner">
              <div className="champ-eyebrow">{heroEyebrow}</div>
              <h1 className="champ-title display">{heroTitle}</h1>
              {heroVenue !== "" && <div className="champ-venue">{heroVenue}</div>}
            </div>
            <div className="facts">
              <div className="fact"><div className="fact-k">Entry</div><div className="fact-v">${Number(setup.entryFee) || 50}</div></div>
              <div className="fact"><div className="fact-k">Deadline</div><div className="fact-v">{dbPool ? new Date(dbPool.deadline).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }) : "TBD"}</div></div>
              <div className="fact"><div className="fact-k">Entries</div><div className="fact-v mono">{entries.length}</div></div>
              <div className="fact"><div className="fact-k">Purse</div><div className="fact-v mono">${entries.length * (Number(setup.entryFee) || 50)}</div></div>
            </div>

            <div className="home-body">
              <div className="rules">
                <h3>How it works</h3>
                <ul>
                  {customRules ? (
                    customRules.map((line, i) => <li key={i}>{line.replace(/\*\*|__/g, "")}</li>)
                  ) : (
                    <>
                      <li><strong>Pick six</strong> — one golfer from each odds-based tier, before Thursday's first tee.</li>
                      <li><strong>Best four count</strong> — your four lowest 72-hole scores to par make your total. Lowest total Sunday wins.</li>
                      <li><strong>Missed cuts</strong> score their 36-hole total +8 per weekend round (withdrawals too — same-tier swaps OK before the deadline).</li>
                      {setup.tiebreakerOn && (
                        <li><strong>Tiebreaker</strong> — closest guess at the winning score, then a scorecard playoff of best pick vs. best pick. Golf shop has final say.</li>
                      )}
                    </>
                  )}
                </ul>
              </div>
              <div className="payout">
                <h3>Payouts</h3>
                {(setup.payouts || []).map((pct, i) =>
                  (Number(pct) || 0) > 0 ? (
                    <div className="payout-row" key={i}>
                      <span>{(["1st", "2nd", "3rd", "4th", "5th"][i] || i + 1 + "th") + " place"}</span>
                      <span className="mono">{pct}%</span>
                    </div>
                  ) : null
                )}
                {(() => {
                  const mgrs = pros.filter((p) => (((p && p.first) || "") + ((p && p.last) || "")).trim());
                  return mgrs.length > 0 ? (
                    <div style={{ marginTop: 22 }}>
                      <h3>Pool manager{mgrs.length > 1 ? "s" : ""}</h3>
                      {mgrs.map((p, i) => (
                        <div key={i} style={{ fontFamily: "'Source Serif 4', serif", fontSize: 14.5, color: "var(--pine)", fontWeight: 600, lineHeight: 1.7 }}>
                          {(((p.first || "") + " " + (p.last || "")).trim() + (p.pga ? ", PGA" : ""))}
                        </div>
                      ))}
                    </div>
                  ) : null;
                })()}
              </div>
            </div>

            <div className="cta-row" style={{ alignItems: "center" }}>
              <button className="btn btn-primary" onClick={() => setView("picks")}>Make your picks</button>
              <button className="btn-link" onClick={() => setView("board")}>View live leaderboard →</button>
            </div>

            <p className="pro-note">
              Entry fees are collected and paid out by the golf shop — this site only tracks picks and standings.
              Questions? Ask in the shop.
            </p>
          </>
        )}

        {/* ============ PICKSHEET ============ */}
        {view === "picks" && !guestNoPool && (
          <>
            <div className="sheet-head">
              <div className="sheet-title">{editCode ? "Edit Your Picks" : "Official Picksheet"}</div>
              <div className="sheet-deadline mono" style={locked ? { color: "var(--under)" } : undefined}>
                {locked
                  ? "Entry deadline has passed"
                  : dbPool
                  ? `Picks lock ${new Date(dbPool.deadline).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}`
                  : "Picks lock before Round 1"}
              </div>
            </div>
            <p className="sheet-sub">
              {locked
                ? "Picks are locked — the deadline has passed."
                : editCode
                ? "Update your six picks below. Your changes replace your current entry."
                : "Select one golfer from each tier, add your name" + (setup.tiebreakerOn ? " and tiebreaker" : "") + ", and submit. Six picks — " + (setup.scoring === "all6" ? "all six scores count" : "best four count") + "."}
            </p>

            {locked && (
              <p className="pro-note" style={{ marginBottom: 18 }}>
                This pool is closed to new picks and edits.
              </p>
            )}

            {!editCode && !locked && memberEditsAllowed && (
              <p className="sheet-sub" style={{ marginTop: -12, marginBottom: 18 }}>
                Already entered on another device? Paste your edit code:{" "}
                <input
                  className="club-name-input" style={{ display: "inline-block", width: 200, maxWidth: "100%", padding: "6px 10px", marginLeft: 6, verticalAlign: "middle" }}
                  placeholder="edit code"
                  value={codeInput}
                  onChange={(e) => setCodeInput(e.target.value)}
                  aria-label="Edit code"
                />
                <button className="btn btn-ghost btn-small" style={{ marginLeft: 8, verticalAlign: "middle" }}
                  onClick={() => beginEditByCode(codeInput)}>
                  Load my picks
                </button>
                {saveMsg && <span className="count" style={{ marginLeft: 10, color: "var(--under)" }}>{saveMsg}</span>}
              </p>
            )}

            {!fieldMatchesPool && !locked && (
              <section className="set-block" style={{ textAlign: "center", padding: "36px 20px" }}>
                <h3 className="set-title" style={{ borderColor: "var(--brass)" }}>Field coming soon</h3>
                <p className="set-sub" style={{ marginTop: 8 }}>
                  The field for <strong>{dbPool ? dbPool.event_name : "this event"}</strong> isn't posted
                  yet{fieldEventName ? " (the odds board is still on " + fieldEventName + ")" : ""}. Picks open as soon
                  as the field is announced, usually the weekend before the tournament.
                </p>
              </section>
            )}

            {!locked && fieldMatchesPool && (
              <p className="sheet-sub" style={{ marginTop: -6, marginBottom: 18 }}>
                <input
                  className="club-name-input"
                  style={{ display: "inline-block", width: 240, maxWidth: "100%", padding: "6px 10px", verticalAlign: "middle" }}
                  placeholder="Search golfers by name…"
                  value={golferQuery}
                  onChange={(e) => setGolferQuery(e.target.value)}
                  aria-label="Search golfers by name"
                />
                {golferQuery.trim() && (
                  <button className="btn btn-ghost btn-small" style={{ marginLeft: 8, verticalAlign: "middle" }} onClick={() => setGolferQuery("")}>
                    Clear search
                  </button>
                )}
                {golferQuery.trim() && !ACTIVE_TIERS.some((t) => t.players.some((p) => p.name.toLowerCase().includes(golferQuery.trim().toLowerCase()))) && (
                  <span className="count" style={{ marginLeft: 10, color: "var(--under)" }}>No golfers match “{golferQuery.trim()}”</span>
                )}
              </p>
            )}

            {fieldMatchesPool && ACTIVE_TIERS.map((tier) => {
              const gq = locked ? "" : golferQuery.trim().toLowerCase();
              const shownPlayers = gq ? tier.players.filter((p) => p.name.toLowerCase().includes(gq)) : tier.players;
              if (gq && shownPlayers.length === 0) return null;
              return (
              <section className="tier-block" key={tier.label}>
                <div className="tier-head">
                  <span className="tier-roman">{tier.side || tier.label}</span>
                  <span className="tier-note">{tier.side ? (tier.side === "USA" ? "Team USA" : "The Internationals") + " · pick " + tier.label.slice(-1) + " of 3 · choose one" : "Choose one · " + tier.players.length + " golfers"}</span>
                </div>
                <div className="tier-grid">
                  {shownPlayers.map((p) => (
                    <button
                      key={p.id}
                      className={`pick-card ${picks[tier.label] === p.id ? "selected" : ""}`}
                      disabled={picks[tier.label] !== p.id && Object.entries(picks).some(([l, v]) => l !== tier.label && v === p.id)}
                      style={picks[tier.label] !== p.id && Object.entries(picks).some(([l, v]) => l !== tier.label && v === p.id) ? { opacity: 0.35, cursor: "default" } : undefined}
                      onClick={() => setPicks((prev) => ({ ...prev, [tier.label]: p.id }))}
                      aria-pressed={picks[tier.label] === p.id}
                    >
                      <span>
                        <span className="pick-name">{p.name}</span>
                      </span>
                      {p.odds ? <span className="odds">{p.odds}</span> : <span className="odds" />}
                    </button>
                  ))}
                </div>
              </section>
              );
            })}

            {teamMode && (
              <section className="tier-block">
                <div className="tier-head">
                  <span className="tier-roman">★</span>
                  <span className="tier-note">Cup call · who lifts the Cup? Worth 8 points (no points if it ends 15–15)</span>
                </div>
                <div className="tier-grid">
                  <button className={`pick-card ${cupCall === "usa" ? "selected" : ""}`} onClick={() => setCupCall("usa")} aria-pressed={cupCall === "usa"}>
                    <span><span className="pick-name">Team USA</span></span><span className="odds">8 PTS</span>
                  </button>
                  <button className={`pick-card ${cupCall === "intl" ? "selected" : ""}`} onClick={() => setCupCall("intl")} aria-pressed={cupCall === "intl"}>
                    <span><span className="pick-name">The Internationals</span></span><span className="odds">8 PTS</span>
                  </button>
                </div>
              </section>
            )}
            {fieldMatchesPool && (
            <div className="submit-bar">
              <input
                placeholder="Entry name (e.g., Tee Time Bandits)"
                value={entryName}
                onChange={(e) => setEntryName(e.target.value)}
                aria-label="Entry name"
                disabled={locked}
                style={locked ? { opacity: 0.45, cursor: "not-allowed", background: "#EDE8DA" } : undefined}
              />
              <input
                placeholder="Member name"
                value={memberName}
                onChange={(e) => setMemberName(e.target.value)}
                aria-label="Member name"
                disabled={locked}
                style={locked ? { opacity: 0.45, cursor: "not-allowed", background: "#EDE8DA" } : undefined}
              />
              {setup.tiebreakerOn && (
                <input
                  placeholder={teamMode ? "Tiebreaker: final Cup score (e.g. 17-13)" : "Tiebreaker: winning score to par (e.g. -12)"}
                  value={tiebreak}
                  onChange={(e) => setTiebreak(e.target.value)}
                  aria-label={teamMode ? "Tiebreaker: your guess at the final Cup score" : "Tiebreaker: your guess at the winning golfer's final score to par"}
                  disabled={locked}
                  style={locked ? { opacity: 0.45, cursor: "not-allowed", background: "#EDE8DA" } : undefined}
                />
              )}
              <span className="count" style={locked ? { color: "var(--under)", fontWeight: 600 } : undefined}>
                {locked ? "Entry deadline has passed" : pickCount + "/6 picked"}
              </span>
              <button className="btn btn-ghost btn-small" disabled={locked || pickCount === 0} onClick={() => setPicks({})}>
                Clear picks
              </button>
              <button className="btn btn-primary" disabled={pickCount < 6 || locked || nameTaken || !tbValid || !agree || (teamMode && !cupCall)} onClick={submitPicks}>
                {editCode ? "Save changes" : "Submit picksheet"}
              </button>
            </div>
            )}
            {editCode && !locked && dbPool && memberEditsAllowed && (
              <p style={{ marginTop: 10 }}>
                <button className="btn-link" style={{ color: "var(--under)" }} onClick={deleteMyEntry}>
                  Delete my entry
                </button>
              </p>
            )}
            {nameTaken && (
              <p className="sheet-sub" style={{ color: "#B3402F", marginTop: 8 }}>
                That entry name is already on the board — pick another.
              </p>
            )}
            {tiebreak.trim() !== "" && !tbValid && (
              <p className="sheet-sub" style={{ color: "#B3402F", marginTop: 8 }}>
                {teamMode ? "The tiebreaker is the final Cup score — like 17-13 (halves allowed: 15.5-14.5)." : "The tiebreaker should be a score relative to par — a number like -12, 0, or 3."}
              </p>
            )}
            <label className="sheet-sub" style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 12, cursor: "pointer" }}>
              <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} style={{ marginTop: 3 }} aria-label="Agree to pool rules and terms" />
              <span>
                I agree to the pool rules and terms. My entry and member name are shared with the golf shop (the pool
                admin). Standings are tracked for entertainment purposes only; any entry fees and prizes are handled
                entirely by the club.
              </span>
            </label>
          </>
        )}

        {/* ============ LEADERBOARD ============ */}
        {view === "board" && !guestNoPool && (
          <>
          {showCode && (
            <div className="champ-banner" style={{ borderTopColor: "var(--brass)", marginBottom: 18, textAlign: "left", padding: "16px 18px" }}>
              <div className="champ-eyebrow">Entry submitted</div>
              <p className="set-sub" style={{ margin: "8px 0 6px" }}>
                You're on the board — good luck. Entries are final; standings update live below once play begins.
              </p>
              <button className="remove-link" style={{ color: "var(--muted)", marginTop: 6 }} onClick={() => setShowCode(null)}>Dismiss</button>
            </div>
          )}
          {editCode && !locked && !showCode && memberEditsAllowed && (
            <div className="cta-row" style={{ marginBottom: 14 }}>
              <button className="btn btn-ghost btn-small" onClick={() => beginEditByCode(editCode.token)}>Edit my picks</button>
            </div>
          )}
          {teamMode && (
            <p className="sheet-sub" style={{ borderLeft: "3px solid var(--brass)", paddingLeft: 10, marginBottom: 10 }}>
              Entries are locked in below. <strong>Match-point scoring switches on when the Cup begins</strong> — Win 2 / Halve 1 in team sessions,
              Win 4 / Halve 2 in Sunday singles, plus the 8-point Cup call. Totals show — until the first session tees off.
            </p>
          )}
          <div className="board-wrap">
            <div className="board-title">
              <span className="display">{boardTitle}</span>
              <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span className="live-chip">
                  <span className={`live-dot ${live ? "on" : ""}`} />
                  {live
                    ? preTee && source !== "demo"
                      ? "PRE-TOURNAMENT"
                      : source === "live"
                      ? staleAt
                        ? "SCORES AS OF " + new Date(staleAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
                        : "LIVE"
                      : source === "espn"
                      ? "LIVE · ESPN"
                      : source === "demo"
                      ? "FINAL · 2026 MASTERS"
                      : "LIVE · SIM"
                    : "PAUSED"}
                </span>
              </span>
            </div>
            <div style={{ padding: "10px 14px", borderBottom: "1px solid rgba(247,242,228,0.12)" }}>
              <input
                value={boardQuery}
                onChange={(e) => setBoardQuery(e.target.value)}
                placeholder="Search your name or entry…"
                aria-label="Search entries by entry or member name"
                style={{ width: "100%", boxSizing: "border-box", background: "rgba(247,242,228,0.08)", border: "1px solid rgba(247,242,228,0.25)", color: "var(--cream)", padding: "9px 12px", fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, borderRadius: 3 }}
              />
            </div>
            <div className="board-cols">
              <span>Pos</span><span>Entry</span><span style={{ textAlign: "right" }}>Total</span><span />
            </div>
            {board.filter((e) => {
              const q = boardQuery.trim().toLowerCase();
              if (!q) return true;
              return (e.entry || "").toLowerCase().includes(q) || (e.member || "").toLowerCase().includes(q);
            }).map((e) => {
              const isOpen = expanded === e.id;
              return (
                <div className={`board-row ${e.id === myEntryId ? "mine" : ""}`} key={e.id}>
                  <button className="row-main" onClick={() => setExpanded(isOpen ? null : e.id)} aria-expanded={isOpen}>
                    <span className="row-pos">{e.posLabel}</span>
                    <span className="row-entry">
                      {e.entry}
                      <span className="row-member">{e.member}</span>
                    </span>
                    <span className={`row-total ${!teamMode && e.total < 0 ? "under" : ""}`}>{teamMode || preTee ? "—" : fmtPar(e.total)}</span>
                    <span className="chev">{isOpen ? "▲" : "▼"}</span>
                  </button>
                  {isOpen && (
                    <div className="row-detail">
                      {e.picks.map((pid) => {
                        const p = PLAYER_INDEX[pid] || TEAM_INDEX[pid] || { name: "(no longer in field)", tier: "—" };
                        const s = scores[pid] || { total: 0, thru: 0 };
                        const val = poolScore(pid, scores);
                        const counted = e.counted.has(pid);
                        return (
                          <div className={`pick-line ${counted ? "" : "dropped"}`} key={pid}>
                            <span className="pl-tier">{p.tier}</span>
                            <span>
                              {p.name}
                              {lastMover === pid && live && <span className="drop-tag" style={{ color: "var(--brass-bright)", marginLeft: 8 }}>● MOVED</span>}
                            </span>
                            <span className={`pl-score ${val < 0 ? "under" : ""}`}>
                              {preTee ? "" : s.total == null ? "—" : s.mc ? fmtPar(val) : fmtPar(s.total)}
                              {s.rounds && s.rounds.length > 0 && (
                                <span className="mono" style={{ display: "block", fontSize: 10, opacity: 0.65, letterSpacing: "0.04em", fontWeight: 400, marginTop: 1, whiteSpace: "nowrap" }}>
                                  {coursePar
                                    ? s.rounds
                                        .map((r) => fmtPar(r - coursePar))
                                        .concat(s.mc && s.total != null ? ["+" + MC_PENALTY_PER_ROUND, "+" + MC_PENALTY_PER_ROUND] : [])
                                        .join(" ")
                                    : s.rounds.join("-")}
                                </span>
                              )}
                            </span>
                            <span className="pl-thru">{preTee ? "" : (s.mc ? "MC" : s.thru >= 18 ? "F" : `THRU ${s.thru}`) + (!counted ? " · DROP" : "")}</span>
                          </div>
                        );
                      })}
                      {e.team && (
                        <div className="pick-line">
                          <span className="pl-tier">★</span>
                          <span>Cup call — {e.team === "usa" ? "Team USA" : "The Internationals"} (8 pts)</span>
                          <span className="pl-score" />
                          <span className="pl-thru" />
                        </div>
                      )}
                      {e.tbs && (
                        <div className="pick-line">
                          <span className="pl-tier">TB</span>
                          <span>Tiebreaker — final Cup score guess</span>
                          <span className="pl-score">{e.tbs}</span>
                          <span className="pl-thru" />
                        </div>
                      )}
                      {e.tb != null && (
                        <div className="pick-line">
                          <span className="pl-tier">TB</span>
                          <span>Tiebreaker — winning score guess</span>
                          <span className="pl-score">{fmtPar(e.tb)}</span>
                          <span className="pl-thru" />
                        </div>
                      )}
                      {/* admin remove-entry removed Jul 2026 — entries are final for everyone */}
                                          </div>
                  )}
                </div>
              );
            })}
            {boardQuery.trim() !== "" &&
              board.filter((e) => (e.entry || "").toLowerCase().includes(boardQuery.trim().toLowerCase()) || (e.member || "").toLowerCase().includes(boardQuery.trim().toLowerCase())).length === 0 && (
                <div style={{ padding: "16px 14px", color: "rgba(247,242,228,0.7)", fontFamily: "'IBM Plex Mono', monospace", fontSize: 12.5 }}>
                  No entries match "{boardQuery.trim()}" — positions still update live for everyone.
                </div>
              )}
            <div className="board-foot">
              {(setup.scoring === "all6" ? "All 6 scores count" : "Best 4 of 6 scores count")} · Missed cut scored at 36-hole total +8 per weekend round ·{" "}
              {source === "live"
                ? `Live scoring via SlashGolf${lastUpdated ? " · updated " + new Date(lastUpdated).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : ""}`
                : source === "demo"
                ? "Demo — official final scores from the 2026 Masters Tournament"
                : `Simulated feed — live scoring starts when ${poolEvent ? poolEvent.name : "the tournament"} tees off`}
            </div>
          </div>
          </>
        )}

        {/* ============ POOL SETUP (club pro admin) ============ */}
        {view === "setup" && (
          <>
            <div className="sheet-head">
              <div className="sheet-title">Create a Pool</div>
              <div className="sheet-deadline mono" style={{ color: "var(--muted)" }}>Admin · Golf shop only</div>
            </div>
            <p className="sheet-sub">Set up the next event for your members. Everything here appears on the Pool Home page exactly as written.</p>

            {!hasPublishedPool && (
              <p className="sheet-sub" style={{ marginTop: -6 }}>
                New here? <a href="/demo" target="_blank" rel="noopener" style={{ color: "var(--pine)", fontWeight: 600 }}>Open the live demo ↗</a> —
                that's what your members will get, in your club's colors.
              </p>
            )}

            {memberLink && (
              <section className="set-block" style={{ borderLeft: "4px solid var(--brass)", marginBottom: 18 }}>
                <h3 className="set-title">Your members' link</h3>
                <p className="set-sub">Share this with your members — email it, print the QR, or drop it in the group chat. It opens straight to your club's pool.</p>
                <div className="mono" style={{ fontSize: 14, color: "var(--pine)", background: "#FCF9EF", border: "1px solid var(--paper-line)", padding: "12px 14px", userSelect: "all", wordBreak: "break-all" }}>{memberLink}</div>
              </section>
            )}

            {setup.published ? (
              <section className="set-block publish-confirm">
                <h3 className="set-title">Pool published</h3>
                <p className="set-sub" style={{ marginBottom: 8 }}>
                  <strong>{selectedEvent.name}</strong> · {selectedEvent.dates} · Picks lock {new Date(setup.deadline).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}
                </p>
                <p className="set-sub" style={{ marginBottom: 8 }}>
                  {passActive
                    ? (dbClub && dbClub.plan === "annual"
                        ? "ClubMajors Annual Pass active" + (dbClub.paid_until ? " through " + new Date(dbClub.paid_until).toLocaleDateString([], { month: "short", year: "numeric" }) : "") + " — every pool and edit included."
                        : "2026 Season Pass active through Dec 31, 2026 — every remaining PGA Tour event included.")
                    : (setup.billing === "annual"
                        ? `Charged $${ANNUAL_PRICE} — ClubMajors Annual Pass now active for the next 12 months.`
                        : setup.billing === "season"
                        ? `2026 Season Pass active through Dec 31, 2026 — every remaining PGA Tour event included.`
                        : `Single event (${PRICING_LABEL[selectedEvent.type]}) — $${eventFee} platform fee.`) + " Receipt sent to the golf shop email."}
                </p>
                <p className="set-sub">The member invite link and printable picksheet are ready to share.</p>
                {saveMsg && <p className="set-sub" style={{ color: "var(--pine)" }}>{saveMsg}</p>}
                <div className="cta-row" style={{ marginTop: 12 }}>
                  <button className="btn btn-primary" onClick={() => setView("picks")}>View member picksheet</button>
                  <button className="btn btn-ghost" onClick={() => setSetup((s) => ({ ...s, published: false }))}>Edit pool</button>
                </div>
              </section>
            ) : (
              <div className="settings-grid">
                <section className="set-block">
                  <h3 className="set-title">Event</h3>
                  <select
                    className="club-name-input"
                    value={setup.eventId}
                    onChange={(e) => {
                      const ev = EVENTS.find((x) => x.id === e.target.value);
                      setSetup((s) => ({
                        ...s,
                        eventId: e.target.value,
                        deadline: ev ? toLocalInput(defaultDeadline(ev)) : s.deadline,
                      }));
                    }}
                    aria-label="Select event"
                  >
                    {EVENTS.map((ev) => (
                      <option key={ev.id} value={ev.id}>
                        {ev.name} · {ev.dates} — {PRICING_LABEL[ev.type]} (${PLATFORM_PRICING[ev.type]})
                      </option>
                    ))}
                  </select>
                  <div className="field-row">
                    <label className="field">
                      <span className="field-k">Member entry fee ($)</span>
                      <input
                        className="club-name-input" type="number" min="0"
                        value={setup.entryFee}
                        onChange={(e) => setSetup((s) => ({ ...s, entryFee: e.target.value }))}
                      />
                      <span className="seg-hint">Collected by the golf shop — never by ClubMajors</span>
                    </label>
                    <label className="field">
                      <span className="field-k">Picks deadline</span>
                      <input
                        className="club-name-input" type="datetime-local"
                        value={setup.deadline}
                        onChange={(e) => setSetup((s) => ({ ...s, deadline: e.target.value }))}
                      />
                      {new Date(setup.deadline).getTime() < Date.now() && (
                        <span className="field-hint" style={{ color: "#a33b2e" }}>
                          This deadline has already passed — members are locked out of picks. Set a time before Thursday’s first tee.
                        </span>
                      )}
                    </label>
                    <div className="field">
                      <span className="field-k">Entries per member</span>
                      <div className="seg" role="radiogroup" aria-label="Entries per member">
                        {["1", "2", "3", "4", "5", "unlimited"].map((v) => (
                          <button
                            key={v}
                            className={`seg-btn ${setup.maxEntries === v ? "on" : ""}`}
                            onClick={() => setSetup((s) => ({ ...s, maxEntries: v }))}
                            aria-pressed={setup.maxEntries === v}
                          >
                            {v === "unlimited" ? "∞" : v}
                          </button>
                        ))}
                      </div>
                      <span className="seg-hint">
                        {setup.maxEntries === "unlimited" ? "Unlimited entries per member" : `Up to ${setup.maxEntries} ${setup.maxEntries === "1" ? "entry" : "entries"} per member`}
                      </span>
                    </div>
{/* Member-changes toggle removed Jul 2026 — all entries are final */}
                  </div>
                </section>

                <section className="set-block">
                  <h3 className="set-title">Format</h3>
                  {selectedEvent.teamEvent && (
                    <p className="set-sub" style={{ borderLeft: "3px solid var(--brass)", paddingLeft: 10 }}>
                      <strong>Presidents Cup — match play.</strong> This event uses team match-play scoring (rules below are generated
                      automatically); the stroke-play options underneath don't apply. Members pick three golfers per side plus a Cup call.
                      Rosters are projected until captains finalize teams — the picksheet updates automatically.
                    </p>
                  )}
                  <div className="field-row">
                    <label className="field">
                      <span className="field-k">Picksheet tiers</span>
                      <select className="club-name-input" value={setup.tierMethod} onChange={(e) => setSetup((s) => ({ ...s, tierMethod: e.target.value }))}>
                        <option value="odds6">6 tiers by Vegas odds · pick 1 each</option>
                        <option value="owgr6" disabled>6 tiers by World Ranking · coming soon</option>
                        <option value="open" disabled>No tiers · pick any 6 · coming soon</option>
                        <option value="custom" disabled>Custom tiers · coming soon</option>
                      </select>
                    </label>
                    <label className="field">
                      <span className="field-k">Tiebreaker</span>
                      <select className="club-name-input" value={setup.tiebreakerOn ? "on" : "off"} onChange={(e) => setSetup((s) => ({ ...s, tiebreakerOn: e.target.value === "on" }))}>
                        <option value="on">Required · guess the winning score</option>
                        <option value="off">Off · no tiebreaker question</option>
                      </select>
                    </label>
                    <label className="field">
                      <span className="field-k">Scoring</span>
                      <select className="club-name-input" value={setup.scoring} onChange={(e) => setSetup((s) => ({ ...s, scoring: e.target.value }))}>
                        <option value="best4">To par · best 4 of 6 count</option>
                        <option value="all6">To par · all 6 count</option>
                        <option value="daily" disabled>Daily bests · coming soon</option>
                        <option value="money" disabled>Money earnings · coming soon</option>
                      </select>
                    </label>
                    <label className="field">
                      <span className="field-k">Missed cut handling</span>
                      <select className="club-name-input" value={setup.cutRule} onChange={(e) => setSetup((s) => ({ ...s, cutRule: e.target.value }))}>
                        <option value="plus8">36-hole total +8 per missed round</option>
                        <option value="score80" disabled>Score of 80 for rounds 3 & 4 · coming soon</option>
                        <option value="worst" disabled>Highest carded score from the field · coming soon</option>
                      </select>
                    </label>
                  </div>
                </section>

                <section className="set-block">
                  <h3 className="set-title">Rules</h3>
                  <label className="field">
                    <span className="field-k">Auto-generated from your format — edit freely. Shown on Pool Home exactly as written here.</span>
                    <textarea
                      className="club-name-input" rows={7}
                      value={setup.rules}
                      onChange={(e) => { rulesTouchedRef.current = true; const v = e.target.value; setSetup((s) => ({ ...s, rules: v })); }}
                      onBlur={() => setSetup((s) => ({
                        ...s,
                        rules: s.rules
                          .split("\n")
                          .map((l) => l.trim())
                          .filter(Boolean)
                          .map((l) => "\u2022 " + l.replace(/^[\u2022\u00b7\-\s]+/, ""))
                          .join("\n"),
                      }))}
                    />
                  </label>
                  <button className="btn btn-ghost btn-small" onClick={() => {
                    rulesTouchedRef.current = false;
                    setSetup((s) => ({ ...s, rules: generateRules(s).map((l) => "\u2022 " + l).join("\n") }));
                  }}>Reset to match format</button>
                </section>

                <section className="set-block">
                  <h3 className="set-title">Winner distribution</h3>
                  <label className="fee-toggle">
                    <input
                      type="checkbox"
                      checked={setup.adminFeeOn}
                      onChange={(e) => setSetup((s) => ({ ...s, adminFeeOn: e.target.checked }))}
                    />
                    <span>
                      <span className="bill-name" style={{ fontSize: 14.5 }}>Club admin fee (optional)</span>
                      <span className="bill-desc">Taken off the top of the purse before payouts.</span>
                    </span>
                  </label>
                  {setup.adminFeeOn && (
                    <div style={{ marginTop: 10 }}>
                      <div className="seg" role="radiogroup" aria-label="Admin fee type">
                        <button
                          className={`seg-btn ${setup.adminFeeType === "flat" ? "on" : ""}`}
                          onClick={() => setSetup((s) => ({ ...s, adminFeeType: "flat", adminFeeVal: 100 }))}
                          aria-pressed={setup.adminFeeType === "flat"}
                        >
                          $ amount
                        </button>
                        <button
                          className={`seg-btn ${setup.adminFeeType === "pct" ? "on" : ""}`}
                          onClick={() => setSetup((s) => ({ ...s, adminFeeType: "pct", adminFeeVal: 10 }))}
                          aria-pressed={setup.adminFeeType === "pct"}
                        >
                          % of purse
                        </button>
                      </div>
                      <div className="payout-edit" style={{ marginTop: 10 }}>
                        {setup.adminFeeType === "flat" && <span className="mono" style={{ color: "var(--muted)" }}>$</span>}
                        <input
                          className="club-name-input payout-input" type="number" min="0"
                          value={setup.adminFeeVal}
                          onChange={(e) => setSetup((s) => ({ ...s, adminFeeVal: e.target.value === "" ? "" : Math.max(0, Number(e.target.value)) }))}
                          aria-label={setup.adminFeeType === "flat" ? "Admin fee in dollars" : "Admin fee percentage"}
                        />
                        <span className="mono" style={{ color: "var(--muted)" }}>
                          {setup.adminFeeType === "flat" ? "off the top" : "% of purse"}
                        </span>
                      </div>
                    </div>
                  )}
                  <p className="set-sub" style={{ marginTop: 14 }}>
                    Percent of the {setup.adminFeeOn ? "remaining " : ""}purse per place. Must total 100.
                  </p>
                  {setup.payouts.map((p, i) => (
                    <div className="payout-edit" key={i}>
                      <span className="payout-place mono">{ORDINALS[i]}</span>
                      <input
                        className="club-name-input payout-input" type="number" min="0" max="100"
                        value={p}
                        onChange={(e) => setPayout(i, e.target.value)}
                        aria-label={`${ORDINALS[i]} place percentage`}
                      />
                      <span className="mono" style={{ color: "var(--muted)" }}>%</span>
                      {setup.payouts.length > 1 && (
                        <button className="remove-link" onClick={() => setSetup((s) => ({ ...s, payouts: s.payouts.filter((_, x) => x !== i) }))}>
                          Remove
                        </button>
                      )}
                    </div>
                  ))}
                  <div className="payout-foot">
                    {setup.payouts.length < 6 && (
                      <button className="btn btn-ghost btn-small" onClick={() => setSetup((s) => ({ ...s, payouts: [...s.payouts, 0] }))}>
                        + Add place
                      </button>
                    )}
                    <span className={`mono payout-sum ${payoutSum === 100 ? "ok" : "warn"}`}>
                      Total: {payoutSum}%{payoutSum !== 100 && " — must equal 100"}
                    </span>
                  </div>
                  <p className="set-sub" style={{ marginTop: 14, marginBottom: 0 }}>
                    Example with 40 entries at ${Number(setup.entryFee) || 0}: purse ${examplePurse}
                    {exampleFee > 0 && <> − ${exampleFee} club fee = ${examplePot} paid out</>}
                    {payoutSum === 100 && (
                      <>
                        {" "}→ {setup.payouts.map((p, i) => `${ORDINALS[i]} $${Math.round(examplePot * (Number(p) || 0) / 100)}`).join(" · ")}
                      </>
                    )}
                  </p>
                </section>

                <section className="set-block">
                  <h3 className="set-title">Past pools</h3>
                  {pastResults.length === 0 && (
                    <p className="set-sub">Finished pools are archived here automatically when you start the next event's pool — final standings included.</p>
                  )}
                  {pastResults.map((r) => {
                    const key = r.id || r.pool_id;
                    const open = expandedResult === key;
                    const rows = Array.isArray(r.standings) ? r.standings : [];
                    return (
                      <div key={key} style={{ borderBottom: "1px dotted var(--paper-line)", padding: "8px 0" }}>
                        <button className="remove-link" style={{ color: "var(--pine)", display: "flex", width: "100%", justifyContent: "space-between", textAlign: "left" }} onClick={() => setExpandedResult(open ? null : key)}>
                          <span><strong>{r.event_name}</strong> · {rows.length} entries</span>
                          <span className="mono" style={{ fontSize: 12 }}>
                            {r.finalized_at ? new Date(r.finalized_at).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }) : ""} {open ? "▲" : "▼"}
                          </span>
                        </button>
                        {open && (
                          <div style={{ marginTop: 8 }}>
                            {rows.slice(0, 20).map((row, i) => (
                              <div className="payout-row" key={i} style={{ padding: "6px 0" }}>
                                <span>
                                  <span className="mono" style={{ display: "inline-block", width: 34, color: "var(--muted)" }}>{row.pos}</span>
                                  {row.entry}
                                  <span style={{ color: "var(--muted)", marginLeft: 8, fontStyle: "italic", fontSize: 12 }}>{row.member}</span>
                                </span>
                                <span className="mono">{row.total === 0 ? "E" : row.total > 0 ? "+" + row.total : row.total}</span>
                              </div>
                            ))}
                            {rows.length > 20 && <p className="seg-hint">…and {rows.length - 20} more entries</p>}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </section>

                <section className="set-block">
                  <h3 className="set-title">{feeCovered ? "Publish" : "Publish — platform fee"}</h3>
                  <p className="set-sub">
                    {feeCovered
                      ? passActive
                        ? "Covered by your " + (dbClub && dbClub.plan === "annual" ? "Annual Pass" : "2026 Season Pass") + " — publishing pools and edits never costs extra."
                        : "This pool's platform fee is already paid — publishing your changes costs nothing."
                      : "This is what the club pays ClubMajors. Member entry fees stay with the golf shop."}
                  </p>
                  {!feeCovered && (<>
                  <label className={`bill-option ${setup.billing === "season" ? "selected" : ""}`}>
                    <input type="radio" name="billing" checked={setup.billing === "season"} onChange={() => setSetup((s) => ({ ...s, billing: "season" }))} />
                    <span>
                      <span className="bill-name">2026 Season Pass — ${SEASON_PRICE}</span>
                      <span className="bill-desc">Early-bird offer — every remaining 2026 PGA Tour event for one flat $30.</span>
                    </span>
                  </label>
                  <label className={`bill-option ${setup.billing === "annual" ? "selected" : ""}`}>
                    <input type="radio" name="billing" checked={setup.billing === "annual"} onChange={() => setSetup((s) => ({ ...s, billing: "annual" }))} />
                    <span>
                      <span className="bill-name">Annual Pass — ${ANNUAL_PRICE}/year</span>
                      <span className="bill-desc">Unlimited pools for every PGA Tour event, all four majors included. Pays for itself by the fifth event.</span>
                    </span>
                  </label>
                  <label className={`bill-option ${setup.billing === "single" ? "selected" : ""}`}>
                    <input type="radio" name="billing" checked={setup.billing === "single"} onChange={() => setSetup((s) => ({ ...s, billing: "single" }))} />
                    <span>
                      <span className="bill-name">Single event — ${eventFee}</span>
                      <span className="bill-desc">{PRICING_LABEL[selectedEvent.type]} pricing: Majors $75 · all other events $30. Unlimited entries.</span>
                    </span>
                  </label>
                  </>)}
                  <div className="cta-row" style={{ marginTop: 16 }}>
                    <button
                      className="btn btn-primary"
                      disabled={payoutSum !== 100}
                      onClick={async () => {
                        const evName = selectedEvent.name.split(" · ")[0];
                        let poolAfter = dbPool;
                        if (!dbPool && dbClub) {
                          /* FIRST pool for this club: the row must exist in the DB
                             before checkout can publish it — this was silently
                             skipped for years and fresh clubs "published" pools
                             that never left local state */
                          try {
                            const { data: np, error } = await sb
                              .from("pools")
                              .insert({
                                club_id: dbClub.id,
                                published: false,
                                tiebreaker_on: !!setup.tiebreakerOn,
                                entry_fee: Number(setup.entryFee) || 0,
                                deadline: new Date(setup.deadline).toISOString(),
                                rules: setup.rules,
                                payouts: setup.payouts,
                                plan: setup.billing,
                                event_name: evName,
                                scoring: setup.scoring,
                                cut_rule: setup.cutRule,
                                tier_method: setup.tierMethod,
                                max_entries: String(setup.maxEntries),
                                member_edits: !!setup.memberEdits,
                              })
                              .select()
                              .single();
                            if (error) throw error;
                            setDbPool(np);
                            poolAfter = np;
                            setLocked(new Date(np.deadline).getTime() < Date.now());
                          } catch (e) {
                            setSaveMsg("Could not create the pool: " + (e.message || e));
                            return;
                          }
                        }
                        if (dbPool) {
                          try {
                            const poolFields = {
                              entry_fee: Number(setup.entryFee) || 0,
                              deadline: new Date(setup.deadline).toISOString(),
                              rules: setup.rules,
                              payouts: setup.payouts,
                              plan: setup.billing,
                              event_name: evName,
                              scoring: setup.scoring,
                              cut_rule: setup.cutRule,
                              tier_method: setup.tierMethod,
                              max_entries: String(setup.maxEntries),
                              member_edits: !!setup.memberEdits,
                            };
                            const changingEvent = dbPool.event_name && dbPool.event_name !== evName && entries.length > 0;
                            if (changingEvent) {
                              /* the new event gets its own deadline and fresh
                                 rules — nothing inherited from the old pool */
                              if (poolFields.deadline < new Date(selectedEvent.start + "T00:00").toISOString()) {
                                poolFields.deadline = defaultDeadline(selectedEvent);
                              }
                              poolFields.rules = generateRules(setup).map((l) => "\u2022 " + l).join("\n");
                              /* archive the final leaderboard before moving on, so the
                                 shop can pull up past results any time */
                              try {
                                const standings = board.map((b) => ({
                                  pos: b.posLabel,
                                  entry: b.entry,
                                  member: b.member,
                                  total: b.total,
                                  tb: b.tb == null ? null : b.tb,
                                  picks: b.picks.map((pid) => {
                                    const pl = PLAYER_INDEX[pid] || TEAM_INDEX[pid] || { name: pid };
                                    const sc = scores[pid];
                                    return { name: pl.name, score: sc ? (sc.mc ? "MC" : sc.total) : null };
                                  }),
                                }));
                                await sb.from("pool_results").insert({
                                  pool_id: dbPool.id,
                                  club_id: dbPool.club_id,
                                  event_name: dbPool.event_name,
                                  standings,
                                });
                                setPastResults((prev) => [{ pool_id: dbPool.id, club_id: dbPool.club_id, event_name: dbPool.event_name, finalized_at: new Date().toISOString(), standings }, ...prev]);
                              } catch (arcErr) {} /* archive table may not exist yet — never block the save */
                              /* existing entries belong to the old event — start a fresh
                                 pool so history and standings stay intact */
                              try {
                                const { data: np, error } = await sb
                                  .from("pools")
                                  .insert({ club_id: dbPool.club_id, published: false, tiebreaker_on: !!setup.tiebreakerOn, ...poolFields })
                                  .select()
                                  .single();
                                if (error) throw error;
                                setDbPool(np);
                                poolAfter = np;
                                setEntries([]);
                                setLocked(new Date(np.deadline).getTime() < Date.now());
                                setSaveMsg("New pool created for " + evName + " — the previous pool and its entries are preserved.");
                              } catch (err) {
                                try { await savePool(dbPool.id, { ...poolFields, tiebreaker_on: !!setup.tiebreakerOn }); }
                                catch (err2) { await savePool(dbPool.id, poolFields); }
                              }
                            } else {
                              try { await savePool(dbPool.id, { ...poolFields, tiebreaker_on: !!setup.tiebreakerOn }); }
                              catch (err) { await savePool(dbPool.id, poolFields); }
                            }
                          } catch (e) { setSaveMsg("Save failed: " + (e.message || e)); }
                        }
                        /* already paid — this pool or an active pass? republish without checkout */
                        const covered = passActive || !!(poolAfter && poolAfter.paid && poolAfter.event_name === evName);
                        if (covered && poolAfter) {
                          try {
                            await savePool(poolAfter.id, { published: true });
                            setDbPool((p) => (p ? { ...p, published: true } : p));
                            setSetup((s) => ({ ...s, published: true }));
                            setSaveMsg(passActive ? "Changes published — covered by your pass, no new charge." : "Changes published — this pool's platform fee is already paid.");
                          } catch (e) { setSaveMsg("Publish failed: " + (e.message || e)); }
                        } else {
                          setView("checkout");
                        }
                      }}
                    >
                      {feeCovered
                        ? "Publish changes — no new charge"
                        : <>Review &amp; publish · ${setup.billing === "annual" ? ANNUAL_PRICE : setup.billing === "season" ? SEASON_PRICE : eventFee}</>}
                    </button>
                  </div>
                  {!feeCovered && (
                    <p className="pro-note" style={{ marginTop: 16 }}>
                      Next you'll confirm the platform fee and pay by card through Stripe's secure checkout.
                      Member entry fees are separate — those stay with the golf shop.
                    </p>
                  )}
                </section>
              </div>
            )}
          </>
        )}

        {/* ============ CLUB SETTINGS (admin) ============ */}
        {view === "settings" && (
          <>
            <div className="sheet-head">
              <div className="sheet-title">Club Settings</div>
              <div className="sheet-deadline mono" style={{ color: "var(--muted)" }}>Admin · Golf shop only</div>
            </div>
            <p className="sheet-sub">White-label appearance. Changes apply instantly everywhere members see your pools.</p>

            {signupNotice && (
              <section className="set-block" style={{ borderLeft: "4px solid var(--brass)", marginBottom: 18 }}>
                <p className="set-sub" style={{ margin: 0, color: "var(--pine)", fontWeight: 600 }}>{signupNotice}</p>
              </section>
            )}

            <div className="settings-grid">
              <section className="set-block">
                <h3 className="set-title">Pool manager{pros.length > 1 ? "s" : ""}</h3>
                <p className="set-sub">The pro(s) running the pool. Shown in the corner of the Pool Home page so members know who to see.</p>
                {(pros.length ? pros : [{ first: "", last: "" }]).map((p, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                    <input className="club-name-input" style={{ flex: 1, minWidth: 0 }} placeholder="First name" value={p.first || ""} aria-label="Pro first name"
                      onChange={(e) => setPros((arr) => { const a = arr.length ? [...arr] : [{ first: "", last: "" }]; a[i] = { ...a[i], first: e.target.value }; return a; })} />
                    <input className="club-name-input" style={{ flex: 1, minWidth: 0 }} placeholder="Last name" value={p.last || ""} aria-label="Pro last name"
                      onChange={(e) => setPros((arr) => { const a = arr.length ? [...arr] : [{ first: "", last: "" }]; a[i] = { ...a[i], last: e.target.value }; return a; })} />
                    <label className="mono" style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, letterSpacing: "0.08em", color: "var(--muted)", cursor: "pointer", whiteSpace: "nowrap" }} title="Show “, PGA” after this name">
                      <input type="checkbox" checked={!!p.pga}
                        onChange={(e) => setPros((arr) => { const a = arr.length ? [...arr] : [{ first: "", last: "" }]; a[i] = { ...a[i], pga: e.target.checked }; return a; })} />
                      PGA
                    </label>
                    {pros.length > 1 && (
                      <button className="btn btn-ghost" style={{ padding: "0 14px" }} aria-label="Remove pro" onClick={() => setPros((arr) => arr.filter((_, j) => j !== i))}>&times;</button>
                    )}
                  </div>
                ))}
                <button className="remove-link" style={{ color: "var(--pine)", textTransform: "none", letterSpacing: 0, fontSize: 13.5 }}
                  onClick={() => setPros((arr) => (arr.length ? [...arr, { first: "", last: "" }] : [{ first: "", last: "" }, { first: "", last: "" }]))}>
                  + Add another pro
                </button>
              </section>
              <section className="set-block">
                <h3 className="set-title">Club name</h3>
                <input
                  className="club-name-input"
                  value={clubName}
                  onChange={(e) => setClubName(e.target.value)}
                  aria-label="Club name"
                  placeholder="Your Club Name"
                />
              </section>

              <section className="set-block">
                <h3 className="set-title">Masthead tagline</h3>
                <p className="set-sub">The small line under your club name. Say what fits your club — or clear it to remove the line entirely.</p>
                <input
                  className="club-name-input"
                  placeholder="e.g. Est. 1921 · Member Pools"
                  value={tagline}
                  onChange={(e) => setTagline(e.target.value)}
                  maxLength={60}
                  aria-label="Masthead tagline"
                />
                {tagline.trim() === "" && <span className="seg-hint">Tagline hidden — the masthead will show the club name only</span>}
              </section>

              <section className="set-block">
                <h3 className="set-title">Club logo</h3>
                <p className="set-sub">PNG or SVG with a transparent background works best. Appears in the masthead, member emails, and printed standings.</p>
                <div className="logo-row">
                  <div className="logo-preview" style={{ background: logoUrl ? logoBgColor : undefined }}>
                    {logoUrl ? <img src={logoUrl} alt="Club logo preview" /> : (noLogo ? <span className="club-name display" style={{ fontSize: 15, textAlign: "center", lineHeight: 1.15, padding: "0 6px" }}>{clubName || "Your Golf Club"}</span> : <Crest />)}
                  </div>
                  <label className="btn btn-ghost upload-label">
                    {logoUrl ? "Replace logo" : "Upload logo"}
                    <input type="file" accept="image/*" className="file-hidden" onChange={(e) => { setNoLogo(false); handleLogoUpload(e); }} />
                  </label>
                  {logoUrl && (
                    <button className="remove-link" onClick={() => setLogoUrl(null)}>
                      Remove logo
                    </button>
                  )}
                </div>
                {!logoUrl && (
                  <label className="check-row" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, cursor: "pointer" }}>
                    <input type="checkbox" checked={noLogo} onChange={(e) => setNoLogo(e.target.checked)} aria-label="Show no logo" />
                    <span>Show no logo — display the club name on its own (no crest)</span>
                  </label>
                )}
                {logoUrl && (
                  <div style={{ marginTop: 14 }}>
                    <span className="field-k">Logo background</span>
                    <div className="seg allow-wrap" role="radiogroup" aria-label="Logo background">
                      {[
                        { v: "transparent", label: "Transparent" },
                        { v: "white", label: "White" },
                        { v: "cream", label: "Cream" },
                        { v: "club", label: "Club color" },
                      ].map((o) => (
                        <button key={o.v} className={`seg-btn ${logoBg === o.v ? "on" : ""}`} onClick={() => setLogoBg(o.v)} aria-pressed={logoBg === o.v}>
                          {o.label}
                        </button>
                      ))}
                    </div>
                    <span className="seg-hint">Square tile behind the logo — pick whichever suits your artwork</span>
                  </div>
                )}
              </section>

              <section className="set-block">
                <h3 className="set-title">Theme palette</h3>
                <p className="set-sub">Classic clubhouse colorways. The accent carries through the tabs, picksheet, and scoreboard.</p>
                <div className="swatches">
                  {THEMES.map((t) => (
                    <button
                      key={t.id}
                      className={`swatch ${themeId === t.id ? "selected" : ""}`}
                      onClick={() => setThemeId(t.id)}
                      aria-pressed={themeId === t.id}
                    >
                      <span className="swatch-chip">
                        <span style={{ background: t.pine }} />
                        <span style={{ background: t.brassBright }} />
                      </span>
                      <span className="swatch-name">{t.name}</span>
                    </button>
                  ))}
                  <button
                    className={`swatch ${themeId === "custom" ? "selected" : ""}`}
                    onClick={() => setThemeId("custom")}
                    aria-pressed={themeId === "custom"}
                  >
                    <span className="swatch-chip">
                      <span style={{ background: deriveCustomTheme(custom.primary, custom.accent).pine }} />
                      <span style={{ background: deriveCustomTheme(custom.primary, custom.accent).brassBright }} />
                    </span>
                    <span className="swatch-name">Your Colors</span>
                  </button>
                </div>

                <div className="custom-colors">
                  <span className="field-k" style={{ marginTop: 4 }}>Or use your club's exact colors</span>
                  {[
                    { key: "primary", label: "Primary", desc: "Masthead, buttons & scoreboard" },
                    { key: "accent", label: "Accent", desc: "Trim, tabs & highlights" },
                  ].map(({ key, label, desc }) => (
                    <div className="color-row" key={key}>
                      <input
                        type="color"
                        className="color-input"
                        value={custom[key]}
                        onChange={(e) => setCustomColor(key, e.target.value)}
                        aria-label={`${label} color picker`}
                      />
                      <input
                        type="text"
                        className="club-name-input hex-input mono"
                        value={hexDraft[key]}
                        onChange={(e) => setCustomColor(key, e.target.value)}
                        placeholder="#15382B"
                        aria-label={`${label} hex code`}
                        maxLength={7}
                      />
                      <span className="color-label">
                        <span className="bill-name" style={{ fontSize: 14 }}>{label}</span>
                        <span className="bill-desc">{desc}</span>
                      </span>
                    </div>
                  ))}
                  {[
                    { key: "primary", label: "Primary shades" },
                    { key: "accent", label: "Accent shades" },
                  ].map(({ key, label }) => (
                    <div key={key} style={{ marginTop: 12 }}>
                      <span className="field-k" style={{ marginBottom: 5 }}>{label}</span>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {COLOR_BOARD[key].map((hex) => (
                          <button
                            key={hex}
                            onClick={() => setCustomColor(key, hex)}
                            aria-label={`Set ${key} color to ${hex}`}
                            title={hex}
                            style={{
                              width: 30, height: 30, background: hex, cursor: "pointer", padding: 0,
                              border: custom[key].toUpperCase() === hex.toUpperCase() ? "2.5px solid var(--brass)" : "1.5px solid var(--paper-line)",
                              borderRadius: 3,
                            }}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                  <span className="seg-hint">
                    Tap a shade above, use the picker square for any color at all, or paste your exact hex code (it's in your club's logo files or brand guide). Darker shades and readable text are handled automatically.
                  </span>
                </div>
              </section>
              <section className="set-block" style={{ borderLeft: "4px solid var(--brass)" }}>
                <h3 className="set-title">Club admins</h3>
                <p className="set-sub">
                  Invite other pros or golf shop staff to help manage your club and pools.
                  <strong> Additional admins are free — there is no extra charge for adding users.</strong>
                </p>
                {inviteLink ? (
                  <>
                    <div className="mono" style={{ fontSize: 13.5, color: "var(--pine)", background: "#FCF9EF", border: "1px solid var(--paper-line)", padding: "12px 14px", userSelect: "all", wordBreak: "break-all" }}>{inviteLink}</div>
                    <div className="cta-row" style={{ marginTop: 10 }}>
                      <button className="btn btn-ghost" onClick={() => { try { navigator.clipboard.writeText(inviteLink); setSaveMsg("Invite link copied."); } catch (e) {} }}>Copy invite link</button>
                    </div>
                  </>
                ) : (
                  <p className="set-sub" style={{ color: "var(--muted)" }}>Your invite link is being prepared — reopen this page in a minute.</p>
                )}
                <p className="set-sub" style={{ marginTop: 12, color: "var(--under)", fontWeight: 600 }}>
                  Do not share this link with members. Anyone who opens it can edit your pools and club settings —
                  it is for your staff only. Members get the members' link on the Pool Setup page instead.
                </p>
                <h3 className="set-title" style={{ marginTop: 18 }}>Registered admins</h3>
                {clubAdmins.length === 0 ? (
                  <p className="set-sub" style={{ color: "var(--muted)" }}>Only you so far.</p>
                ) : (
                  clubAdmins.map((a, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "7px 0", borderBottom: "1px dotted var(--paper-line)", fontSize: 13.5, fontFamily: "'Source Serif 4', serif" }}>
                      <span style={{ color: "var(--pine)", fontWeight: 600, overflowWrap: "anywhere" }}>{a.email || "(no email on file)"}</span>
                      <span className="mono" style={{ fontSize: 11, color: "var(--muted)", whiteSpace: "nowrap" }}>
                        {String(a.role || "pro").toUpperCase()}{a.joined ? " · since " + new Date(a.joined).toLocaleDateString([], { month: "short", year: "numeric" }) : ""}
                      </span>
                    </div>
                  ))
                )}
              </section>
            </div>

            {dbClub && (role === "pro" || role === "owner") && (
              <div className="cta-row">
                <button
                  className="btn btn-primary"
                  onClick={async () => {
                    const theme = { themeId, logoBg, noLogo, tagline: tagline.trim(), pros: pros.map((p) => ({ first: ((p && p.first) || "").trim(), last: ((p && p.last) || "").trim(), pga: !!(p && p.pga) })).filter((p) => p.first || p.last) };
                    const newSlug = clubName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || dbClub.slug;
                    try {
                      /* keep the members' link in sync with the club name */
                      await saveClub(dbClub.id, { name: clubName, slug: newSlug, theme });
                      setDbClub((c) => ({ ...c, name: clubName, slug: newSlug, theme }));
                      setSaveMsg("Branding saved." + (newSlug !== dbClub.slug ? " Your members' link updated too." : ""));
                    } catch (e) {
                      /* slug collision or policy error — save everything else and keep the old link */
                      try {
                        await saveClub(dbClub.id, { name: clubName, theme });
                        setDbClub((c) => ({ ...c, name: clubName, theme }));
                        setSaveMsg("Branding saved (members' link unchanged).");
                      } catch (e2) { setSaveMsg("Save failed: " + (e2.message || e2)); }
                    }
                  }}
                >
                  Save branding
                </button>
                {saveMsg && <span className="count" style={{ alignSelf: "center" }}>{saveMsg}</span>}
              </div>
            )}

            <p className="pro-note">
              In production this page lives on the club admin account — the golf shop sets branding once
              and every pool, invite email, and grill-room printout inherits it.
            </p>
          </>
        )}

        {/* ============ PLATFORM (owner) ============ */}

        {/* ============ CHECKOUT (club pays platform fee) ============ */}
        {view === "checkout" && (role === "pro" || role === "owner") && (() => {
          const plan = setup.billing;
          const fee = plan === "annual" ? ANNUAL_PRICE : plan === "season" ? SEASON_PRICE : eventFee;
          const payUrl = stripeCheckoutUrl(plan, dbClub, profile && profile.email, selectedEvent.type);
          async function payAndPublish() {
            if (plan === "season" && !payUrl) {
              alert("The 2026 Season Pass checkout isn't configured yet — choose another plan or try again shortly.");
              return;
            }
            /* publish FIRST, loudly — a silent failure here once let pros pay
               for pools that never reached the database */
            if (!dbPool) {
              alert("No pool draft found to publish — go back to Pool Setup and press Review & publish again.");
              return;
            }
            try {
              await savePool(dbPool.id, { published: true, plan });
              setDbPool((p) => (p ? { ...p, published: true, plan } : p));
            } catch (e) {
              alert("The pool could not be published: " + ((e && e.message) || e) + "\nNo charge was made — please try again or contact support.");
              return;
            }
            setSetup((s) => ({ ...s, published: true }));
            if (payUrl) window.open(payUrl, "_blank", "noopener");
          }
          return (
            <div className="settings-grid" style={{ maxWidth: 560, margin: "0 auto" }}>
              <section className="set-block">
                <h3 className="set-title">Checkout — platform fee</h3>
                {!setup.published ? (
                  <>
                    <p className="set-sub">Confirm the fee your club pays ClubMajors to run this pool. Members' entry fees are collected separately by the golf shop. Have a ClubMajors promo code? You can enter it on the payment page.</p>
                    <div className="facts" style={{ border: "1px solid var(--paper-line)", gridTemplateColumns: "1fr 1fr" }}>
                      <div className="fact"><div className="fact-k">Club</div><div className="fact-v">{dbClub ? dbClub.name : clubName}</div></div>
                      <div className="fact"><div className="fact-k">Plan</div><div className="fact-v">{plan === "annual" ? "Annual Pass" : plan === "season" ? "2026 Season Pass" : PRICING_LABEL[selectedEvent.type]}</div></div>
                      <div className="fact"><div className="fact-k">Event</div><div className="fact-v" style={{ fontSize: 14 }}>{selectedEvent.name.split(" · ")[0]}</div></div>
                      <div className="fact"><div className="fact-k">Total due</div><div className="fact-v mono">${fee}{plan === "annual" ? "/yr" : ""}</div></div>
                    </div>
                    <div className="cta-row" style={{ marginTop: 18 }}>
                      <button className="btn btn-primary" onClick={payAndPublish}>
                        {payUrl ? `Pay $${fee} by card` : `Publish pool ($${fee} invoice)`}
                      </button>
                      <button className="btn btn-ghost" onClick={() => setView("setup")}>Back to setup</button>
                    </div>
                    {payUrl ? (
                      <p className="pro-note" style={{ marginTop: 16 }}>Opens Stripe's secure checkout in a new tab. Your card details go straight to Stripe — ClubMajors never sees them.</p>
                    ) : (
                      <p className="pro-note" style={{ marginTop: 16 }}>Card checkout turns on once Stripe is connected. For now the pool publishes and the fee is billed by invoice.</p>
                    )}
                  </>
                ) : (
                  <>
                    <h3 className="set-title" style={{ borderColor: "var(--brass)" }}>Pool published 🎉</h3>
                    <p className="set-sub">Your members can enter now. Share this link with them — it opens straight to your club's pool:</p>
                    <div className="mono" style={{ fontSize: 15, color: "var(--pine)", background: "#FCF9EF", border: "1px solid var(--paper-line)", padding: "12px 14px", userSelect: "all", wordBreak: "break-all" }}>{memberLink}</div>
                    <div className="cta-row" style={{ marginTop: 16 }}>
                      <button className="btn btn-primary" onClick={() => setView("picks")}>Preview member picksheet</button>
                      {payUrl && <button className="btn btn-ghost" onClick={() => window.open(payUrl, "_blank", "noopener")}>Pay fee now</button>}
                    </div>
                  </>
                )}
              </section>
            </div>
          );
        })()}

        {/* ============ CLUB SIGNUP (self-serve pro onboarding) ============ */}
        {view === "signup" && !session && (
          <div className="settings-grid" style={{ maxWidth: 520, margin: "0 auto" }}>
            <section className="set-block">
              <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 18 }}>
                <CMLogo size={44} />
                <div>
                  <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 24, lineHeight: 1, letterSpacing: "-0.035em", color: "#16130F" }}>ClubMajors</div>
                  <div className="mono" style={{ fontSize: 9, letterSpacing: "0.28em", textTransform: "uppercase", color: "#6B6862", marginTop: 6 }}>Pools for private clubs</div>
                </div>
              </div>
              <h3 className="set-title">Set up your club</h3>
              {signupState === "sent" ? (
                <p className="set-sub" style={{ color: "var(--pine)" }}>
                  Check <strong>{signupEmail}</strong> — we sent a sign-in link. Click it and your club will be ready to publish its first pool.
                </p>
              ) : (
                <>
                  <p className="set-sub">Run major-championship pools for your members. Enter your club and email — we'll set you up and send a one-time sign-in link.</p>
                  <label className="field" style={{ marginTop: 0 }}>
                    <span className="field-k">Club name</span>
                    <input className="club-name-input" placeholder="e.g., Riverside Country Club"
                      value={signupClub} onChange={(e) => setSignupClub(e.target.value)} aria-label="Club name" />
                  </label>
                  <label className="field">
                    <span className="field-k">Your email (golf shop / pro)</span>
                    <input className="club-name-input" type="email" placeholder="pro@yourclub.com"
                      value={signupEmail} onChange={(e) => setSignupEmail(e.target.value)} aria-label="Email" />
                  </label>
                  {/* Referred-by input removed Jul 2026 (Jerry) — ?ref= links still credit referrals via localStorage */}
                  <div className="cta-row" style={{ marginTop: 16 }}>
                    <button className="btn btn-primary" onClick={handleSignup} disabled={signupState === "sending"}>
                      {signupState === "sending" ? "Setting up…" : "Create my club"}
                    </button>
                    <button className="btn btn-ghost" onClick={() => setView("signin")}>Already set up? Sign in</button>
                  </div>
                  {signupState === "error" && <p className="set-sub" style={{ marginTop: 12, color: "var(--under)" }}>Something went wrong. Try again in a minute.</p>}
                </>
              )}
            </section>
          </div>
        )}

        {/* ============ CLUB ADMIN / ACCOUNT ============ */}
        {view === "signin" && (
          <div className="settings-grid" style={{ maxWidth: 520, margin: "0 auto" }}>
            <section className="set-block">
              <h3 className="set-title">{session ? "Account" : INVITE ? "Join your golf shop on ClubMajors" : "Club Admin Sign In"}</h3>
              {INVITE && !session && (
                <p className="set-sub" style={{ borderLeft: "3px solid var(--brass)", paddingLeft: 10 }}>
                  You've been invited to help manage a club's pools. Sign in below if you already have an account —
                  or create one — and you'll be connected to the club automatically.
                </p>
              )}
              {inviteMsg && <p className="set-sub" style={{ color: inviteMsg.indexOf("Could not") === 0 ? "var(--under)" : "var(--pine)", fontWeight: 600 }}>{inviteMsg}</p>}
              {session ? (
                <>
                  <p className="set-sub">
                    Signed in as <strong>{session.user.email}</strong> · role: <strong>{role}</strong>
                    {dbClub ? " · " + dbClub.name : ""}
                  </p>
                  <button className="btn btn-ghost" onClick={() => signOut()}>Sign out</button>
                  {role === "pending" && !selfServeErr && (
                    <p className="set-sub" style={{ color: "var(--under)" }}>
                      Setting up your club — this takes a few seconds…
                    </p>
                  )}
                  {role === "pending" && selfServeErr && (
                    <p className="set-sub" style={{ color: "var(--under)" }}>
                      {selfServeTry < 5
                        ? "Hit a snag setting up your club (" + selfServeErr + ") — retrying automatically…"
                        : "We couldn't finish setting up your club: " + selfServeErr + ". Please email support@clubmajorsgolf.com and we'll fix it right away."}
                    </p>
                  )}
                  {isAdminRole && dbClub && (
                    <div style={{ marginTop: 18, borderTop: "1px dotted var(--paper-line)", paddingTop: 14 }}>
                      <h3 className="set-title" style={{ fontSize: 14 }}>Billing</h3>
                      <p className="set-sub">
                        {passActive
                          ? (dbClub.plan === "annual" ? "Annual Pass" : "2026 Season Pass") + " active" +
                            (dbClub.paid_until ? " through " + new Date(dbClub.paid_until).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }) : "") +
                            ". Cancel any time — your pass stays active through the end of the paid period."
                          : "View invoices or manage your club's subscription."}
                      </p>
                      <button className="btn btn-ghost" onClick={openBillingPortal}>Manage subscription</button>
                    </div>
                  )}
                  <div style={{ marginTop: 18, borderTop: "1px dotted var(--paper-line)", paddingTop: 14 }}>
                    <h3 className="set-title" style={{ fontSize: 14 }}>Change password</h3>
                    <p className="set-sub">
                      {recovery
                        ? "Finish resetting your password:"
                        : "Set or change your password — after this you can sign in with email + password directly."}
                    </p>
                    <input
                      className="club-name-input" type="password" placeholder="New password (min 8 characters)"
                      value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
                      aria-label="New password"
                    />
                    <div className="cta-row" style={{ marginTop: 10 }}>
                      <button
                        className="btn btn-ghost btn-small"
                        disabled={newPassword.length < 8}
                        onClick={async () => {
                          try {
                            const { error } = await sb.auth.updateUser({ password: newPassword });
                            if (error) throw error;
                            setPwMsg("Password saved — you can now sign in with email + password.");
                            setNewPassword("");
                            setRecovery(false);
                          } catch (err) {
                            setPwMsg("Could not save password: " + ((err && err.message) || err));
                          }
                        }}
                      >
                        Save password
                      </button>
                    </div>
                    {pwMsg && <p className="set-sub" style={{ marginTop: 8 }}>{pwMsg}</p>}
                  </div>
                  {(role === "pro" || role === "owner") && dbClub && (
                    <div style={{ borderTop: "1px dotted var(--paper-line)", marginTop: 14, paddingTop: 14 }}>
                      <h3 className="set-title" style={{ fontSize: 14 }}>Refer another club</h3>
                      <p className="set-sub">Know a pro at another club? Share your referral link — when their club signs up through it, your club is credited as the referrer.</p>
                      <div className="mono" style={{ fontSize: 13, color: "var(--pine)", background: "#FCF9EF", border: "1px solid var(--paper-line)", padding: "10px 12px", userSelect: "all", wordBreak: "break-all" }}>{window.location.origin + "/?ref=" + dbClub.slug}</div>
                      <div className="cta-row" style={{ marginTop: 8 }}>
                        <button className="btn btn-ghost" onClick={() => { try { navigator.clipboard.writeText(window.location.origin + "/?ref=" + dbClub.slug); setSaveMsg("Referral link copied."); } catch (e) {} }}>Copy referral link</button>
                      </div>
                      {refPromo && <p className="set-sub" style={{ color: "var(--pine)", fontWeight: 600, marginTop: 10, borderLeft: "3px solid var(--brass)", paddingLeft: 10 }}>{refPromo}</p>}
                      {saveMsg === "Referral link copied." && <p className="set-sub" style={{ color: "var(--pine)" }}>{saveMsg}</p>}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <p className="set-sub">
                    For the golf shop only. Members don't sign in — they just make their picks.
                  </p>
                  <input
                    className="club-name-input" type="email" placeholder="pro@yourclub.com"
                    value={authEmail} onChange={(e) => setAuthEmail(e.target.value)}
                    aria-label="Email address"
                  />
                  <input
                    className="club-name-input" type="password" placeholder="Password"
                    style={{ marginTop: 8 }}
                    value={authPassword} onChange={(e) => setAuthPassword(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handlePasswordSignIn(); }}
                    aria-label="Password"
                  />
                  <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, color: "var(--muted)", cursor: "pointer", userSelect: "none", fontFamily: "'Source Serif 4', serif" }}>
                    <input type="checkbox" checked={rememberMe} onChange={(e) => setRememberMe(e.target.checked)} style={{ accentColor: "var(--pine)", width: 15, height: 15 }} />
                    Remember me on this device
                  </label>
                  <div className="cta-row" style={{ marginTop: 14 }}>
                    <button className="btn btn-primary" onClick={handlePasswordSignIn} disabled={authState === "signing" || !authEmail.trim() || !authPassword}>
                      {authState === "signing" ? "Signing in…" : "Sign in"}
                    </button>
                    <button className="btn btn-ghost" onClick={handleSignIn} disabled={authState === "sending"}>
                      {authState === "sending" ? "Sending…" : "Email me a sign-in link instead"}
                    </button>
                  </div>
                  {INVITE && (
                    <div className="cta-row" style={{ marginTop: 10 }}>
                      <button className="btn btn-ghost" style={{ borderColor: "var(--brass)" }} onClick={handleInviteSignup} disabled={authState === "signing" || !authEmail.trim() || authPassword.length < 8}>
                        New here? Create account &amp; join (password 8+ characters)
                      </button>
                    </div>
                  )}
                  {authState === "badpass" && <p className="set-sub" style={{ marginTop: 12, color: "var(--under)" }}>Wrong email or password. First time using a password? Sign in with the email link once, then set a password under Account.</p>}
                  {authState === "sent" && <p className="set-sub" style={{ marginTop: 12, color: "var(--pine)" }}>Check your inbox — the link signs you straight in.</p>}
                  {authState === "error" && <p className="set-sub" style={{ marginTop: 12, color: "var(--under)" }}>Could not send the email. Check the address and try again in a minute.</p>}
                  <p className="set-sub" style={{ marginTop: 10 }}>
                    <button className="remove-link" style={{ color: "var(--muted)", textTransform: "none", letterSpacing: 0, fontSize: 13 }} onClick={handlePasswordReset}>
                      Forgot password? Email me a reset link
                    </button>
                  </p>
                  <p className="set-sub" style={{ marginTop: 18, borderTop: "1px dotted var(--paper-line)", paddingTop: 16 }}>
                    New to ClubMajors?{" "}
                    <button className="remove-link" style={{ color: "var(--pine)", textTransform: "none", letterSpacing: 0, fontSize: 13.5 }} onClick={() => setView("signup")}>
                      Set up your club →
                    </button>
                  </p>
                </>
              )}
            </section>
          </div>
        )}

        <footer className="powered">
          <span style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}><CMLogo size={26} /></span>
          Powered by <b>ClubMajors</b> · Golf tournament pool software for private clubs
          <span style={{ display: "block", marginTop: 36, paddingTop: 14, borderTop: "1px dotted var(--paper-line)", fontSize: 11.5, lineHeight: 1.7, opacity: 0.75, width: "100%", textAlign: "left", textTransform: "none", letterSpacing: "0.02em", fontFamily: "'Source Serif 4', serif" }}>
            ClubMajors provides pool-management software for entertainment purposes only. We do not accept, hold, or
            pay out entry fees, wagers, or prizes, and we do not facilitate gambling of any kind. The platform fee paid
            by clubs covers software services (picksheets, live scoring, leaderboards) only. Entry fees and prizes, if
            any, are administered entirely by the host club, which is solely responsible for its pool's compliance with
            applicable laws. Participation is limited to eligible members and guests where permitted by law. Void where
            prohibited.
          </span>
        </footer>
      </main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<ClubMajorsPrototype />);
