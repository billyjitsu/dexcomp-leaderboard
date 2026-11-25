// Builds a round's leaderboard from stored transaction credits and saves it as a snapshot.
// The per-wallet totals are computed in SQL so only a few hundred rows leave the database
// per refresh. score.ts aggregateTxs is the same logic in TypeScript (tests check them
// against each other on real data: npm run db:verify).

import { EXCLUDED_WALLETS, POOLS, RULES } from "./config.ts";
import { num, sql } from "./db.ts";
import { loadDisqualified, loadOptIns } from "./rounds.ts";
import { rankBoard, toPublic, type OptInMap, type WalletAgg } from "./score.ts";
import type { Leaderboard, TradeRow, WalletTrades } from "./types.ts";

export interface BoardTarget {
  roundId: string; // "preview" or a round id
  name: string;
  start: number;
  end: number;
  status: Leaderboard["status"];
  finalizedAt: number | null;
  optInRequired: boolean; // false (and preview) = every wallet counts
}

const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";

export function labelOf(t: BoardTarget): string {
  return t.roundId === "preview" ? t.name : `${t.name}: ${iso(t.start)} to ${iso(t.end)}`;
}

// The transactions in a round window, with whether each one qualifies (minimum size) and
// whether it counts (opted in before it). Shared by the wallet and pool queries.
const WINDOW_CTE = `
  with t as (
    select c.tx_hash, c.wallet, c.ts, c.credit_usd, c.gross_usd, c.fees_usd, c.indexer_usd, c.off_market,
           c.credit_usd >= $3 as qual,
           ($5::boolean or (o.wallet is not null and c.ts >= greatest(o.from_ts, $1))) as counted
    from tx_credits c
    left join opt_ins o on o.round_id = $4 and o.wallet = c.wallet
    where c.ts >= $1 and c.ts < $2
  )`;

// everyoneCounts: no opt-in needed (preview, or a round with opt-in switched off).
export async function aggregateInDb(roundId: string, start: number, endExcl: number, everyoneCounts: boolean): Promise<{ aggs: WalletAgg[]; droppedTxs: number }> {
  const params = [start, endExcl, RULES.minTxUsd, roundId === "preview" ? null : roundId, everyoneCounts];
  const [walletRows, poolRows] = await Promise.all([
    sql().query(
      `${WINDOW_CTE}
       select wallet,
              count(*)::int as all_txs,
              percentile_cont(0.5) within group (order by credit_usd) as median_usd,
              sum(gross_usd) as gross_usd,
              (count(*) filter (where off_market))::int as off_market_txs,
              coalesce(sum(credit_usd) filter (where qual and counted), 0) as volume_usd,
              (count(*) filter (where qual and counted))::int as txs,
              coalesce(sum(fees_usd) filter (where qual and counted), 0) as fees_usd,
              coalesce(sum(indexer_usd) filter (where qual and counted), 0) as indexer_usd,
              min(ts) as first_ts,
              coalesce(max(ts) filter (where qual and counted), min(ts)) as last_ts,
              coalesce(sum(credit_usd) filter (where qual and not counted), 0) as uncounted_usd,
              (count(*) filter (where not qual))::int as dropped
       from t group by wallet`,
      params,
    ),
    sql().query(
      `${WINDOW_CTE}
       select t.wallet, h.pool_id,
              coalesce(sum(h.share_usd) filter (where t.counted), 0) as counted_usd,
              sum(h.share_usd) as all_usd,
              count(distinct h.tx_hash)::int as trades,
              coalesce(sum(h.share_usd) filter (where h.buy), 0) as buy_usd,
              coalesce(sum(h.share_usd) filter (where not h.buy), 0) as sell_usd
       from t join tx_hops h on h.tx_hash = t.tx_hash
       where t.qual
       group by t.wallet, h.pool_id`,
      params,
    ),
  ]);

  const pools = new Map<string, WalletAgg["pools"]>();
  for (const r of poolRows) {
    const id = String(r.pool_id);
    const list = pools.get(String(r.wallet)) ?? [];
    list.push({
      poolId: id, name: POOLS[id]?.name ?? id, feeBps: POOLS[id]?.feeBps ?? 0,
      countedUsd: num(r.counted_usd), allUsd: num(r.all_usd), trades: num(r.trades), buyUsd: num(r.buy_usd), sellUsd: num(r.sell_usd),
    });
    pools.set(String(r.wallet), list);
  }
  let droppedTxs = 0;
  const aggs = walletRows.map((r): WalletAgg => {
    droppedTxs += num(r.dropped);
    return {
      wallet: String(r.wallet),
      allTxs: num(r.all_txs),
      medianTxUsd: num(r.median_usd),
      grossUsd: num(r.gross_usd),
      offMarketTxs: num(r.off_market_txs),
      volumeUsd: num(r.volume_usd),
      txs: num(r.txs),
      feesUsd: num(r.fees_usd),
      indexerUsd: num(r.indexer_usd),
      firstTs: num(r.first_ts),
      lastTs: num(r.last_ts),
      uncountedUsd: num(r.uncounted_usd),
      pools: (pools.get(String(r.wallet)) ?? []).sort((a, b) => b.allUsd - a.allUsd),
    };
  });
  return { aggs, droppedTxs };
}

