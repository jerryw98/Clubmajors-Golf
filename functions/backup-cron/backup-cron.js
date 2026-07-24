/* Netlify function: 2-minute snapshots of all business-critical tables.
   Called every 2 minutes by a pg_cron job in Supabase (same pattern as validate-cron).

   Three protection tiers:
   T1 (every run, 2-min RPO): full JSON snapshot into public.backup_snapshots,
      pruned to 24h — instant recovery from accidental deletes / bad app writes.
   T2 (hourly): same JSON written to Supabase Storage bucket "db-backups" at a
      rotating slot hourly/{dow}-{hh}.json (168 slots, self-overwriting weekly)
      — survives a Postgres-level failure. Needs SUPA_SERVICE_KEY; skipped if absent.
   T3 (daily ~13:05 UTC): full JSON emailed to ALERT_EMAIL via Resend as an
      attachment — an off-vendor copy that survives even a Supabase account loss. */

const GUARD = "cm-backup-77133";
const REF = "tocnkbgxbnvznhwpfgpa";
const SUPA_TOKEN = process.env.SUPA_MGMT_TOKEN || "";
const SERVICE_KEY = process.env.SUPA_SERVICE_KEY || "";
const ALERT_EMAIL = process.env.ALERT_EMAIL || "jerryw20180314@gmail.com";
const TABLES = ["clubs", "profiles", "pools", "entries", "payments", "club_invites", "pool_results", "giftcard_log", "platform_config", "signup_requests"];

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

exports.handler = async (event) => {
  const respond = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body, null, 1) });
  const params = (event && event.queryStringParameters) || {};
  if (params.key !== GUARD) return respond(403, { error: "wrong key" });
  if (!SUPA_TOKEN) return respond(500, { error: "SUPA_MGMT_TOKEN not set" });

  try {
    /* ---- collect one consistent-read dump of every table ---- */
    const selects = TABLES.map((t) => "(SELECT COALESCE(json_agg(x), '[]'::json) FROM public." + t + " x) AS " + t).join(", ");
    const rows = await sql("SELECT " + selects + ";");
    const dump = rows && rows[0] ? rows[0] : {};
    const counts = {};
    TABLES.forEach((t) => { counts[t] = Array.isArray(dump[t]) ? dump[t].length : 0; });
    const now = new Date();
    const payloadObj = { taken_at: now.toISOString(), counts, tables: dump };
    const payload = JSON.stringify(payloadObj).replace(/\$cmb\$/g, ""); /* keep dollar-quote safe */
    const result = { counts, bytes: payload.length, t1: false, t2: "skipped", t3: "skipped" };

    /* ---- T1: 2-minute snapshot table, 24h retention ---- */
    await sql("CREATE TABLE IF NOT EXISTS public.backup_snapshots (id bigserial PRIMARY KEY, taken_at timestamptz DEFAULT now(), payload jsonb); ALTER TABLE public.backup_snapshots ENABLE ROW LEVEL SECURITY;");
    await sql("INSERT INTO public.backup_snapshots (payload) VALUES ($cmb$" + payload + "$cmb$::jsonb); DELETE FROM public.backup_snapshots WHERE taken_at < now() - interval '24 hours';");
    result.t1 = true;

    /* ---- T2: hourly rotating slot in Storage (separate from Postgres) ---- */
    const mm = now.getUTCMinutes();
    if (mm < 2 && SERVICE_KEY) {
      const slot = "hourly/" + now.getUTCDay() + "-" + String(now.getUTCHours()).padStart(2, "0") + ".json";
      const up = await fetch("https://" + REF + ".supabase.co/storage/v1/object/db-backups/" + slot, {
        method: "POST",
        headers: { Authorization: "Bearer " + SERVICE_KEY, "Content-Type": "application/json", "x-upsert": "true" },
        body: payload,
      });
      result.t2 = up.ok ? ("stored " + slot) : ("storage HTTP " + up.status + ": " + (await up.text()).slice(0, 120));
    }

    /* ---- T3: daily off-vendor email copy ---- */
    const rk = process.env.RESEND_KEY || "";
    if (now.getUTCHours() === 13 && mm >= 4 && mm < 6 && rk) {
      const day = now.toISOString().slice(0, 10);
      const er = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: "Bearer " + rk, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "ClubMajors Alerts <alerts@clubmajorsgolf.com>",
          to: [ALERT_EMAIL],
          subject: "ClubMajors daily backup " + day + " (" + Object.entries(counts).map(([k, v]) => k + ":" + v).join(" ") + ")",
          text: "Attached: full JSON snapshot of all ClubMajors tables taken " + now.toISOString() + ".\nKeep a few of these — they are your off-vendor disaster copy.",
          attachments: [{ filename: "clubmajors-backup-" + day + ".json", content: Buffer.from(payload).toString("base64") }],
        }),
      });
      result.t3 = er.ok ? "emailed" : ("resend HTTP " + er.status + ": " + (await er.text()).slice(0, 120));
    }

    return respond(200, { ok: true, ...result });
  } catch (e) {
    return respond(500, { error: String((e && e.message) || e).slice(0, 300) });
  }
};
