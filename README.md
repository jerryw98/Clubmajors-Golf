# ClubMajors

White-label golf tournament pool software for private clubs. Live at
[clubmajorsgolf.com](https://clubmajorsgolf.com) · [demo](https://clubmajorsgolf.com/demo).

Clubs publish a pool for a PGA Tour event; members pick 6 golfers from an odds-tiered
picksheet; live scoring, cut math, standings and tiebreakers run automatically. Entry fees
never touch the platform — clubs pay flat software fees.

## Layout

| Path | What |
|---|---|
| `app.jsx` | The entire frontend (React 18 + Babel-standalone, compiled in the browser — no build step) |
| `index.html` | Shell: CDN scripts + public client config (Supabase publishable key, Stripe payment links) |
| `owner.html` | Owner dashboard (vanilla JS + Chart.js + SheetJS); `@@SUPA_URL@@`/`@@SUPA_KEY@@` substituted at deploy |
| `_redirects` | Netlify redirects (`/owner`, `/demo`) |
| `functions/` | Netlify functions (plain CommonJS, no node_modules): leaderboard, pga-validate, admin-setup, stripe-webhook, validate-cron, backup-cron |
| `test/` | Pre-deploy harness (SSR smoke render) + timezone unit tests |
| `sql/` | One-off Supabase scripts |
| `CLAUDE.md` | Full engineering handoff: architecture, DB schema, deploy gotchas, open items |

## Testing (mandatory before shipping app.jsx)

```
npm install
npm test
```

`test/harness.js` must print `HARNESS PASS`.

## Deploy

See `CLAUDE.md` §4 — Netlify digest-API deploy with several hard-won gotchas
(function blob re-upload loops, env-var invalidation, no blob digest verification).
Secrets live only in Netlify env vars, never in this repo.
