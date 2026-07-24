/* Netlify function: fetches the PGA Tour's public leaderboard page and
   normalizes the embedded __NEXT_DATA__ into
   { players: [{ firstName, lastName, total, today, thru, cut }] }.
   Used only by the owner dashboard's score validation. */

const PAGE = process.env.PGA_LEADERBOARD_URL || "https://www.pgatour.com/leaderboard";

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

/* Deep-scan the Next.js data blob for anything that looks like a
   leaderboard row, wherever the schema happens to put it. */
function collectRows(node, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const x of node) collectRows(x, out);
    return;
  }
  const p = node.player && typeof node.player === "object" ? node.player : node;
  const totalRaw =
    node.total !== undefined ? node.total :
    node.totalScore !== undefined ? node.totalScore :
    node.scoreToPar !== undefined ? node.scoreToPar :
    node.score;
  if (typeof p.firstName === "string" && typeof p.lastName === "string" && totalRaw !== undefined) {
    const statusBlob = JSON.stringify({
      pos: node.position || node.scoringPosition || null,
      status: node.status || p.status || null,
    });
    out.push({
      firstName: p.firstName,
      lastName: p.lastName,
      total: toPar(totalRaw),
      today: toPar(node.currentRoundScore !== undefined ? node.currentRoundScore : node.today),
      thru: parseThru(node.thru !== undefined ? node.thru : node.currentHole),
      cut: /CUT|WD|DQ/i.test(statusBlob),
    });
  }
  for (const k of Object.keys(node)) {
    if (k !== "player") collectRows(node[k], out);
  }
}

exports.handler = async () => {
  try {
    const res = await fetch(PAGE, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ClubMajors score validator)" },
    });
    if (!res.ok) throw new Error("pgatour.com HTTP " + res.status);
    const html = await res.text();
    const m = html.match(/<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) throw new Error("__NEXT_DATA__ blob not found in page");
    const rows = [];
    collectRows(JSON.parse(m[1]), rows);
    const seen = new Map();
    for (const r of rows) {
      const k = (r.firstName + " " + r.lastName).toLowerCase();
      const prev = seen.get(k);
      if (!prev || (prev.total == null && r.total != null)) seen.set(k, r);
    }
    const players = [...seen.values()].filter((r) => r.total != null || r.cut);
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=30",
        "Netlify-CDN-Cache-Control": "public, s-maxage=60, stale-while-revalidate=120",
      },
      body: JSON.stringify({ source: "pgatour.com", count: players.length, players }),
    };
  } catch (e) {
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: String((e && e.message) || e), players: [] }),
    };
  }
};