// Builds the board for a window whose swaps are synced through `throughTs`, and saves it.
export async function buildSnapshot(t: BoardTarget, throughTs: number, generatedAt: number, priceSources: string[]): Promise<Leaderboard> {
  const preview = t.roundId === "preview";
  const everyone = preview || !t.optInRequired;
  const endExcl = Math.min(t.end, throughTs);
  const [{ aggs, droppedTxs }, optIn, disqualified] = await Promise.all([
    aggregateInDb(t.roundId, t.start, endExcl, everyone),
    everyone ? Promise.resolve(null as OptInMap | null) : loadOptIns(t.roundId, t.start),
    preview ? Promise.resolve(new Map<string, { reason: string; at: number }>()) : loadDisqualified(t.roundId),
  ]);
  const board = rankBoard({
    aggs, droppedTxs,
    round: { start: t.start, end: t.end, label: labelOf(t) },
    dataThroughTs: endExcl,
    optIn,
    optInInfo: optIn ? { roundId: t.roundId, roundName: t.name, open: generatedAt < t.end && t.status !== "final", closesAt: t.end, joinedWallets: optIn.size } : null,
    excluded: EXCLUDED_WALLETS,
    disqualified,
    roundId: t.roundId,
    status: t.status,
    finalizedAt: t.finalizedAt,
    priceSources,
    generatedAt,
  });
  await sql()`insert into snapshots (round_id, generated_at, status, board, public)
              values (${t.roundId}, ${generatedAt}, ${t.status}, ${JSON.stringify(board)}::jsonb, ${JSON.stringify(toPublic(board))}::jsonb)
              on conflict (round_id) do update set generated_at = excluded.generated_at, status = excluded.status,
                board = excluded.board, public = excluded.public`;
  return board;
}

// A wallet's trades in a window, newest first (admin view). Computed on demand from the
// stored credits rather than stored per wallet.
const MAX_TRADES = 500;

export async function walletTrades(roundId: string, start: number, end: number, wallet: string, everyoneCounts: boolean): Promise<WalletTrades> {
  const preview = everyoneCounts;
  const [rows, countRows, optIns] = await Promise.all([
    sql()`select c.tx_hash, c.ts, c.credit_usd, c.off_market, c.paid, c.received,
                 coalesce(array_agg(h.pool_id order by h.hop) filter (where h.pool_id is not null), '{}') as pools
          from tx_credits c left join tx_hops h on h.tx_hash = c.tx_hash
          where c.wallet = ${wallet} and c.ts >= ${start} and c.ts < ${end}
          group by c.tx_hash order by c.ts desc limit ${MAX_TRADES}`,
    sql()`select count(*)::int as n from tx_credits where wallet = ${wallet} and ts >= ${start} and ts < ${end}`,
    preview ? Promise.resolve(null) : loadOptIns(roundId, start),
  ]);
  const join = optIns?.get(wallet);
  const trades = rows.map((r): TradeRow => {
    const ts = num(r.ts);
    const usd = num(r.credit_usd);
    const status: TradeRow["status"] = usd < RULES.minTxUsd ? "under-min"
      : !optIns || (join && ts >= join.from) ? "counted"
      : join ? "before-opt-in" : "not-joined";
    const poolIds = (r.pools as string[]) ?? [];
    return {
      ts,
      tx: String(r.tx_hash),
      pools: [...new Set(poolIds.map((id) => `${POOLS[id]?.name ?? id} ${(POOLS[id]?.feeBps ?? 0) / 100}%`))],
      paid: r.paid as [string, number][],
      received: r.received as [string, number][],
      usd: Math.round(usd * 100) / 100,
      status,
      offMarket: Boolean(r.off_market),
    };
  });
  return { wallet, total: num(countRows[0]?.n ?? 0), trades };
}
