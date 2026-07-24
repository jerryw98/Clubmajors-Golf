# ClubMajors — Claude Code Handoff

**Date:** Jul 24, 2026 (rev 2 — post v67) · **Owner:** Jerry Wang (jerryw20180314@gmail.com)
**Live site:** https://clubmajorsgolf.com (Netlify site id `0dee8e6b-9c57-4fc4-8761-83fc2261ee63`, formerly clubmajors-live.netlify.app)
**Demo:** https://clubmajorsgolf.com/demo · **Owner dashboard:** https://clubmajorsgolf.com/owner

---

## 0. Repo addendum (added when this repo was created, Jul 24 2026)

This is now a real git repo: **https://github.com/jerryw98/Clubmajors-Golf** (PUBLIC —
never commit secrets). §4's "first job: git init" is done. Notes on what's here vs. deployed:

- Sources were extracted from `clubmajors-deploy-v67.html` (the then-current deploy tool);
  `app.jsx` verified byte-identical to the v67 payload. `index.html` fetched from the live
  site (its Supabase publishable key + Stripe TEST payment links are public client config).
- `owner.html` is the template with `@@SUPA_URL@@`/`@@SUPA_KEY@@` placeholders — the deploy
  step substitutes them from index.html.
- **One intentional divergence from production:** `functions/admin-setup/admin-setup.js` had
  its guard key hardcoded; the repo version reads `process.env.SETUP_KEY` instead (and
  rejects if unset). The deployed blob still uses the old literal key. Next deploy: set
  `SETUP_KEY` as a Netlify env var (remember gotcha #2 — env change forces re-upload of all
  function blobs; the deploy flow ships all 6 anyway).
- The HTML deploy tools are gitignored (they embed live secrets). They live in the old
  Cowork outputs folder on Jerry's Mac.
- `test/harness.js` and `test/etinstant.test.js` were recreated from the §5 description
  (the /tmp originals were lost). `harness-demo2.js` (demo fetchApp unit tests: pick
  resolution, MC scoring) has NOT been recreated yet — rebuild it when touching demo logic.
- Run tests: `npm install && npm test` (needs Node.js).

---

## 1. What this product is

White-label golf tournament pool software sold to private clubs. The head golf pro signs up,
brands a page for their club, publishes a pool for a PGA Tour event; members open one link,
pick 6 golfers from an odds-tiered picksheet, and live scoring/cut math/standings/tiebreakers
run automatically. Clubs pay flat software fees (entry fees never touch the platform):
**$75/major · $30/other events · $330/year · $30 "2026 Season Pass" promo.**
Revenue driver = annual subscriptions. Launch push is aimed at the FedEx playoffs (Aug 13)
and the Presidents Cup (Sep 24–27, Medinah) — the only match-play Cup pools on the market.

## 2. Architecture (intentionally minimal)

- **Frontend:** one file, `app.jsx` (~230KB). No build step — React 18 + Babel-standalone
  compiled in the browser. Served from Netlify CDN next to `index.html`, `owner.html`
  (vanilla JS + Chart.js + SheetJS owner dashboard), `_redirects`.
- **Backend:** Supabase (project ref `tocnkbgxbnvznhwpfgpa`) — Postgres + Auth + Storage.
  All client access via anon key constrained by RLS; writes go through SECURITY DEFINER RPCs.
- **Serverless:** Netlify functions (plain CommonJS, zipped, no node_modules):
  - `leaderboard` — live scores; provider registry DataGolf → SlashGolf → ESPN with
    auto-failover + stale cache (`score_cache` table, "SCORES AS OF" banner).
  - `pga-validate` — secondary feed for cross-checks.
  - `validate-cron` — 5-feed watchdog, every 2h via pg_cron; ≥2-stroke spread threshold;
    alerts via Resend from alerts@clubmajorsgolf.com (ntfy fallback); dedup by fingerprint
    in `validation_alerts`.
  - `stripe-webhook` — signature-verified; plan detection by payment-link id
    (env `PLINK_MAJOR/EVENT/ANNUAL/SEASON`), amount fallback.
  - `admin-setup` — idempotent DB migration/config runner (now incl. `selfserve` slice:
    `self_serve_signup` RPC — new signups auto-get club + pro role, no owner approval;
    invite-link signups still join the existing club instead). **Run with `?only=<substring>`**
    (slices: verify, brand, clubmajorsgolf, tiebreaker, deadline, payments, validation,
    referral, slugs, invites, dashboard, sender, cache, archive, config, definitions, backup)
    or it exceeds the 10s function limit. Guarded by key in query string.
  - `backup-cron` — NEW (ships with v66): every 2 min via pg_cron; full JSON snapshot of all
    tables → `backup_snapshots` (24h retention) + hourly rotating slot to Storage bucket
    `db-backups` (needs `SUPA_SERVICE_KEY`) + daily email copy to owner via Resend.
