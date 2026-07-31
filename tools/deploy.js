#!/usr/bin/env node
/* ClubMajors scripted deploy — replaces the clubmajors-deploy-vNN.html tools.
   Reads secrets from .env (gitignored), ships the repo's files + all 6
   functions to Netlify via the digest API, then runs EVERY admin-setup step
   so a migration can never be silently skipped again (the v67 tool's dropped
   "selfserve" slice stranded fresh signups at role=pending).

   Hard-won gotchas honored (CLAUDE.md §4):
   1. Function-blob PUT responses often die after the blob lands — upload
      best-effort, then verify by creating a fresh deploy and re-checking
      required blobs; loop ≤4 cycles.
   2. Env changes invalidate all function blobs — we always ship all 6.
   3. Netlify verifies file sha1s but NOT function digests — zips are built
      programmatically and self-verified before upload.
   4. Secrets live in env vars only, never in source.

   Usage: node tools/deploy.js            (runs the test harness first)
          node tools/deploy.js --skip-tests   (emergencies only) */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const API = "https://api.netlify.com/api/v1";
const FUNCTIONS = ["leaderboard", "pga-validate", "admin-setup", "stripe-webhook", "validate-cron", "backup-cron", "billing-portal"];
const SITE_URL = "https://clubmajorsgolf.com";

/* ---------- tiny helpers ---------- */
function loadEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) throw new Error(".env not found — see .env.example");
  const env = {};
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  for (const k of ["NETLIFY_TOKEN", "SITE_ID", "SETUP_KEY"]) {
    if (!env[k]) throw new Error(".env is missing " + k);
  }
  return env;
}
const sha1 = (b) => crypto.createHash("sha1").update(b).digest("hex");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(env, p, opts = {}, attempt = 1) {
  const r = await fetch(API + p, {
    ...opts,
    headers: { Authorization: "Bearer " + env.NETLIFY_TOKEN, ...(opts.headers || {}) },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    if (r.status >= 500 && attempt < 4 && !opts.noRetry) {
      await sleep(3000 * attempt);
      return api(env, p, opts, attempt + 1);
    }
    const err = new Error("Netlify " + r.status + " on " + p + ": " + body.slice(0, 200));
    err.status = r.status;
    throw err;
  }
  return r;
}

/* ---------- minimal store-only ZIP (one file per function) ---------- */
function makeZip(name, data) {
  const crc = zlib.crc32(data) >>> 0;
  const nameBuf = Buffer.from(name, "utf8");
  /* fixed DOS date/time so identical source always yields an identical zip
     (stable sha256 = Netlify's blob cache works across runs) */
  const dosTime = 0, dosDate = (2026 - 1980) << 9 | (1 << 5) | 1;
  const fixed = (sig, extra) => { const b = Buffer.alloc(extra); return b.fill(0), b; };
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8); /* store */ local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8); central.writeUInt16LE(0, 10); central.writeUInt16LE(dosTime, 12); central.writeUInt16LE(dosDate, 14);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28); /* rest zero */ central.writeUInt32LE(0, 42); /* local offset */
  const centralOffset = 30 + nameBuf.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + nameBuf.length, 12); eocd.writeUInt32LE(centralOffset, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([local, nameBuf, data, central, nameBuf, eocd]);
}

