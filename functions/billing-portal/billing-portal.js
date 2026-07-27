/* Netlify function: mint a Stripe customer-portal session for the signed-in
   club admin. FTC click-to-cancel: cancellation must be as self-serve as
   signup was. The portal lets the club cancel the renewal; access runs to the
   end of the paid term (configure that in Stripe dashboard → Billing portal).

   Flow: client sends its Supabase access token → we resolve the user, find
   the club's most recent Stripe customer id from payments, and return a
   portal session URL. Requires env STRIPE_SECRET_KEY (test or live). */
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || "";
const SUPA_TOKEN = process.env.SUPA_MGMT_TOKEN || "";
const REF = "tocnkbgxbnvznhwpfgpa";
const SUPA_URL = "https://" + REF + ".supabase.co";
/* publishable anon key — public client config, same value index.html ships */
const SUPA_ANON = "sb_publishable_jJOv_wdZX1ffI2tB-xgMSw_Rj0ptzyq";
const SITE_URL = "https://clubmajorsgolf.com";

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
  const respond = (code, body) => ({
    statusCode: code,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization" },
    body: JSON.stringify(body),
  });
  if (event.httpMethod === "OPTIONS") return respond(200, { ok: true });
  if (!STRIPE_KEY) return respond(500, { error: "Billing portal isn't configured yet (STRIPE_SECRET_KEY missing)." });
  if (!SUPA_TOKEN) return respond(500, { error: "SUPA_MGMT_TOKEN not set" });

  const auth = (event.headers && (event.headers.authorization || event.headers.Authorization)) || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return respond(401, { error: "Sign in to manage billing." });

  try {
    const ur = await fetch(SUPA_URL + "/auth/v1/user", { headers: { Authorization: "Bearer " + token, apikey: SUPA_ANON } });
    if (!ur.ok) return respond(401, { error: "Session expired — sign in again." });
    const user = await ur.json();
    const uid = String(user.id || "").replace(/[^0-9a-f-]/gi, "");
    if (!uid) return respond(401, { error: "Session expired — sign in again." });

    const rows = await sql(
      "SELECT p.club_id, pay.stripe_customer FROM public.profiles p " +
      "LEFT JOIN LATERAL (SELECT stripe_customer FROM public.payments WHERE club_id = p.club_id AND stripe_customer IS NOT NULL ORDER BY created_at DESC LIMIT 1) pay ON true " +
      "WHERE p.id = '" + uid + "'::uuid AND p.role IN ('pro','owner');"
    );
    const row = rows && rows[0];
    if (!row || !row.club_id) return respond(403, { error: "This account doesn't manage a club." });
    if (!row.stripe_customer) return respond(404, { error: "No Stripe subscription found for this club — nothing to manage yet." });

    const pr = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
      method: "POST",
      headers: { Authorization: "Bearer " + STRIPE_KEY, "Content-Type": "application/x-www-form-urlencoded" },
      body: "customer=" + encodeURIComponent(row.stripe_customer) + "&return_url=" + encodeURIComponent(SITE_URL + "/"),
    });
    const pj = await pr.json();
    if (!pr.ok) return respond(502, { error: (pj.error && pj.error.message) || "Stripe rejected the portal request." });
    return respond(200, { url: pj.url });
  } catch (e) {
    return respond(500, { error: String((e && e.message) || e).slice(0, 200) });
  }
};