- **Scheduling:** pg_cron + pg_net in Supabase call function URLs
  (`clubmajors-validate` every 2h, `clubmajors-backup` every 2 min after v66 runs).

## 3. DB schema (public)

`clubs` (name, slug, theme jsonb {themeId, logoBg, noLogo, tagline, pros[]}, paid_until),
`profiles` (id=auth uid, role: pro|member|pending|owner, club_id),
`pools` (club_id, event_name, entry_fee, deadline timestamptz, published, payouts, rules,
tiebreaker_on, paid), `entries` (pool_id, entry_name, member_name, picks jsonb — 6 picks,
optional "tb:N", team "team:usa|intl", "tbs:17-13"; up to 8 elements), `pool_results`
(archived standings), `payments`, `club_invites` (RLS admin-read; token NOT on public rows),
`giftcard_log`, `signup_requests`, `validation_alerts`, `platform_config` (score_provider,
referral_promo — public-read policy for that key only), `score_cache`, `backup_snapshots`.

RPCs: `submit_entry`/`update_entry` (validated, SECURITY DEFINER), `join_club_by_invite`,
`list_club_admins`, `owner_gate()` (email allowlist jerryw20180314@gmail.com +
0wangxinquan0@gmail.com OR owner role), `owner_dashboard()`, `owner_mark_giftcard`/`unmark`.

## 4. Deploy mechanics — READ BEFORE TOUCHING

Current mechanism (no git yet — **first job: `git init`, commit everything, kill the
version-suffix workflow**): self-contained HTML deploy tools (`clubmajors-deploy-v67.html`
is CURRENT; v52–v66 are obsolete, delete them). Jerry opens the file in his browser and
clicks once. The tool embeds base64 of app.jsx + function zips + env secrets, and drives
the Netlify API (digest deploy) from the page.

Hard-won gotchas (each cost us a real incident):
1. **Netlify function uploads:** PUT responses often die but blobs land. The tool creates a
   deploy, checks `required_functions`, re-uploads, and loops (≤4 cycles). Keep that pattern.
2. **Env-var changes invalidate ALL function blobs** → every function must re-upload after
   any env change. The tool ships all 6 functions for this reason.
3. Netlify does NOT verify function blob digests (silent corruption possible) but DOES
   verify file sha1s. Never hand-transcribe base64; generate + verify programmatically
   (compare sha before/after). One corrupted hand-typed blob 500'd production admin-setup.
4. **Netlify secrets scanning:** never embed secrets in function source — env vars only.
5. `index.html` carries `window.SUPABASE_URL/KEY` and `window.STRIPE_LINK_MAJOR/EVENT/
   ANNUAL/SEASON`; owner.html placeholders `@@SUPA_URL@@/@@SUPA_KEY@@` are substituted by
   the deploy tool from index.html.

## 5. Testing (mandatory before any app.jsx ship)

- `/tmp/harness.js` (recreate in repo as `test/harness.js`): Babel classic-runtime compile +
  React 18 SSR render of the whole app with stubbed `sb`/window/localStorage.
  It has caught multiple real TDZ crashes pre-deploy. Run after every edit.
- `/tmp/harness-demo2.js`: demo-mode fetchApp unit tests (pick resolution, MC scoring).
- Targeted node tests for pure logic (e.g. `etInstant` timezone helper — 7 assertions incl.
  DST boundaries). Pattern: extract function source by regex, `eval`, assert.

## 6. app.jsx landmarks

- `EVENT` block (~line 962): legacy hardcoded tournament (The Open). Mostly superseded;
  `deadlineISO` still feeds `defaultDeadline()` passthrough for that one event.
- `etInstant(dateStr,h,m)` / `defaultDeadline(ev)`: deadlines = 7:00 AM **ET** on round-1
  day as true UTC instant (DST-safe). Never use local wall-clock strings for defaults —
  that was the "1:35 AM Thursday" bug (pools inherited The Open's tee time; displays hid
  the date). All displays show full date + viewer-local TZ.
