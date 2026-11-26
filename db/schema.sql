-- Katana Spot DEX competition leaderboard. Idempotent: safe to run on every deploy
-- (npm run db:migrate). Times are unix seconds (bigint) to match the indexer.

-- Competition rounds ("sprints"). Created and managed from /admin.
create table if not exists rounds (
  id            text primary key check (id ~ '^[a-z0-9-]{1,40}$' and id <> 'preview'),
  name          text not null check (length(name) between 1 and 80),
  start_ts      bigint not null,
  end_ts        bigint not null,
  final         boolean not null default false,
  finalized_at  bigint,
  -- Set by admin actions; a refresh rebuilds the snapshot when dirty_at > its generated_at.
  dirty_at      bigint not null default 0,
  created_at    timestamptz not null default now(),
  check (start_ts < end_ts)
);

-- Off = every wallet's trades count (no opt-in needed), like preview mode. Can be switched
-- on later; opt-ins then decide what counts.
alter table rounds add column if not exists opt_in_required boolean not null default true;

-- Per-round opt-ins: signed (personal_sign) or added by an admin for support tickets.
create table if not exists opt_ins (
  round_id   text not null references rounds(id) on delete cascade,
  wallet     text not null check (wallet ~ '^0x[0-9a-f]{40}$'),
  from_ts    bigint not null,           -- trades at or after this count
  at         bigint not null,           -- when it was recorded
  source     text not null check (source in ('signature', 'admin')),
  message    text,
  signature  text,
  note       text,
  primary key (round_id, wallet)
);

create table if not exists disqualifications (
  round_id  text not null references rounds(id) on delete cascade,
  wallet    text not null check (wallet ~ '^0x[0-9a-f]{40}$'),
  reason    text not null,
  at        bigint not null,
  actor     text,
  primary key (round_id, wallet)
);

-- Raw swaps from the Envio indexer, eligible pools only. Kept for audit and re-scoring.
create table if not exists swaps (
  id          text primary key,
  ts          bigint not null,
  origin      text not null,
  sender      text not null,
  pool_id     text not null,
  tx_hash     text not null,
  amount0     double precision not null,
  amount1     double precision not null,
  amount_usd  double precision not null
);
create index if not exists swaps_ts on swaps (ts);
create index if not exists swaps_tx on swaps (tx_hash);

-- One row per transaction: its credit at exchange prices (see src/lib/score.ts creditTx).
-- Computed once when its swaps arrive, so leaderboard refreshes only aggregate in SQL.
create table if not exists tx_credits (
  tx_hash      text primary key,
  wallet       text not null,
  ts           bigint not null,
  credit_usd   double precision not null,
  gross_usd    double precision not null,
  fees_usd     double precision not null,
  indexer_usd  double precision not null,
  off_market   boolean not null,
  paid         jsonb not null,   -- [[symbol, amount], ...]
  received     jsonb not null
);
create index if not exists tx_credits_ts on tx_credits (ts);
create index if not exists tx_credits_wallet_ts on tx_credits (wallet, ts);

-- Who really traded, for swaps that may have been sent by a relayer (src/lib/relay.ts).
-- One row per checked transaction; tx_credits.wallet is set to `trader` when resolved.
create table if not exists tx_traders (
  tx_hash     text primary key,
  origin      text not null,           -- who sent the transaction (the relayer when relayed)
  status      text not null check (status in ('direct', 'resolved', 'unresolved')),
  trader      text,                    -- set when status = resolved
  method      text,                    -- funder: paid for the swap. recipient: received its output
  checked_at  bigint not null
);
create index if not exists tx_traders_relayed on tx_traders (origin) where status <> 'direct';

-- Each competition-pool hop of a transaction, with its share of the transaction's credit.
create table if not exists tx_hops (
  tx_hash    text not null references tx_credits(tx_hash) on delete cascade,
  hop        int not null,
  pool_id    text not null,
  usd        double precision not null,
  share_usd  double precision not null,  -- credit * usd / sum(usd of the tx's hops)
  buy        boolean not null,           -- trader received the pool's base token
  primary key (tx_hash, hop)
);

-- One-minute exchange prices (Binance, Coinbase fallback), never Katana pool prices.
create table if not exists prices (
  asset     text not null,
  minute    bigint not null,
  price     double precision not null,
  primary key (asset, minute)
);

create table if not exists pool_tokens (
  pool_id  text primary key,
  token0   text not null,
  token1   text not null
);

-- How far each round's swaps have been pulled from the indexer.
create table if not exists sync_cursors (
  round_id    text primary key,  -- a round id, or 'preview'
  start_ts    bigint not null,
  through_ts  bigint not null,   -- swaps with ts < through_ts are stored and credited
  pools       text not null      -- eligible pool set; a change re-pulls the round
);

-- Built leaderboards. board = full admin view, public = what the public page gets.
create table if not exists snapshots (
  round_id      text primary key,
  generated_at  bigint not null,
  status        text not null,
  board         jsonb not null,
  public        jsonb not null
);

-- Only one refresh runs at a time (serverless instances share this lease).
create table if not exists build_lock (
  id      int primary key check (id = 1),
  holder  text,
  until   timestamptz not null default 'epoch'
);
insert into build_lock (id) values (1) on conflict do nothing;

-- Every admin action, who did it and why.
create table if not exists admin_log (
  id        bigserial primary key,
  at        timestamptz not null default now(),
  actor     text not null,
  action    text not null,
  round_id  text,
  wallet    text,
  detail    text
);
