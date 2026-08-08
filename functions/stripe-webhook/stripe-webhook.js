/* Netlify function: Stripe webhook for ClubMajors platform-fee payments.
   Verifies the Stripe signature, records each payment in public.payments,
   and flips the paying club/pool to paid:
     - single-event checkout  -> latest pool for the club gets paid = true
     - annual subscription    -> clubs.plan = 'annual', paid_until = +1 year
     - subscription renewal   -> paid_until extended another year
   DB writes go through the Supabase Management API (server-side). */

const crypto = require("crypto");

const WHSEC = process.env.STRIPE_WHSEC || "";
const SUPA_TOKEN = process.env.SUPA_MGMT_TOKEN || "";
const REF = "tocnkbgxbnvznhwpfgpa";
const ANNUAL_LINK = "plink_1TtKbD2NoOjOuOPysCrqqqD8"; /* $220/yr subscription */

function verify(payload, sigHeader) {
  if (!sigHeader) return false;
  const parts = {};
  sigHeader.split(",").forEach((kv) => {
    const [k, v] = kv.split("=");
    if (k && v) parts[k] = parts[k] ? parts[k] + "," + v : v;
  });
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 600) return false;
  const expected = crypto.createHmac("sha256", WHSEC).update(parts.t + "." + payload, "utf8").digest("hex");
  return parts.v1.split(",").some((v) => {
    try { return crypto.timingSafeEqual(Buffer.from(v), Buffer.from(expected)); }
    catch (e) { return false; }
  });
}

function esc(v) {
  if (v === null || v === undefined || v === "") return "NULL";
  return "'" + String(v).replace(/\\/g, "").replace(/'/g, "''").slice(0, 200) + "'";
}

async function sql(query) {
  const r = await fetch("https://api.supabase.com/v1/projects/" + REF + "/database/query", {
    method: "POST",
    headers: { Authorization: "Bearer " + SUPA_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error("SQL HTTP " + r.status + ": " + t.slice(0, 200));
  return t;
}

exports.handler = async (event) => {
  const respond = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    if (!WHSEC || !SUPA_TOKEN) return respond(500, { error: "STRIPE_WHSEC / SUPA_MGMT_TOKEN env vars not set" });
    const sig = (event.headers && (event.headers["stripe-signature"] || event.headers["Stripe-Signature"])) || "";
    const payload = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body || "";
    if (!verify(payload, sig)) return respond(400, { error: "bad signature" });

    const evt = JSON.parse(payload);
    const obj = (evt.data && evt.data.object) || {};

    if (evt.type === "checkout.session.completed") {
      const clubId = obj.client_reference_id || null;
      /* plan detection — 2026 pricing: majors $75, other events $30,
         annual $330/yr (subscription), 2026 Season Pass flat $30.
         $30 single vs $30 season is ambiguous by amount alone, so
         payment-link ids (env PLINK_*) decide first; amounts are fallback. */
      const amt = Number(obj.amount_total) || 0;
      const link = String(obj.payment_link || "");
      const PLINKS = {
        major: process.env.PLINK_MAJOR || "",
        event: process.env.PLINK_EVENT || "",
        season: process.env.PLINK_SEASON || "",
        annual: process.env.PLINK_ANNUAL || "",
      };
      const plan =
        obj.mode === "subscription" || obj.subscription || link === ANNUAL_LINK || (PLINKS.annual && link === PLINKS.annual) ? "annual"
        : PLINKS.season && link === PLINKS.season ? "season2026"
        : PLINKS.major && (link === PLINKS.major || link === PLINKS.event) ? "single"
        : amt === 7500 ? "single"
        : amt === 5000 ? "single" /* legacy $50 link */
        : amt === 3000 ? "single" /* $30 event; set PLINK_SEASON to catch season buys */
        : amt > 0 && amt <= 2500 ? "season2026" /* legacy promo amounts */
        : "season2026";
      const promo = (obj.discounts && obj.discounts[0] && (obj.discounts[0].promotion_code || obj.discounts[0].coupon)) || null;
      const email = (obj.customer_details && obj.customer_details.email) || obj.customer_email || null;
      await sql(
        "INSERT INTO public.payments (club_id, plan, amount_cents, currency, promo_code, customer_email, stripe_customer, stripe_session_id) VALUES (" +
          [clubId ? esc(clubId) + "::uuid" : "NULL", esc(plan), Number(obj.amount_total) || 0, esc(obj.currency || "usd"), esc(promo), esc(email), esc(obj.customer || null), esc(obj.id)].join(", ") +
          ") ON CONFLICT (stripe_session_id) DO NOTHING;"
      );
      /* pools publish on payment, never before: flip the club's newest pool
         to paid AND published here (service side, bypasses the RLS paywall).
         The pro's checkout page polls for this flip; even if they close the
         browser right after paying, the pool still goes live. */
      const publishLatestPool =
        "UPDATE public.pools SET paid = true, published = true WHERE id = (SELECT id FROM public.pools WHERE club_id = " + esc(clubId) + "::uuid ORDER BY created_at DESC LIMIT 1);";
      if (clubId && plan === "annual") {
        await sql("UPDATE public.clubs SET plan = 'annual', paid_until = now() + interval '1 year' WHERE id = " + esc(clubId) + "::uuid;");
        await sql(publishLatestPool);
      } else if (clubId && plan === "season2026") {
        await sql("UPDATE public.clubs SET plan = 'season2026', paid_until = '2026-12-31T23:59:59+00:00' WHERE id = " + esc(clubId) + "::uuid;");
        await sql(publishLatestPool);
      } else if (clubId) {
        await sql(publishLatestPool);
      }
      return respond(200, { ok: true, recorded: plan });
    }

    if (evt.type === "invoice.paid") {
      const cust = obj.customer || null;
      const email = obj.customer_email || null;
      await sql(
        "INSERT INTO public.payments (club_id, plan, amount_cents, currency, customer_email, stripe_customer, stripe_session_id) VALUES (" +
          ["(SELECT club_id FROM public.payments WHERE stripe_customer = " + esc(cust) + " AND club_id IS NOT NULL ORDER BY created_at LIMIT 1)",
           "'annual-renewal'", Number(obj.amount_paid) || 0, esc(obj.currency || "usd"), esc(email), esc(cust), esc(obj.id)].join(", ") +
          ") ON CONFLICT (stripe_session_id) DO NOTHING;"
      );
      if (obj.billing_reason === "subscription_cycle") {
        await sql(
          "UPDATE public.clubs SET paid_until = GREATEST(coalesce(paid_until, now()), now()) + interval '1 year' WHERE id = (SELECT club_id FROM public.payments WHERE stripe_customer = " + esc(cust) + " AND club_id IS NOT NULL ORDER BY created_at LIMIT 1);"
        );
      }
      return respond(200, { ok: true, recorded: "invoice" });
    }

    return respond(200, { ok: true, ignored: evt.type });
  } catch (e) {
    return respond(500, { error: String((e && e.message) || e).slice(0, 300) });
  }
};