- `EVENTS_ALL` schedule → `EVENTS` (auto-hides ended events, roll-forward effect).
- DEMO mode: `?demo=masters` (+ `/demo` 302). `MOCK_ENTRIES` only when DEMO; real site
  starts empty (fresh-signup fix). Default club name "Your Golf Club"; `noLogo` theme flag.
- Presidents Cup: `TEAM_TIERS` 6 slots (USA-1..INTL-3), `pcId()`, Cup call, `tbs:` final
  score tiebreaker, `teamMode` branches. **Live match-point scoring engine NOT built yet**
  — biggest open engineering item, needed before Sep 24.
- Pricing consts: `PLATFORM_PRICING`, `ANNUAL_PRICE=330`, `SEASON_PRICE=30`,
  `stripeCheckoutUrl(plan, club, email, eventType)`.

## 7. Secrets (rotate these soon — they've circulated during dev)

Values are embedded in `clubmajors-deploy-v66.html` (SECRETS array) — read them from there.
- Netlify PAT: `nfp_…` · Supabase mgmt token: `sbp_…` · Resend key: `re_…` (sending-only)
- `STRIPE_WHSEC`, `DATAGOLF_KEY`, `SLASHGOLF_KEY`, 4× `PLINK_*` payment-link ids
- `SUPA_SERVICE_KEY` is fetched at deploy time in-browser (never stored in the file)
- Stripe is TEST MODE. Live-mode swap is P0 on the launch checklist.

## 8. Open engineering items (from the launch checklist)

1. **Presidents Cup live scoring engine** — match results → points → pool standings; build
   early Sept, test vs practice-round feeds; deadline Sep 24.
2. Jerry must run `clubmajors-deploy-v67.html` once (adds self-serve signup on top of
   pricing links, branded sender, alerts, deadline fix, signup UX, backup system).
   Then LIVE-verify: fresh signup → auto club; invite link; referral link → /owner.
3. Pre-launch: `wipe-test-data.sql` (in outputs; keeps only the 2 owner accounts),
   Stripe LIVE mode, remove/tighten admin-setup, rotate tokens, full QA pass
   (checklist P1 section has the complete test plan).
4. Nice-to-haves: member confirmation emails w/ edit codes, most-picked golfers view.

## 9. Division of labor

Claude Code owns: app.jsx, functions, deploy pipeline (migrate to git + CI eventually),
Presidents Cup engine, tests. **Cowork keeps:** anything browser/GUI — Google Sheets
launch checklist (auto-maintained), Slides deck, Cloudflare DNS, Stripe dashboard,
Supabase console, Instantly/cold-email ops, Resend, Google Workspace.

Business docs live in Jerry's Google account:
- Launch checklist (priority-sorted, ⚡ Sort menu installed):
  https://docs.google.com/spreadsheets/d/1PmSUJ_WIy7T_GaH0tme7MM6tx8uGINepyz_He_o2dtI/edit
- Business-plan deck: Drive → "clubmajors-business-plan"

## 10. Suggested first session in Claude Code

```bash
mkdir clubmajors && cd clubmajors && git init
# copy in: app.jsx, owner.html, index.html (fetch live: curl -s https://clubmajorsgolf.com/index.html)
# functions/: admin-setup.js, validate-cron.js, stripe-webhook.js, backup-cron.js, leaderboard, pga-validate
# test/: harness.js, harness-demo2.js, tz tests
git add -A && git commit -m "baseline: state as of v66 (Jul 24 2026)"
node test/harness.js   # must print HARNESS PASS
```
Then retire the HTML deploy tools in favor of a scripted deploy (same Netlify digest API,
same gotchas in §4) — or Netlify CLI once secrets are in env.


## 11. Cold-email status (Jul 24)
Instantly DFY order placed: domain **getclubmajors.com** ($15/yr) + 2 Google inboxes
($5/mo each): hailey@ (Hailey Carter), brooke@ (Brooke Bennett). Web-forwards to
clubmajorsgolf.com. Warmup auto-started Jul 24 on both. Campaign plan: 14-day warmup
→ first cold sends ~Aug 7; start ~10-15/day/inbox, ramp to ~25-30/day/inbox; keep
warmup running permanently. Replies land in Instantly Unibox. club-majors.com is
spare (redirect it to the main site in Cloudflare; owner has the rule).
