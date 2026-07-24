/* ============================================================
   ClubMajors score feed
   ------------------------------------------------------------
   ARCHITECTURE
   1. PROVIDER ABSTRACTION — every score source lives in PROVIDERS
      and returns the same normalized shape:
        [{ firstName, lastName, total, today, thru, cut }]
      Nothing outside this file knows where scores come from, and
      inside this file nothing outside PROVIDERS knows either.
      To swap vendors (DataGolf, Sportradar, Goalserve…): add a
      provider entry, set SCORE_PROVIDER env var. No other code moves.
   2. CACHE-AND-SERVE-STALE — every good fetch is written to
      public.score_cache. If the provider errors, the last good
      board is served with stale:true + its original timestamp so
      the app can show "scores as of 2:41 PM" instead of breaking.
   Env: SLASHGOLF_KEY, SLASHGOLF_TOURN_ID (100), SLASHGOLF_YEAR,
        SLASHGOLF_ORG_ID (1), SCORE_PROVIDER (slashgolf),
        SUPA_MGMT_TOKEN (cache persistence)
   ============================================================ */

const KEY = process.env.SLASHGOLF_KEY || "";
const DG_KEY = process.env.DATAGOLF_KEY || "";

/* DataGolf names arrive "Lastname, Firstname" */
function dgName(n) {
  const parts = String(n || "").split(",").map((x) => x.trim());
  if (parts.length >= 2) return { firstName: parts.slice(1).join(" "), lastName: parts[0] };
  const sp = String(n || "").trim().split(/\s+/);
  return { firstName: sp.slice(0, -1).join(" "), lastName: sp[sp.length - 1] || "" };
}
const ENV_TOURN = process.env.SLASHGOLF_TOURN_ID || "";  /* optional pin; normally auto-detected */
const YEAR = process.env.SLASHGOLF_YEAR || String(new Date().getFullYear());
const ORG = process.env.SLASHGOLF_ORG_ID || "1";
/* resolved per invocation — never hardcoded to one tournament */
const CURRENT = { tourn: null, name: null };

/* Which tournament is "now"? Priority:
   1. platform_config key score_tournid (owner override, one SQL away)
   2. the vendor's own schedule: the event whose window covers today,
      else the next upcoming one
   3. SLASHGOLF_TOURN_ID env pin, if set
   Memoized 1h per warm lambda. */
let tournMemo = { value: null, name: null, at: 0 };
async function resolveTournament() {
  if (tournMemo.value && Date.now() - tournMemo.at < 3600000) return tournMemo;
  let value = null, name = null;
  if (SUPA_TOKEN) {
    try {
      const rows = await sql("SELECT value FROM public.platform_config WHERE key = 'score_tournid' LIMIT 1;");
      if (rows.length && rows[0].value) value = String(rows[0].value);
    } catch (e) {}
  }
  if (!value && KEY) {
    try {
      const res = await fetch("https://live-golf-data.p.rapidapi.com/schedule?orgId=" + ORG + "&year=" + YEAR, {
        headers: { "x-rapidapi-key": KEY, "x-rapidapi-host": "live-golf-data.p.rapidapi.com" },
      });
      if (res.ok) {
        const data = JSON.parse(await res.text());
        const events = [];
        (function walk(node) {
          if (!node || typeof node !== "object") return;
          if (Array.isArray(node)) { for (const x of node) walk(x); return; }
          const id = node.tournId !== undefined ? String(typeof node.tournId === "object" ? Object.values(node.tournId)[0] : node.tournId) : null;
          const nm = node.name || node.tournName || null;
          if (id && nm) {
            const millis = [];
            (function dig(n2) {
              if (!n2 || typeof n2 !== "object") return;
              if (Array.isArray(n2)) { for (const x of n2) dig(x); return; }
              for (const k of Object.keys(n2)) {
                if (k === "$numberLong" || k === "$date") {
                  const v = typeof n2[k] === "object" ? Object.values(n2[k])[0] : n2[k];
                  const m = Number(v);
                  if (!Number.isNaN(m) && m > 1e12) millis.push(m);
                } else if (n2[k] && typeof n2[k] === "object") dig(n2[k]);
              }
            })(node);
            if (millis.length) events.push({ id, name: nm, start: Math.min(...millis), end: Math.max(...millis) });
          }
          for (const k of Object.keys(node)) walk(node[k]);
        })(data);
        const now = Date.now(), DAY = 86400000;
        const active = events.find((e) => now >= e.start - DAY && now <= e.end + DAY);
        const upcoming = events.filter((e) => e.start > now).sort((a, b) => a.start - b.start)[0];
        const pick = active || upcoming || null;
        if (pick) { value = pick.id; name = pick.name; }
      }
    } catch (e) {}
  }
  if (!value) value = ENV_TOURN || "100";
  tournMemo = { value, name, at: Date.now() };
  return tournMemo;
}
const ENV_PROVIDER = process.env.SCORE_PROVIDER || "slashgolf";
const SUPA_TOKEN = process.env.SUPA_MGMT_TOKEN || "";
const REF = "tocnkbgxbnvznhwpfgpa";
const cacheKeyFor = (prov) => prov + ":" + ORG + ":" + (CURRENT.tourn || "auto") + ":" + YEAR;

