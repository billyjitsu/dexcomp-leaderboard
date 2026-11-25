# Katana Spot DEX Competition Leaderboard

Volume-only trading competition on Katana's Sushi V3 pools. Next.js 16 on Vercel with Neon Postgres. This replaces the file-based app in `../leaderboard` (kept as a reference). Its scoring rules are unchanged, and `npm run db:verify` checks this app's output against it.

- **Public page:** `/`
- **Admin page:** `/admin`
  - **No login.** Anyone who can reach `/admin` on a deployment can use every admin action.
  - Type your name in the box at the top. It is recorded in the Admin activity log with each action.

## Running rounds ("sprints")

Rounds now live in the database and are managed on `/admin`, so no code changes are needed.

1. **Create a round:** under **Rounds**, give it an id (`round-1`), a name, and start and end times in your local time. Opt-in opens right away.
2. **Edit:** fix a round's name or dates any time before it's finalized.
3. **Delete:** only rounds that haven't started can be deleted. Rounds that have started stay as history in the dropdown.
4. **During the round:** the board refreshes itself (see *How refresh works*). **Refresh now** forces a refresh.
5. **After it ends (under review):**
   - Disqualify or reinstate wallets. A reason is required; type it in the note field first.
   - Add late opt-ins with **Add from start** or **Add from now**.
   - Then click **Finalize round**, which locks the results, and **Download payout CSV**.
   - **Reopen for review** undoes a finalize.

With no rounds at all, the site runs in preview mode: the last 14 days, every wallet ranked.

## How refresh works

The site runs on the Vercel Hobby plan, which allows only a daily cron. So refreshes are triggered by visits instead:
- **When a refresh happens:** a page view rebuilds the board after responding if any of these is true:
  - the live round's snapshot is more than 60 seconds old;
  - an admin changed something;
  - the round changed phase.
- **One refresh at a time:** a lease row in Postgres makes sure only one refresh runs across all serverless instances. Indexer load stays at most one query a minute, no matter how many people are watching.
- **Cron:** the daily cron (`vercel.json`) is a safety net.

Each refresh:
1. Pulls only new swaps from the Envio indexer. Each round keeps a cursor, plus 5 minutes of overlap for late-indexed swaps.
2. Prices them with Binance 1-minute candles (Coinbase as fallback), stored in `prices`.
3. Credits each new transaction once into `tx_credits` and `tx_hops`.
4. Totals every wallet in SQL. Only those few hundred rows leave the database, which keeps Neon data transfer small.
5. Saves the board to `snapshots`. Visitors read that snapshot, cached for 10 seconds at Vercel's CDN.

A long first pull is spread over several refreshes: 60 indexer pages per refresh, which fits the 300-second function limit.

## Data (Neon Postgres)

| Table | What |
| --- | --- |
| `rounds` | Rounds, final flag, `dirty_at` (admin change pending rebuild) |
| `opt_ins` | Per-round opt-ins: signed message and signature, or admin-added with ticket note |
| `disqualifications` | Per-round, with reason and who did it |
| `swaps` | Raw indexer swaps in eligible pools (audit / re-scoring) |
| `tx_credits`, `tx_hops` | Each transaction's credit at exchange prices, and its per-pool hops |
| `prices` | 1-minute exchange prices |
| `sync_cursors` | How far each round has been pulled |
| `snapshots` | Built boards: `board` (admin) and `public` |
| `admin_log` | Every admin action |
| `build_lock` | The refresh lease |

## Local development

```bash
npm install
# .env.local needs DATABASE_URL (pooled), DATABASE_URL_UNPOOLED, CRON_SECRET
npm run db:migrate     # apply db/schema.sql (idempotent)
npm run dev            # http://localhost:3000, admin at /admin
npm test               # scoring and opt-in signature tests
npm run db:verify -- demo-1   # SQL totals vs TypeScript reference vs legacy board
```

Use a Neon branch for experiments (`neon branches create --name dev-x`) and start the app with that branch's `DATABASE_URL`. Check the app actually connected to the branch before writing test data: Next.js also reads `.env.local`, which points at `main`.

## Deploy

```bash
vercel deploy --prod
```

The production env vars `DATABASE_URL` and `CRON_SECRET` are set in the Vercel project. Run `npm run db:migrate` before deploying any schema change.

## Security notes

- **Admin:** no login (by choice). The admin page is `noindex`, but the URL is the only protection.
- **CSRF:** admin writes also require the page's own Origin, a JSON body and an `x-admin-request` header.
- **Opt-in:** a free `personal_sign` signature over a message naming the round, so it can't be replayed for another round. Signatures expire after 10 minutes. There's a per-instance rate limit.
- **Public data:** the top 50 only. Other wallets are looked up one at a time when they connect.
- **Rendering:** the page renders data with `textContent` only. CSP, `nosniff`, `frame-ancestors 'none'` and HSTS are set in `next.config.ts`.

## Still open (from the engineering questions)

- Opt-in design (questions 3 to 7). Smart-contract wallets (EIP-1271) aren't supported yet.
- Payout token and method (question 30).
- A `timestamp` index on the indexer's `Swap` table, which would allow faster refreshes.
- Upgrade to Vercel Pro (or move to the Katana team) for a true 1-minute cron, if visit-triggered refresh isn't enough.
