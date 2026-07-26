/* Netlify function: automated score-feed validation with email alerts.
   Called every 30 minutes by a pg_cron job in Supabase during tournaments.
   Compares SlashGolf (leaderboard fn) vs ESPN vs PGA Tour (pga-validate fn):
   cut-status first, then to-par totals for active players only.
   On new mismatches, emails ALERT_EMAIL via ntfy.sh (free relay; swap for
   Resend later by setting RESEND_KEY). De-duped by mismatch fingerprint
   stored in public.validation_alerts. */

const GUARD = "cm-validate-88412";
const SLASH_KEY = process.env.SLASHGOLF_KEY || "";
const DG_KEY = process.env.DATAGOLF_KEY || "";

function dgName(n) {
  const parts = String(n || "").split(",").map((x) => x.trim());
  if (parts.length >= 2) return { firstName: parts.slice(1).join(" "), lastName: parts[0] };
  const sp = String(n || "").trim().split(/\s+/);
  return { firstName: sp.slice(0, -1).join(" "), lastName: sp[sp.length - 1] || "" };
}
function vToPar(v) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  const t = String(v).trim().toUpperCase();
  if (t === "E") return 0;
  const n = Number(t.replace("+", ""));
  return Number.isNaN(n) ? null : n;
}
const SUPA_TOKEN = process.env.SUPA_MGMT_TOKEN || "";
const REF = "tocnkbgxbnvznhwpfgpa";
const ALERT_EMAIL = process.env.ALERT_EMAIL || "jerryw20180314@gmail.com";
const SITE_URL = "https://clubmajors-live.netlify.app";

function normName(s) {
  return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ø/gi, "o").toLowerCase().replace(/\(a\)/g, "").replace(/[^a-z\s]/g, "").trim();
}
function fmtPar(n) { return n === 0 ? "E" : n > 0 ? "+" + n : String(n); }