/* The active provider is a one-click platform setting (public.platform_config,
   key score_provider) so the owner can switch every club's data source
   mid-tournament without a deploy. Memoized 60s per warm lambda. */
let provMemo = { value: null, at: 0 };
async function activeProviderName() {
  if (provMemo.value && Date.now() - provMemo.at < 60000) return provMemo.value;
  let v = ENV_PROVIDER;
  if (SUPA_TOKEN) {
    try {
      const rows = await sql("SELECT value FROM public.platform_config WHERE key = 'score_provider' LIMIT 1;");
      if (rows.length && rows[0].value) v = rows[0].value;
    } catch (e) {}
  }
  provMemo = { value: v, at: Date.now() };
  return v;
}

/* ---------- shared normalizers ---------- */
function num(v) {
  if (v && typeof v === "object") {
    const k = Object.keys(v)[0];
    if (k && k.indexOf("$number") === 0) return Number(v[k]);
    return null;
  }
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}
function toPar(v) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  const t = String(v).trim().toUpperCase();
  if (t === "E") return 0;
  const n = Number(t.replace("+", ""));
  return Number.isNaN(n) ? null : n;
}
function parseThru(t) {
  if (t == null) return 0;
  const s = String(t).toUpperCase().replace("*", "").trim();
  if (s.indexOf("F") === 0) return 18;
  const n = Number(s);
  return Number.isNaN(n) ? 0 : n;
}
function collectRows(node, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const x of node) collectRows(x, out); return; }
  const first = node.firstName, last = node.lastName;
  const totalRaw =
    node.total !== undefined ? node.total :
    node.totalStrokesFromPar !== undefined ? node.totalStrokesFromPar :
    node.scoreToPar !== undefined ? node.scoreToPar : undefined;
  if (typeof first === "string" && typeof last === "string" && totalRaw !== undefined) {
    const statusBlob = String(node.status || "") + " " + String(node.position || "");
    let rounds;
    if (Array.isArray(node.rounds)) {
      rounds = node.rounds
        .map((r) => (r && typeof r === "object" ? num(r.strokes !== undefined ? r.strokes : r.score !== undefined ? r.score : r.total) : num(r)))
        .filter((x) => x !== null && x > 50 && x < 110);
      if (!rounds.length) rounds = undefined;
    }
    out.push({
      firstName: first,
      lastName: last,
      total: toPar(totalRaw),
      today: toPar(node.currentRoundScore !== undefined ? node.currentRoundScore : node.today),
      thru: parseThru(node.thru !== undefined ? node.thru : node.currentHole),
      cut: /cut|wd|dq/i.test(statusBlob),
      rounds,
    });
  }
  for (const k of Object.keys(node)) collectRows(node[k], out);
}
/* authoritative course par from the vendor payload: only reported when the
   event has exactly ONE distinct total par (multi-course rotations -> null,
   and the app falls back to raw strokes rather than risk a wrong +/-) */
function extractPar(data) {
  const pars = [];
  (function scan(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const x of node) scan(x); return; }
    for (const k of Object.keys(node)) {
      const v = num(node[k]);
      if ((k === "parTotal" || k === "par" || k === "coursePar" || k === "totalPar") && v !== null && v >= 66 && v <= 74) pars.push(v);
      else if (node[k] && typeof node[k] === "object") scan(node[k]);
    }
  })(data);
  const distinct = [...new Set(pars)];
  return distinct.length === 1 ? distinct[0] : null;
}

function dedupe(rows) {
  const seen = new Map();
  for (const r of rows) {
    const k = (r.firstName + " " + r.lastName).toLowerCase();
    const prev = seen.get(k);
    if (!prev || (prev.total == null && r.total != null)) seen.set(k, r);
  }
  return [...seen.values()].filter((r) => r.total != null || r.cut);
}

