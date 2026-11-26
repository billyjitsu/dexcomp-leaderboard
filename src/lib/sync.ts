// Pulls swaps from the Envio indexer into Postgres and credits each transaction once.
//
// Each round (and preview) keeps a cursor: every swap with start <= ts < through_ts is
// stored and credited. A refresh only fetches from the cursor (minus a small overlap for
// late-indexed swaps) to now, so steady-state cost is one indexer query per refresh.

import { INDEXER_LAG_SEC, MAX_PAGES_PER_REFRESH, POOLS, RESUME_OVERLAP_SEC } from "./config.ts";
import { chunks, num, sql } from "./db.ts";
import { fetchPoolTokens, fetchSwapsUpTo } from "./indexer.ts";
import { PriceBook, type PriceStore } from "./prices.ts";
import { creditTx, groupByTx, hopShares } from "./score.ts";
import type { PoolTokens, Swap } from "./types.ts";

export const dbPriceStore: PriceStore = {
  async load(key, fromTs, toTs) {
    const rows = await sql()`select minute, price from prices where asset = ${key} and minute >= ${fromTs} and minute <= ${toTs}`;
    return rows.map((r) => [num(r.minute), num(r.price)] as [number, number]);
  },
  async save(key, rows) {
    for (const part of chunks(rows, 5000)) {
      await sql().query(
        `insert into prices (asset, minute, price) select $1, * from unnest($2::bigint[], $3::float8[])
         on conflict (asset, minute) do update set price = excluded.price`,
        [key, part.map((r) => r[0]), part.map((r) => r[1])],
      );
    }
  },
};

// Which token is which side of each pool never changes, so it's fetched once and stored.
export async function poolTokens(): Promise<Map<string, PoolTokens>> {
  const ids = Object.keys(POOLS);
  const rows = await sql()`select pool_id, token0, token1 from pool_tokens`;
  const map = new Map(rows.map((r) => [String(r.pool_id), { token0: String(r.token0), token1: String(r.token1) }]));
  if (ids.every((id) => map.has(id))) return map;
  const fetched = await fetchPoolTokens(ids);
  const missing = ids.filter((id) => !fetched.has(id));
  if (missing.length) throw new Error(`indexer has no pool data for ${missing.join(", ")}`);
  for (const [id, p] of fetched) {
    await sql()`insert into pool_tokens (pool_id, token0, token1) values (${id}, ${p.token0}, ${p.token1})
                on conflict (pool_id) do update set token0 = excluded.token0, token1 = excluded.token1`;
    map.set(id, p);
  }
  return map;
}