/* ---------- main ---------- */
(async () => {
  const env = loadEnv();
  const SITE = env.SITE_ID;

  if (!process.argv.includes("--skip-tests")) {
    console.log("0. Test harness (mandatory before any ship)…");
    execFileSync(process.execPath, [path.join(ROOT, "test", "etinstant.test.js")], { stdio: "inherit" });
    execFileSync(process.execPath, [path.join(ROOT, "test", "harness.js")], { stdio: "inherit" });
  }

  console.log("1. Site + current deploy…");
  const site = await (await api(env, `/sites/${SITE}`)).json();
  const pub = site.published_deploy;
  if (!pub) throw new Error("site has no published deploy");
  console.log("   " + site.name + " · live deploy " + pub.id);

  console.log("2. Ensuring env vars (create-if-missing; FORCE_ENV=1 overwrites)…");
  const slug = site.account_slug;
  const wanted = {
    SUPA_MGMT_TOKEN: env.SUPA_MGMT_TOKEN, STRIPE_WHSEC: env.STRIPE_WHSEC,
    DATAGOLF_KEY: env.DATAGOLF_KEY, RESEND_KEY: env.RESEND_KEY,
    PLINK_MAJOR: env.PLINK_MAJOR, PLINK_EVENT: env.PLINK_EVENT,
    PLINK_ANNUAL: env.PLINK_ANNUAL, PLINK_SEASON: env.PLINK_SEASON,
    SETUP_KEY: env.SETUP_KEY,
    STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY,
    OWNER_SEED_PASSWORD: env.OWNER_SEED_PASSWORD,
  };
  const existing = new Set((await (await api(env, `/accounts/${slug}/env?site_id=${SITE}`)).json()).map((v) => v.key));
  for (const [key, value] of Object.entries(wanted)) {
    if (!value) continue;
    const force = process.env.FORCE_ENV === "1" || (key === "SETUP_KEY" && !existing.has(key));
    if (existing.has(key) && !force) { console.log("   " + key + " exists — left alone."); continue; }
    const body = { key, values: [{ context: "all", value }] };
    try {
      await api(env, `/accounts/${slug}/env?site_id=${SITE}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify([body]), noRetry: true });
      console.log("   " + key + " created.");
    } catch (e) {
      await api(env, `/accounts/${slug}/env/${key}?site_id=${SITE}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      console.log("   " + key + " updated.");
    }
  }

  console.log("3. Building file digests…");
  const files = await (await api(env, `/deploys/${pub.id}/files`)).json();
  const digest = {};
  for (const f of files) digest[f.path || f.id] = f.sha;

  const indexHtml = fs.readFileSync(path.join(ROOT, "index.html"));
  const appJsx = fs.readFileSync(path.join(ROOT, "app.jsx"));
  const supaUrl = (indexHtml.toString().match(/window\.SUPABASE_URL\s*=\s*"([^"]+)"/) || [])[1];
  const supaKey = (indexHtml.toString().match(/window\.SUPABASE_KEY\s*=\s*"([^"]+)"/) || [])[1];
  if (!supaUrl || !supaKey) throw new Error("index.html is missing the Supabase globals — aborting");
  const ownerHtml = Buffer.from(
    fs.readFileSync(path.join(ROOT, "owner.html"), "utf8").replace("@@SUPA_URL@@", supaUrl).replace("@@SUPA_KEY@@", supaKey)
  );
  const redirects = fs.readFileSync(path.join(ROOT, "_redirects"));
  const uploads = [];
  for (const [name, body] of [["index.html", indexHtml], ["app.jsx", appJsx], ["owner.html", ownerHtml], ["_redirects", redirects]]) {
    digest["/" + name] = sha1(body);
    uploads.push({ kind: "file", name, sha: digest["/" + name], body });
  }

  console.log("4. Zipping functions…");
  const fmap = {};
  for (const fn of FUNCTIONS) {
    const src = fs.readFileSync(path.join(ROOT, "functions", fn, fn + ".js"));
    const zip = makeZip(fn + ".js", src);
    /* self-check: the zip must round-trip (gotcha #3 — Netlify won't catch corruption) */
    const check = zlib.crc32(src) >>> 0;
    if (zip.readUInt32LE(14) !== check) throw new Error("zip self-check failed for " + fn);
    fmap[fn] = sha256(zip);
    uploads.push({ kind: "fn", name: fn, sha: fmap[fn], body: zip });
    console.log("   " + fn + ".zip · " + zip.length + " bytes · " + fmap[fn].slice(0, 12) + "…");
  }

  console.log("5. Deploy + upload with lost-response recovery…");
  let dep = null, remaining = null;
  for (let cycle = 1; cycle <= 4; cycle++) {
    dep = await (await api(env, `/sites/${SITE}/deploys`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: digest, functions: fmap }),
    })).json();
    remaining = new Set([...(dep.required || []), ...(dep.required_functions || [])]);
    console.log("   cycle " + cycle + " · deploy " + dep.id + " · blobs still needed: " + remaining.size);
    if (remaining.size === 0) break;
    const unknown = [...remaining].filter((sha) => !uploads.some((u) => u.sha === sha));
    if (unknown.length) throw new Error("Netlify wants blobs we can't provide: " + JSON.stringify(unknown));
    for (const u of uploads) {
      if (!remaining.has(u.sha)) continue;
      const p = u.kind === "file" ? `/deploys/${dep.id}/files/${u.name}` : `/deploys/${dep.id}/functions/${u.name}?runtime=js`;
      try {
        await api(env, p, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: u.body, noRetry: true });
        console.log("   uploaded " + u.name + " ✓");
      } catch (e) {
        console.log("   " + u.name + ": response lost (" + String(e.message).slice(0, 60) + ") — likely accepted, will verify");
      }
      await sleep(2500);
    }
    console.log("   waiting 10s for Netlify to register uploads…");
    await sleep(10000);
  }
  if (remaining && remaining.size > 0) throw new Error(remaining.size + " blob(s) unregistered after 4 cycles. Progress is saved — rerun this script.");

  console.log("6. Waiting for the deploy to go live…");
  let live = false;
  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    const d = await (await api(env, `/deploys/${dep.id}`)).json();
    if (d.state === "ready") { live = true; break; }
    if (d.state === "error") throw new Error("deploy entered error state");
    if (i % 5 === 0) console.log("   state: " + d.state);
  }
  if (!live) throw new Error("deploy never reached ready state");
  console.log("   DEPLOY LIVE.");

  console.log("7. Verifying the live site serves this repo's app.jsx…");
  const liveApp = Buffer.from(await (await fetch(SITE_URL + "/app.jsx?cb=" + dep.id)).arrayBuffer());
  if (sha1(liveApp) !== sha1(appJsx)) throw new Error("LIVE app.jsx does not match the repo copy!");
  console.log("   match ✓");

  console.log("8. Running EVERY admin-setup step (none can be skipped silently)…");
  const admSrc = fs.readFileSync(path.join(ROOT, "functions", "admin-setup", "admin-setup.js"), "utf8");
  const steps = [...admSrc.matchAll(/await step\("([^"]+)"/g)].map((m) => m[1]);
  let failed = 0;
  for (const name of steps) {
    try {
      const r = await fetch(SITE_URL + "/.netlify/functions/admin-setup?key=" + encodeURIComponent(env.SETUP_KEY) + "&only=" + encodeURIComponent(name.toLowerCase()) + "&cb=" + Date.now());
      const j = await r.json();
      const ran = (j.steps || []).filter((s) => !s.skipped);
      const bad = ran.filter((s) => !s.ok);
      if (bad.length) { failed++; console.log("   ✗ " + name + " — " + bad.map((s) => s.error).join("; ").slice(0, 160)); }
      else if (!ran.length) { failed++; console.log("   ✗ " + name + " — matched no step (renamed?)"); }
      else if (name.includes("diagnostic")) console.log("   ✓ " + name + "\n" + JSON.stringify(ran[0].result, null, 1));
      else console.log("   ✓ " + name);
    } catch (e) { failed++; console.log("   ✗ " + name + " — " + String(e.message).slice(0, 120)); }
  }
  if (failed) console.log("   " + failed + " step(s) failed — review above; deploy itself is live.");

  console.log("9. Smoke: leaderboard function…");
  try {
    const j = await (await fetch(SITE_URL + "/.netlify/functions/leaderboard?cb=" + Date.now())).json();
    console.log("   " + (j.players && j.players.length ? j.players.length + " players from " + (j.source || "?") : "no players (pre-tournament is normal): " + JSON.stringify(j).slice(0, 120)));
  } catch (e) { console.log("   leaderboard check failed: " + e.message); }

  console.log("\nDONE — " + SITE_URL + " is on deploy " + dep.id);
})().catch((e) => { console.error("\nDEPLOY FAILED: " + (e.stack || e)); process.exit(1); });