/* ---------- providers ---------- */
const PROVIDERS = {
  slashgolf: {
    name: "SlashGolf",
    async fetch() {
      if (!KEY) throw new Error("SLASHGOLF_KEY env var is not set");
      const qs = "orgId=" + ORG + "&tournId=" + CURRENT.tourn + "&year=" + YEAR;
      const variants = [
        { name: "rapidapi", url: "https://live-golf-data.p.rapidapi.com/leaderboard?" + qs, headers: { "x-rapidapi-key": KEY, "x-rapidapi-host": "live-golf-data.p.rapidapi.com" } },
        { name: "slashgolf-direct-bearer", url: "https://api.slashgolf.dev/leaderboard?" + qs, headers: { Authorization: "Bearer " + KEY } },
        { name: "slashgolf-direct-query", url: "https://api.slashgolf.dev/leaderboard?" + qs + "&apiKey=" + encodeURIComponent(KEY), headers: {} },
      ];
      const attempts = [];
      for (const v of variants) {
        try {
          const res = await fetch(v.url, { headers: v.headers });
          const text = await res.text();
          if (!res.ok) { attempts.push({ variant: v.name, status: res.status, snippet: text.slice(0, 140).replace(KEY, "***") }); continue; }
          let data;
          try { data = JSON.parse(text); } catch (e) { attempts.push({ variant: v.name, status: res.status, snippet: "non-JSON" }); continue; }
          const rows = [];
          collectRows(data, rows);
          const players = dedupe(rows);
          if (players.length === 0) { attempts.push({ variant: v.name, status: res.status, snippet: "200 OK, no rows (pre-round?)" }); continue; }
          return { players, meta: { variant: v.name, vendorUpdated: data.lastUpdated || data.lastUpdatedTime || null, coursePar: extractPar(data) } };
        } catch (e) {
          attempts.push({ variant: v.name, status: "network-error", snippet: String((e && e.message) || e).replace(KEY, "***").slice(0, 140) });
        }
      }
      /* leaderboard empty (pre-tournament)? fall back to the tournament FIELD
         so picksheets can be built before play starts — names only, no scores */
      try {
        const res = await fetch("https://live-golf-data.p.rapidapi.com/tournament?orgId=" + ORG + "&tournId=" + CURRENT.tourn + "&year=" + YEAR, {
          headers: { "x-rapidapi-key": KEY, "x-rapidapi-host": "live-golf-data.p.rapidapi.com" },
        });
        if (res.ok) {
          const data = JSON.parse(await res.text());
          const names = [];
          (function walk(node) {
            if (!node || typeof node !== "object") return;
            if (Array.isArray(node)) { for (const x of node) walk(x); return; }
            if (typeof node.firstName === "string" && typeof node.lastName === "string") {
              names.push({ firstName: node.firstName, lastName: node.lastName, total: null, today: null, thru: 0, cut: false, fieldOnly: true });
            }
            for (const k of Object.keys(node)) walk(node[k]);
          })(data);
          const seen = new Map();
          for (const n of names) seen.set((n.firstName + " " + n.lastName).toLowerCase(), n);
          const field = [...seen.values()];
          if (field.length >= 60) return { players: field, meta: { variant: "field-list", vendorUpdated: null } };
        }
      } catch (e) {}
      const err = new Error("all SlashGolf endpoint variants failed");
      err.attempts = attempts;
      throw err;
    },
  },
  datagolf: {
    name: "DataGolf",
    async fetch() {
      if (!DG_KEY) throw new Error("DATAGOLF_KEY env var is not set");
      const res = await fetch("https://feeds.datagolf.com/preds/in-play?tour=pga&odds_format=percent&key=" + encodeURIComponent(DG_KEY));
      const text = await res.text();
      if (!res.ok) throw new Error("datagolf http " + res.status + ": " + text.slice(0, 120).replace(DG_KEY, "***"));
      const data = JSON.parse(text);
      const list = Array.isArray(data) ? data : data.data || data.players || [];
      const players = list.map((r) => {
        const nm = dgName(r.player_name || r.name);
        const rounds = [];
        for (const k of ["R1", "R2", "R3", "R4", "r1", "r2", "r3", "r4"]) {
          const v = num(r[k]);
          if (v !== null && v > 50 && v < 110) rounds.push(v);
        }
        const posBlob = String(r.current_pos || r.position || "") + " " + String(r.status || "");
        const thruRaw = r.thru !== undefined ? r.thru : r.holes_completed;
        return {
          firstName: nm.firstName,
          lastName: nm.lastName,
          total: toPar(r.current_score !== undefined ? r.current_score : r.total),
          today: toPar(r.today),
          thru: parseThru(thruRaw),
          cut: /cut|wd|dq/i.test(posBlob),
          rounds: rounds.length ? rounds : undefined,
        };
      }).filter((x) => x.lastName && x.total !== null);
      if (!players.length) throw new Error("datagolf returned no scored players");
      const eventName = (data.info && data.info.event_name) || data.event_name || null;
      return { players, meta: { variant: "dg-in-play", vendorUpdated: (data.info && data.info.last_updated) || null, coursePar: extractPar(data), eventName } };
    },
  },
  espn: {
    name: "ESPN",
    async fetch() {
      const res = await fetch("https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard");
      if (!res.ok) throw new Error("espn http " + res.status);
      const data = await res.json();
      const events = data.events || [];
      const ev = events.find((e) => ((e.competitions || [])[0] || {}).competitors && ((e.competitions || [])[0].competitors || []).length > 0) || events[0];
      const list = (ev && ev.competitions && ev.competitions[0] && ev.competitions[0].competitors) || [];
      const maxRounds = list.reduce((m, c) => Math.max(m, (c.linescores || []).length), 0);
      const players = list.map((c) => {
        const a = c.athlete || {};
        const nameParts = (a.displayName || a.fullName || "").trim().split(/\s+/);
        const rds = (c.linescores || []).map((r) => (r && r.value != null ? Number(r.value) : null)).filter((x) => x != null && x > 50 && x < 110);
        const last = (c.linescores || [])[(c.linescores || []).length - 1] || {};
        const statusBlob = JSON.stringify(c.status || {});
        const cut = /"CUT"|"WD"|"DQ"/i.test(statusBlob) || (maxRounds >= 3 && rds.length <= 2);
        return {
          firstName: nameParts.slice(0, -1).join(" "),
          lastName: nameParts[nameParts.length - 1] || "",
          total: toPar(c.score),
          today: toPar(last.displayValue),
          thru: c.status && typeof c.status.thru === "number" && c.status.thru > 0 ? c.status.thru : rds.length ? 18 : 0,
          cut,
          rounds: rds.length ? rds : undefined,
        };
      }).filter((x) => x.lastName && x.total !== null);
      if (!players.length) throw new Error("espn returned no scored players");
      return { players, meta: { variant: "espn-scoreboard", vendorUpdated: null, coursePar: extractPar(ev || {}) } };
    },
  },
  /* Future paid providers drop in here with the same contract, e.g.:
     datagolf: { name: "DataGolf", async fetch() { ...normalize to the same shape... } }, */
};