// Stores swaps and the credit of every transaction they make up. Every swap of each
// transaction must be in `swaps` (all of a transaction's swaps share one timestamp, and
// pulls are complete per second). Idempotent: re-storing the same swaps changes nothing.
export async function storeSwapsAndCredits(swaps: Swap[]): Promise<{ priceSources: string[] }> {
  if (swaps.length === 0) return { priceSources: [] };
  const sorted = [...swaps].sort((a, b) => a.timestamp - b.timestamp || (a.id < b.id ? -1 : 1));
  const [pools, prices] = await Promise.all([
    poolTokens(),
    PriceBook.load(sorted[0]!.timestamp, sorted.at(-1)!.timestamp + 60, dbPriceStore),
  ]);
  const credits = groupByTx(sorted).map((group) => creditTx(group, pools, prices));

  for (const part of chunks(sorted, 2000)) {
    await sql().query(
      `insert into swaps (id, ts, origin, sender, pool_id, tx_hash, amount0, amount1, amount_usd)
       select * from unnest($1::text[], $2::bigint[], $3::text[], $4::text[], $5::text[], $6::text[], $7::float8[], $8::float8[], $9::float8[])
       on conflict (id) do nothing`,
      [
        part.map((s) => s.id), part.map((s) => s.timestamp), part.map((s) => s.origin), part.map((s) => s.sender),
        part.map((s) => s.poolId), part.map((s) => s.txHash), part.map((s) => s.amount0), part.map((s) => s.amount1), part.map((s) => s.amountUSD),
      ],
    );
  }

  for (const part of chunks(credits, 1000)) {
    const hops = part.flatMap((t) => {
      const shares = hopShares(t);
      return t.hops.map((h, i) => ({ tx: t.txHash, hop: i, poolId: h.poolId, usd: h.usd, share: shares[i]!, buy: h.buy }));
    });
    await sql().transaction([
      sql().query(
        `insert into tx_credits (tx_hash, wallet, ts, credit_usd, gross_usd, fees_usd, indexer_usd, off_market, paid, received)
         select * from unnest($1::text[], $2::text[], $3::bigint[], $4::float8[], $5::float8[], $6::float8[], $7::float8[], $8::bool[], $9::jsonb[], $10::jsonb[])
         on conflict (tx_hash) do update set
           -- a relayed swap keeps the trader it was resolved to (relay.ts), not the relayer
           wallet = coalesce((select r.trader from tx_traders r where r.tx_hash = excluded.tx_hash and r.status = 'resolved'), excluded.wallet),
           ts = excluded.ts, credit_usd = excluded.credit_usd,
           gross_usd = excluded.gross_usd, fees_usd = excluded.fees_usd, indexer_usd = excluded.indexer_usd,
           off_market = excluded.off_market, paid = excluded.paid, received = excluded.received`,
        [
          part.map((t) => t.txHash), part.map((t) => t.wallet), part.map((t) => t.timestamp), part.map((t) => t.creditUsd),
          part.map((t) => t.grossUsd), part.map((t) => t.feesUsd), part.map((t) => t.indexerUsd), part.map((t) => t.offMarket),
          part.map((t) => JSON.stringify(t.paid)), part.map((t) => JSON.stringify(t.received)),
        ],
      ),
      sql().query(`delete from tx_hops where tx_hash = any($1::text[])`, [part.map((t) => t.txHash)]),
      sql().query(
        `insert into tx_hops (tx_hash, hop, pool_id, usd, share_usd, buy)
         select * from unnest($1::text[], $2::int[], $3::text[], $4::float8[], $5::float8[], $6::bool[])`,
        [hops.map((h) => h.tx), hops.map((h) => h.hop), hops.map((h) => h.poolId), hops.map((h) => h.usd), hops.map((h) => h.share), hops.map((h) => h.buy)],
      ),
    ]);
  }
  return { priceSources: [...prices.sources] };
}

export interface SyncResult {
  throughTs: number; // swaps with start <= ts < throughTs are stored
  fetched: number;
  complete: boolean; // false when a backfill hit the page budget and will continue next refresh
  priceSources: string[];
}

// Brings a round's swaps up to date. `cursorId` is the round id or "preview".
export async function syncWindow(cursorId: string, start: number, end: number, now: number, slidingStart = false): Promise<SyncResult> {
  const poolIds = Object.keys(POOLS);
  const poolSig = [...poolIds].sort().join(",");
  const rows = await sql()`select start_ts, through_ts, pools from sync_cursors where round_id = ${cursorId}`;
  const cur = rows[0];
  // Reuse the cursor when it still describes this window and pool set. Preview's start
  // slides forward every refresh, so it only needs the cursor to still be inside the window.
  let through = start;
  let resumed = false;
  if (cur && String(cur.pools) === poolSig) {
    const curStart = num(cur.start_ts);
    const curThrough = num(cur.through_ts);
    if (slidingStart ? curStart <= start && curThrough >= start : curStart === start) {
      through = curThrough;
      resumed = true;
    }
  }

  const head = Math.min(end, now - INDEXER_LAG_SEC);
  if (through >= end || head <= start || head <= through) {
    return { throughTs: Math.min(Math.max(through, start), end), fetched: 0, complete: through >= end || head <= start, priceSources: [] };
  }
  const from = resumed ? Math.max(start, through - RESUME_OVERLAP_SEC) : start;
  const pulled = await fetchSwapsUpTo(poolIds, from, head, MAX_PAGES_PER_REFRESH);
  const { priceSources } = await storeSwapsAndCredits(pulled.swaps);
  const newThrough = Math.max(through, pulled.throughTs);
  await sql()`insert into sync_cursors (round_id, start_ts, through_ts, pools) values (${cursorId}, ${start}, ${newThrough}, ${poolSig})
              on conflict (round_id) do update set start_ts = excluded.start_ts, through_ts = excluded.through_ts, pools = excluded.pools`;
  return { throughTs: newThrough, fetched: pulled.swaps.length, complete: pulled.throughTs >= head, priceSources };
}