async function sql(query) {
  const r = await fetch("https://api.supabase.com/v1/projects/" + REF + "/database/query", {
    method: "POST",
    headers: { Authorization: "Bearer " + SUPA_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error("SQL HTTP " + r.status + ": " + t.slice(0, 150));
  return JSON.parse(t);
}

async function getFeed(name, url, extract) {
  try {
    const headers = name === "SlashGolf" ? { "x-rapidapi-key": SLASH_KEY, "x-rapidapi-host": "live-golf-data.p.rapidapi.com" } : {};
    const r = await fetch(url, { headers });
    if (!r.ok) return null;
    const d = await r.json();
    let players;
    if (extract) players = extract(d);
    else {
      /* SlashGolf direct: tolerant deep-scan for leaderboard rows */
      const rows = [];
      (function walk(n2) {
        if (!n2 || typeof n2 !== "object") return;
        if (Array.isArray(n2)) { for (const x of n2) walk(x); return; }
        if (typeof n2.firstName === "string" && typeof n2.lastName === "string" && n2.total !== undefined) {
          rows.push({ firstName: n2.firstName, lastName: n2.lastName, total: vToPar(n2.total), cut: /cut|wd|dq/i.test(String(n2.status || "") + String(n2.position || "")) });
        }
        for (const k of Object.keys(n2)) walk(n2[k]);
      })(d);
      players = rows.filter((x) => x.total !== null);
    }
    return players && players.length ? { name, players } : null;
  } catch (e) { return null; }
}

/* cut is three-state: true (explicitly cut), false (explicitly active),
   null (feed doesn't say — e.g. ESPN before/around the cut line). Unknowns
   are excluded from cut-status comparison instead of being treated as
   "active", which was producing one false mismatch per cut player. */
function espnExtract(data) {
  const events = data.events || [];
  const ev = events.find((e) => /the open/i.test(e.name || e.shortName || "")) || events[0];
  const list = (ev && ev.competitions && ev.competitions[0] && ev.competitions[0].competitors) || [];
  const toPar = (s) => { if (s == null) return null; const t = String(s).trim().toUpperCase(); if (t === "E") return 0; const n = Number(t.replace("+", "")); return Number.isNaN(n) ? null : n; };
  const maxRounds = list.reduce((m, c) => Math.max(m, (c.linescores || []).length), 0);
  return list.map((c) => {
    const a = c.athlete || {};
    const rounds = c.linescores || [];
    const statusBlob = JSON.stringify(c.status || {});
    let cut = null; /* unknown unless ESPN says otherwise */
    if (/"CUT"|"WD"|"DQ"/i.test(statusBlob)) cut = true;
    else if (maxRounds >= 3) cut = rounds.length <= 2 ? true : false; /* weekend rounds exist: playing = active */
    return {
      firstName: (a.displayName || a.fullName || "").split(/\s+/).slice(0, -1).join(" "),
      lastName: (a.displayName || a.fullName || "").split(/\s+/).pop() || "",
      total: toPar(c.score),
      cut,
    };
  }).filter((x) => x.lastName && x.total !== null);
}

exports.handler = async (event) => {
  const respond = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body, null, 1) });
  const params = (event && event.queryStringParameters) || {};
  if (params.key !== GUARD) return respond(403, { error: "wrong key" });
  if (!SUPA_TOKEN) return respond(500, { error: "SUPA_MGMT_TOKEN not set" });

  try {
    /* independent eyes: the live feed (whatever provider is active),
       SlashGolf DIRECT, DataGolf DIRECT (both checked even when not active),
       the PGA Tour's published leaderboard, and optionally ESPN (benched) */
    const feeds = (await Promise.all([
      getFeed("Live feed", SITE_URL + "/.netlify/functions/leaderboard", (d) => (d.stale ? null : d.players)),
      SLASH_KEY
        ? getFeed("SlashGolf", "https://live-golf-data.p.rapidapi.com/leaderboard?orgId=1&tournId=" + encodeURIComponent(process.env.SLASHGOLF_TOURN_ID || "auto") + "&year=" + new Date().getFullYear(), null)
        : null,
      DG_KEY
        ? getFeed("DataGolf", "https://feeds.datagolf.com/preds/in-play?tour=pga&key=" + encodeURIComponent(DG_KEY), (d) => {
            const list = Array.isArray(d) ? d : d.data || [];
            const out = list.map((r) => {
              const nm = dgName(r.player_name || r.name);
              /* DataGolf doesn't reliably mark cuts (esp. around the Friday cut
                 line) — absence of a cut marker is NOT a claim the player is
                 active. Only a positive marker counts; otherwise "doesn't say". */
              const dgCut = /cut|wd|dq/i.test(String(r.current_pos || "") + String(r.status || "")) ? true : null;
              return { firstName: nm.firstName, lastName: nm.lastName, total: vToPar(r.current_score), cut: dgCut };
            }).filter((x) => x.lastName && x.total !== null);
            return out.length ? out : null;
          })
        : null,
      /* ESPN benched Jul 2026 — frequent score mismatches vs the paid feeds were
         drowning real alerts in noise. The PGA Tour feed below is the free
         cross-check now. Re-enable ESPN with env VALIDATE_ESPN=1. */
      process.env.VALIDATE_ESPN === "1"
        ? getFeed("ESPN", "https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard", espnExtract)
        : null,
      getFeed("PGA Tour", SITE_URL + "/.netlify/functions/pga-validate", (d) => d.players),
    ])).filter(Boolean);

    const feedProblems = [];
    if (!feeds.some((f) => f.name === "SlashGolf")) feedProblems.push("SlashGolf feed returned no players (primary scoring source down?)");
    if (feeds.length < 2) {
      /* pre-tournament this is normal; but if SlashGolf is down while others
         are live, that IS an error worth an email */
      if (feedProblems.length && feeds.length === 1) {
        await alertEmail("ClubMajors: scoring feed problem", feedProblems.join("\n") + "\nOnly " + feeds[0].name + " is responding.", "feed-down:" + feeds.map((f) => f.name).join(","));
      }
      return respond(200, { ok: true, skipped: "only " + feeds.length + " feed(s) live — nothing to cross-check", feedProblems });
    }

    const maps = feeds.map((f) => { const m = new Map(); f.players.forEach((pl) => m.set(normName((pl.firstName || "") + " " + (pl.lastName || "")), pl)); return m; });
    const names = new Set();
    maps.forEach((m) => m.forEach((_, k) => names.add(k)));
    const mismatches = [];
    let compared = 0;
    names.forEach((k) => {
      const present = maps.map((m, i) => ({ feed: feeds[i].name, pl: m.get(k) })).filter((x) => x.pl);
      if (present.length < 2) return;
      compared++;
      const player = ((present[0].pl.firstName || "") + " " + (present[0].pl.lastName || "")).trim();
      /* cut status: only compare feeds that actually STATE one (true/false);
         null = feed doesn't say, so it can neither confirm nor contradict */
      const known = present.filter((x) => x.pl.cut === true || x.pl.cut === false);
      const saysCut = known.filter((x) => x.pl.cut === true);
      const saysActive = known.filter((x) => x.pl.cut === false);
      if (saysCut.length > 0 && saysActive.length > 0) {
        mismatches.push(player + ": " + known.map((x) => x.feed + " " + (x.pl.cut ? "MC" : "active " + fmtPar(x.pl.total || 0))).join(" · ") + " (cut status disagrees)");
        return;
      }
      const isCut = saysCut.length > 0; /* trusted from whichever feed states it */
      if (isCut) return; /* agreed MC — feeds report cut players' numbers differently; nothing to compare */
      const vals = present.map((x) => (x.pl.total == null || Math.abs(x.pl.total) > 30 ? null : x.pl.total));
      /* vendors refresh on different cadences — during live play a 2-stroke gap
         is one un-refreshed eagle on a single hole, i.e. timing lag, not bad
         data (seen live: Koivun -15 vs -13, self-healed). Only 3+ is an incident. */
      const nums = vals.filter((v) => v !== null);
      if (nums.length >= 2 && Math.max.apply(null, nums) - Math.min.apply(null, nums) >= 3) {
        mismatches.push(player + ": " + present.map((x, i) => x.feed + " " + (vals[i] == null ? "n/a" : fmtPar(vals[i]))).join(" · "));
      }
    });

    async function alertEmail(title, body, fp, count) {
      await sql("CREATE TABLE IF NOT EXISTS public.validation_alerts (id bigserial PRIMARY KEY, created_at timestamptz DEFAULT now(), fingerprint text, mismatch_count int, detail text, emailed boolean);");
      const prev = await sql("SELECT fingerprint FROM public.validation_alerts ORDER BY id DESC LIMIT 1;");
      if (prev.length && prev[0].fingerprint === fp) return { sent: false, reason: "duplicate" };
      let sent = false, relay = "";
      const rk = process.env.RESEND_KEY || "";
      if (rk) {
        try {
          const rr = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: "Bearer " + rk, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: "ClubMajors Alerts <alerts@clubmajorsgolf.com>",
              to: [ALERT_EMAIL],
              subject: title,
              text: body,
            }),
          });
          relay = "resend HTTP " + rr.status + (rr.ok ? "" : " " + (await rr.text()).slice(0, 140));
          sent = rr.ok;
        } catch (e) { relay = "resend error: " + String((e && e.message) || e).slice(0, 120); }
      }
      if (!sent) try {
        const n = await fetch("https://ntfy.sh/clubmajors-validate-77031", {
          method: "POST",
          headers: { Title: title.replace(/[^\x20-\x7E]/g, "-"), "X-Email": ALERT_EMAIL, Tags: "warning" },
          body: body.replace(/[^\x20-\x7E\n]/g, "-"),
        });
        relay = "ntfy HTTP " + n.status + (n.ok ? "" : " " + (await n.text()).replace(/[^\x20-\x7E]/g, " ").slice(0, 140));
        sent = n.ok;
      } catch (e) { relay = "ntfy error: " + String((e && e.message) || e).slice(0, 120); }
      await sql("INSERT INTO public.validation_alerts (fingerprint, mismatch_count, detail, emailed) VALUES ('" + fp.replace(/'/g, "''").slice(0, 900) + "', " + (Number(count) || 0) + ", '" + (title + " | " + relay).replace(/'/g, "''").slice(0, 400) + "', " + sent + ");");
      return { sent, relay };
    }

    const fingerprint = mismatches.slice().sort().join("|").slice(0, 900);
    let emailInfo = { sent: false, reason: "no mismatches" };
    if (mismatches.length > 0) {
      const body = "ClubMajors score validation found " + mismatches.length + " mismatch(es) across " + feeds.map((f) => f.name).join(" vs ") + " (" + compared + " players compared):\n\n" + mismatches.slice(0, 20).join("\n") + (mismatches.length > 20 ? "\n…and " + (mismatches.length - 20) + " more" : "") + "\n\nReview: " + SITE_URL + "/owner (Data Health tab)";
      emailInfo = await alertEmail("ClubMajors: " + mismatches.length + " score mismatch(es)", body, fingerprint, mismatches.length);
    }
    return respond(200, { ok: true, feeds: feeds.map((f) => f.name), compared, mismatches: mismatches.length, sample: mismatches.slice(0, 5), email: emailInfo });
  } catch (e) {
    return respond(500, { error: String((e && e.message) || e).slice(0, 300) });
  }
};