/* ---------- stale cache (Supabase) ---------- */
async function sql(query) {
  const r = await fetch("https://api.supabase.com/v1/projects/" + REF + "/database/query", {
    method: "POST",
    headers: { Authorization: "Bearer " + SUPA_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error("cache SQL HTTP " + r.status + ": " + t.slice(0, 120));
  return JSON.parse(t);
}
const ENSURE_TABLE = "CREATE TABLE IF NOT EXISTS public.score_cache (cache_key text PRIMARY KEY, payload jsonb, fetched_at timestamptz DEFAULT now());";

async function writeCache(players, CACHE_KEY, coursePar) {
  if (!SUPA_TOKEN) return;
  const json = JSON.stringify({ players, coursePar: coursePar == null ? null : coursePar }).replace(/'/g, "''");
  const upsert = "INSERT INTO public.score_cache (cache_key, payload, fetched_at) VALUES ('" + CACHE_KEY + "', '" + json + "'::jsonb, now()) " +
    "ON CONFLICT (cache_key) DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now();";
  try { await sql(upsert); }
  catch (e) { try { await sql(ENSURE_TABLE); await sql(upsert); } catch (e2) {} } /* self-heal, never break the feed over caching */
}

async function readCache(CACHE_KEY) {
  if (!SUPA_TOKEN) return null;
  try {
    const rows = await sql("SELECT payload, fetched_at FROM public.score_cache WHERE cache_key = '" + CACHE_KEY + "' LIMIT 1;");
    if (rows.length && rows[0].payload) {
      const pl = rows[0].payload;
      if (Array.isArray(pl) && pl.length) return { players: pl, coursePar: null, fetchedAt: rows[0].fetched_at };
      if (pl.players && pl.players.length) return { players: pl.players, coursePar: pl.coursePar == null ? null : pl.coursePar, fetchedAt: rows[0].fetched_at };
    }
  } catch (e) {}
  return null;
}

/* ---------- handler ---------- */
exports.handler = async (event) => {
  const params = (event && event.queryStringParameters) || {};
  const respond = (body) => ({
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=15",
      "Netlify-CDN-Cache-Control": "public, s-maxage=30, stale-while-revalidate=90",
    },
    body: JSON.stringify(body),
  });

  /* ?view=odds — win odds for the current field (DataGolf), for building
     odds-based tiers on any event. Cached hard: odds move slowly. */
  if (params.view === "odds") {
    try {
      if (!DG_KEY) throw new Error("DATAGOLF_KEY not set");
      const res = await fetch("https://feeds.datagolf.com/betting-tools/outrights?tour=pga&market=win&odds_format=american&key=" + encodeURIComponent(DG_KEY));
      const text = await res.text();
      if (!res.ok) throw new Error("datagolf odds http " + res.status);
      const data = JSON.parse(text);
      const list = data.odds || data.data || (Array.isArray(data) ? data : []);
      const odds = list.map((r) => {
        const nm = dgName(r.player_name || r.name);
        /* prefer a real book line; fall back to the DataGolf model line */
        let line = null;
        const cand = [];
        (function dig(n2) {
          if (!n2 || typeof n2 !== "object") return;
          if (Array.isArray(n2)) { for (const x of n2) dig(x); return; }
          for (const k of Object.keys(n2)) {
            const v = n2[k];
            if ((typeof v === "string" && /^[+-]\d{3,6}$/.test(v)) || (typeof v === "number" && Math.abs(v) >= 100 && Math.abs(v) <= 500000)) cand.push(Number(v));
            else if (v && typeof v === "object") dig(v);
          }
        })(r);
        if (cand.length) line = Math.round(cand.reduce((a, b) => a + b, 0) / cand.length);
        return { firstName: nm.firstName, lastName: nm.lastName, odds: line };
      }).filter((x) => x.lastName && x.odds !== null && x.odds > 0);
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300", "Netlify-CDN-Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
        body: JSON.stringify({ eventName: data.event_name || null, count: odds.length, odds }),
      };
    } catch (e) {
      return { statusCode: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ error: String((e && e.message) || e).replace(DG_KEY, "***").slice(0, 200), odds: [] }) };
    }
  }

  const activeName = await activeProviderName();
  const t = await resolveTournament();
  CURRENT.tourn = t.value;
  CURRENT.name = t.name;
  /* SAFE-SWITCH CHAIN: try the chosen provider first; if it errors, fall
     through the other live providers automatically before ever serving
     stale data. An incident heals itself in one poll cycle. */
  const order = [activeName, "slashgolf", "datagolf", "espn"].filter((v, i, a) => PROVIDERS[v] && a.indexOf(v) === i);
  let provider = PROVIDERS[order[0]];
  const CACHE_KEY = cacheKeyFor(order[0]);
  const chainErrors = [];
  try {
    let result = null;
    for (const name of order) {
      try {
        result = await PROVIDERS[name].fetch();
        provider = PROVIDERS[name];
        break;
      } catch (e) {
        chainErrors.push(name + ": " + String((e && e.message) || e).slice(0, 100));
      }
    }
    if (!result) { const err = new Error("all providers failed"); err.attempts = chainErrors; throw err; }
    const { players, meta } = result;
    if (players.some((pl) => pl.total !== null)) await writeCache(players, CACHE_KEY, meta.coursePar);
    return respond({
      provider: provider.name,
      requested: activeName,
      failoverErrors: chainErrors.length ? chainErrors : undefined,
      source: meta.variant,
      tournId: CURRENT.tourn,
      tournName: CURRENT.name,
      year: YEAR,
      count: players.length,
      coursePar: meta.coursePar == null ? null : meta.coursePar,
      lastUpdated: new Date().toISOString(),
      stale: false,
      players,
    });
  } catch (e) {
    const cached = await readCache(CACHE_KEY);
    if (cached) {
      return respond({
        provider: provider.name,
        source: "cache",
        tournId: CURRENT.tourn,
        tournName: CURRENT.name,
        year: YEAR,
        count: cached.players.length,
        coursePar: cached.coursePar == null ? null : cached.coursePar,
        lastUpdated: cached.fetchedAt,      /* original fetch time — the "as of" moment */
        stale: true,
        providerError: String((e && e.message) || e).slice(0, 200),
        attempts: e.attempts || [],
        players: cached.players,
      });
    }
    return respond({
      provider: provider.name,
      error: String((e && e.message) || e).slice(0, 200),
      attempts: e.attempts || [],
      tournId: CURRENT.tourn,
      tournName: CURRENT.name,
      year: YEAR,
      stale: false,
      players: [],
    });
  }
};
