import { MILESTONES, POOLS, REWARD_TOKEN, RULES, TOKENS } from "./config.ts";
import type { PriceBook } from "./prices.ts";
import type { Leaderboard, PoolTokens, PublicLeaderboard, PublicRow, Swap, WalletRow } from "./types.ts";

// Strips the admin-only fields (trades, fees, flags, indexer comparison) and excluded wallets.
export function toPublic(b: Leaderboard): PublicLeaderboard {
  return {
    generatedAt: b.generatedAt,
    round: b.round,
    roundId: b.roundId,
    status: b.status,
    dataThroughTs: b.dataThroughTs,
    totals: { volumeUsd: b.totals.volumeUsd, rankedWallets: b.totals.rankedWallets },
    prize: b.prize,
    rewardToken: REWARD_TOKEN,
    pools: b.pools.map((p) => ({ name: p.name, feeBps: p.feeBps })),
    rules: b.rules,
    optIn: b.optIn,
    // Only the paid places are published as a list. Everyone else is looked up one
    // wallet at a time (publicWalletRow) when that wallet connects.
    rows: b.rows.filter((r) => r.rank !== null && r.rank <= b.rules.paidRanks).map(publicWalletRow).filter((r) => r !== null),
  };
}

// A wallet's public view of itself. null for excluded wallets (never shown publicly).
export function publicWalletRow(r: WalletRow): PublicRow | null {
  if (r.flags.includes("excluded")) return null;
  return {
    rank: r.rank, wallet: r.wallet, volumeUsd: Math.round(r.volumeUsd * 100) / 100, reward: Math.floor(r.estRewardUsd), joined: r.joined,
    disqualified: r.flags.includes("disqualified"),
  };
}

export interface TxCredit {
  txHash: string;
  wallet: string;
  timestamp: number;
  creditUsd: number; // what counts toward the competition
  grossUsd: number; // sum of every hop's priced value (what naive summing would give)
  feesUsd: number;
  indexerUsd: number; // indexer's own amountUSD, kept only for comparison
  offMarket: boolean; // a hop traded far from exchange prices (see RULES.offMarket)
  // Each competition-pool hop: its value and whether the trader bought the pool's base
  // token (the first symbol in the pool name, e.g. ETH in ETH/USDC). Admin breakdown only.
  hops: { poolId: string; usd: number; buy: boolean }[];
  // What the trader paid and received overall (route tokens netted out), [symbol, amount].
  paid: [string, number][];
  received: [string, number][];
}

// Why a trade did or didn't score, for the admin trade list.
export type TradeStatus = "counted" | "under-min" | "before-opt-in" | "not-joined";

// Credits one transaction from its net token flow across competition-pool hops.
//
// Pool amounts are signed from the pool's side, so for the trader a positive net is a
// token paid in and a negative net is a token received. Intermediate tokens on a route
// net to ~0, which makes a two-pool route count once (question 15) and a circular
// arbitrage (USDC -> ETH -> USDC) count ~0 (question 16). Hops through excluded pools
// are not in the data, so only the competition-pool leg is credited.
//
// Every token is valued at one-minute exchange prices, never at Katana pool prices, and
// credit = min(value in, value out). Pushing a thin pool's price, or trading at an
// off-market price against your own liquidity, therefore cannot inflate credit: the
// overpaid side is ignored (question 12). If a side is unpriced, the priced side counts.
export function creditTx(swaps: Swap[], pools: Map<string, PoolTokens>, prices: PriceBook): TxCredit {
  const first = swaps[0]!;
  const net = new Map<string, number>();
  const gross = new Map<string, number>();
  let grossUsd = 0;
  let feesUsd = 0;
  let indexerUsd = 0;
  let offMarket = false;
  const hops: TxCredit["hops"] = [];

  for (const s of swaps) {
    const p = pools.get(s.poolId);
    if (!p) throw new Error(`no token data for pool ${s.poolId}`);
    for (const [token, amt] of [[p.token0, s.amount0], [p.token1, s.amount1]] as const) {
      net.set(token, (net.get(token) ?? 0) + amt);
      gross.set(token, (gross.get(token) ?? 0) + Math.abs(amt));
    }
    const [v0, v1] = legValues(p, s, prices);
    const hopUsd = hopValue(v0, v1);
    if (v0 !== null && v1 !== null && Math.max(v0, v1) >= RULES.offMarket.minHopUsd
        && 1 - Math.min(v0, v1) / Math.max(v0, v1) > RULES.offMarket.maxDeviation) offMarket = true;
    grossUsd += hopUsd;
    hops.push({ poolId: s.poolId, usd: hopUsd, buy: boughtBase(p, s) });
    feesUsd += (hopUsd * (POOLS[s.poolId]?.feeBps ?? 0)) / 10_000;
    indexerUsd += s.amountUSD;
  }

  let inUsd = 0;
  let outUsd = 0;
  let inUnpriced = false;
  let outUnpriced = false;
  const paid: [string, number][] = [];
  const received: [string, number][] = [];
  for (const [token, n] of net) {
    if (Math.abs(n) <= (gross.get(token) ?? 0) * 1e-6) continue; // intermediate hop token
    const info = TOKENS[token];
    if (n > 0) paid.push([info?.symbol ?? token.slice(0, 10), n]);
    else received.push([info?.symbol ?? token.slice(0, 10), -n]);
    const usd = info?.price ? Math.abs(n) * prices.at(info.price, first.timestamp) : null;
    if (n > 0) {
      if (usd === null) inUnpriced = true;
      else inUsd += usd;
    } else {
      if (usd === null) outUnpriced = true;
      else outUsd += usd;
    }
  }

  let creditUsd = 0;
  if (inUsd > 0 && outUsd > 0) creditUsd = Math.min(inUsd, outUsd);
  else if (inUsd > 0 && outUnpriced) creditUsd = inUsd;
  else if (outUsd > 0 && inUnpriced) creditUsd = outUsd;

  return { txHash: first.txHash, wallet: first.origin, timestamp: first.timestamp, creditUsd, grossUsd, feesUsd, indexerUsd, offMarket, hops, paid, received };
}

// Each hop's share of its transaction's credit, in proportion to the hop's value. Used for
// the per-pool breakdown (stored as tx_hops.share_usd).
export function hopShares(t: TxCredit): number[] {
  const total = t.hops.reduce((a, h) => a + h.usd, 0);
  return t.hops.map((h) => (total > 0 ? (t.creditUsd * h.usd) / total : 0));
}

// True when the trader received the pool's base token (pool amount for it is negative).
function boughtBase(p: PoolTokens, s: Swap): boolean {
  const base = POOLS[s.poolId]?.name.split("/")[0];
  const baseIs0 = TOKENS[p.token0]?.symbol === base;
  return (baseIs0 ? s.amount0 : s.amount1) < 0;
}

// Each leg of a hop at exchange prices (null if the token is unpriced).
function legValues(p: PoolTokens, s: Swap, prices: PriceBook): [number | null, number | null] {
  const value = (token: string, amt: number) => {
    const key = TOKENS[token]?.price;
    return key ? Math.abs(amt) * prices.at(key, s.timestamp) : null;
  };
  return [value(p.token0, s.amount0), value(p.token1, s.amount1)];
}

// A hop's value is its smaller priced leg, matching how transactions are credited.
function hopValue(v0: number | null, v1: number | null): number {
  if (v0 !== null && v1 !== null) return Math.min(v0, v1);
  return v0 ?? v1 ?? 0;
}

export function groupByTx(swaps: Swap[]): Swap[][] {
  const byTx = new Map<string, Swap[]>();
  for (const s of swaps) {
    const list = byTx.get(s.txHash);
    if (list) list.push(s);
    else byTx.set(s.txHash, [s]);
  }
  return [...byTx.values()];
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

// ---------------------------------------------------------------------------
// Per-wallet totals. Production computes these in SQL (src/lib/board.ts); aggregateTxs is
// the same logic in TypeScript, used by tests and to check the SQL against.

export type OptInMap = Map<string, { from: number; source: "signature" | "admin" }>;

export interface WalletAgg {
  wallet: string;
  allTxs: number; // every transaction, including ones under the minimum
  medianTxUsd: number; // median credit over every transaction
  grossUsd: number;
  offMarketTxs: number;
  volumeUsd: number; // counted: at or above the minimum and after opt-in
  txs: number;
  feesUsd: number;
  indexerUsd: number;
  firstTs: number;
  lastTs: number;
  uncountedUsd: number; // at or above the minimum, but before opt-in or without one
  pools: WalletRow["pools"];
}

// optIn null = preview mode: every wallet counts. optIn "from" is already clamped to the
// round start.
export function aggregateTxs(txs: TxCredit[], optIn: OptInMap | null): { aggs: WalletAgg[]; droppedTxs: number } {
  interface Acc extends WalletAgg { all: number[]; poolMap: Map<string, WalletRow["pools"][number]> }
  const wallets = new Map<string, Acc>();
  let droppedTxs = 0;
  for (const t of txs) {
    let w = wallets.get(t.wallet);
    if (!w) {
      w = { wallet: t.wallet, allTxs: 0, medianTxUsd: 0, grossUsd: 0, offMarketTxs: 0, volumeUsd: 0, txs: 0, feesUsd: 0, indexerUsd: 0, firstTs: t.timestamp, lastTs: 0, uncountedUsd: 0, pools: [], all: [], poolMap: new Map() };
      wallets.set(t.wallet, w);
    }
    w.allTxs++;
    w.all.push(t.creditUsd);
    w.grossUsd += t.grossUsd;
    w.firstTs = Math.min(w.firstTs, t.timestamp);
    if (t.offMarket) w.offMarketTxs++;
    if (t.creditUsd < RULES.minTxUsd) {
      droppedTxs++;
      continue;
    }
    const joinedAt = optIn?.get(t.wallet);
    const counted = !optIn || (joinedAt !== undefined && t.timestamp >= joinedAt.from);
    const shares = hopShares(t);
    const touched = new Set<string>();
    t.hops.forEach((h, i) => {
      const share = shares[i]!;
      let pa = w.poolMap.get(h.poolId);
      if (!pa) {
        pa = { poolId: h.poolId, name: POOLS[h.poolId]?.name ?? h.poolId, feeBps: POOLS[h.poolId]?.feeBps ?? 0, countedUsd: 0, allUsd: 0, trades: 0, buyUsd: 0, sellUsd: 0 };
        w.poolMap.set(h.poolId, pa);
      }
      pa.allUsd += share;
      if (counted) pa.countedUsd += share;
      if (h.buy) pa.buyUsd += share;
      else pa.sellUsd += share;
      if (!touched.has(h.poolId)) pa.trades++;
      touched.add(h.poolId);
    });
    if (!counted) {
      w.uncountedUsd += t.creditUsd;
      continue;
    }
    w.volumeUsd += t.creditUsd;
    w.txs++;
    w.feesUsd += t.feesUsd;
    w.indexerUsd += t.indexerUsd;
    w.lastTs = Math.max(w.lastTs, t.timestamp);
  }
  const aggs = [...wallets.values()].map(({ all, poolMap, ...w }) => ({
    ...w,
    lastTs: w.lastTs || w.firstTs,
    medianTxUsd: median(all),
    pools: [...poolMap.values()].sort((a, b) => b.allUsd - a.allUsd),
  }));
  return { aggs, droppedTxs };
}

// In-memory pipeline (swaps -> credits -> totals -> board), the same as the original
// file-based leaderboard. Used by tests and by scripts/verify.ts as the reference.
export interface BuildInput {
  swaps: Swap[];
  pools: Map<string, PoolTokens>;
  prices: PriceBook;
  round: { start: number; end: number; label: string };
  dataThroughTs: number;
  optIn: OptInMap | null;
  optInInfo: Leaderboard["optIn"];
  excluded: Set<string>;
  disqualified?: Set<string>;
  roundId: string;
  status: Leaderboard["status"];
}

export function buildLeaderboard(input: BuildInput): Leaderboard {
  const txs = groupByTx(input.swaps).map((group) => creditTx(group, input.pools, input.prices));
  const { aggs, droppedTxs } = aggregateTxs(txs, input.optIn);
  return rankBoard({
    aggs, droppedTxs, round: input.round, dataThroughTs: input.dataThroughTs, optIn: input.optIn, optInInfo: input.optInInfo,
    excluded: input.excluded, disqualified: new Map([...(input.disqualified ?? [])].map((w) => [w, { reason: "test", at: 0 }])),
    roundId: input.roundId, status: input.status, finalizedAt: null, priceSources: [], generatedAt: Math.floor(Date.now() / 1000),
  });
}

// ---------------------------------------------------------------------------
// Flags, ranking, prizes and pool totals from per-wallet totals.

export interface RankInput {
  aggs: WalletAgg[];
  droppedTxs: number;
  round: { start: number; end: number; label: string };
  dataThroughTs: number;
  optIn: OptInMap | null; // null = preview mode
  optInInfo: Leaderboard["optIn"];
  excluded: Set<string>;
  disqualified: Map<string, { reason: string; at: number }>;
  roundId: string;
  status: Leaderboard["status"];
  finalizedAt: number | null;
  priceSources: string[];
  generatedAt: number;
}

// Wallets that never rank and whose volume doesn't unlock milestones.
const sidelined = (r: WalletRow) => r.flags.includes("excluded") || r.flags.includes("disqualified");

const emptyAgg = (wallet: string): WalletAgg => ({ wallet, allTxs: 0, medianTxUsd: 0, grossUsd: 0, offMarketTxs: 0, volumeUsd: 0, txs: 0, feesUsd: 0, indexerUsd: 0, firstTs: 0, lastTs: 0, uncountedUsd: 0, pools: [] });

export function rankBoard(input: RankInput): Leaderboard {
  const { round, optIn, excluded } = input;
  const byWallet = new Map(input.aggs.map((a) => [a.wallet, a]));
  // Opted-in wallets that haven't traded yet still show in the admin view.
  for (const wallet of optIn?.keys() ?? []) if (!byWallet.has(wallet)) byWallet.set(wallet, emptyAgg(wallet));

  const days = Math.max(1, (Math.min(input.dataThroughTs, round.end) - round.start) / 86_400);
  const rows: WalletRow[] = [];
  for (const [wallet, w] of byWallet) {
    const join = optIn?.get(wallet) ?? null;
    const flags: string[] = [];
    if (optIn && !join) flags.push("not-joined");
    if (excluded.has(wallet)) flags.push("excluded");
    if (input.disqualified.has(wallet)) flags.push("disqualified");
    if (w.allTxs / days > RULES.flags.highFrequencyTxPerDay) flags.push("high-frequency");
    if (w.allTxs >= RULES.flags.farmingMinTxs && w.medianTxUsd < RULES.flags.farmingMedianTxUsd) flags.push("small-repeat");
    if (w.grossUsd > 3 * Math.max(w.volumeUsd, 1)) flags.push("circular");
    if (w.offMarketTxs > 0) flags.push("off-market");
    if (w.volumeUsd <= 0 && w.uncountedUsd <= 0 && !join && flags.length === 0) continue;
    rows.push({
      rank: null, wallet, volumeUsd: w.volumeUsd, txs: w.txs, offMarketTxs: w.offMarketTxs, feesUsd: w.feesUsd, indexerUsd: w.indexerUsd,
      firstTs: w.firstTs, lastTs: w.lastTs, flags, shareOfPaid: 0, estRewardUsd: 0,
      joined: optIn ? join !== null : null, joinedFrom: join?.from ?? null, joinSource: join?.source ?? null, uncountedUsd: w.uncountedUsd,
      pools: w.pools,
    });
  }
  rows.sort((a, b) => b.volumeUsd - a.volumeUsd || b.uncountedUsd - a.uncountedUsd || (a.wallet < b.wallet ? -1 : 1));

  const poolStats = new Map<string, Leaderboard["poolStats"][number]>();
  for (const r of rows) {
    for (const p of r.pools) {
      let s = poolStats.get(p.poolId);
      if (!s) {
        s = { poolId: p.poolId, name: p.name, feeBps: p.feeBps, countedUsd: 0, allUsd: 0, trades: 0, traders: 0, netBuyers: 0, netSellers: 0, buyUsd: 0, sellUsd: 0 };
        poolStats.set(p.poolId, s);
      }
      if (!sidelined(r)) s.countedUsd += p.countedUsd; // disqualified/excluded volume never counts
      s.allUsd += p.allUsd;
      s.trades += p.trades;
      s.traders++;
      s.buyUsd += p.buyUsd;
      s.sellUsd += p.sellUsd;
      if (p.buyUsd > p.sellUsd) s.netBuyers++;
      else if (p.sellUsd > p.buyUsd) s.netSellers++;
    }
  }

  const competitionVolume = rows.filter((r) => !sidelined(r)).reduce((a, r) => a + r.volumeUsd, 0);
  const reached = MILESTONES.filter((m) => competitionVolume >= m.volumeUsd);
  const unlockedUsd = reached.at(-1)?.poolUsd ?? 0;

  let rank = 0;
  const ranked = rows.filter((r) => !sidelined(r) && r.joined !== false && r.volumeUsd >= RULES.minWalletUsd);
  for (const r of ranked) r.rank = ++rank;
  const paid = ranked.slice(0, RULES.paidRanks);
  const paidVol = paid.reduce((a, r) => a + r.volumeUsd, 0);
  for (const r of paid) {
    r.shareOfPaid = paidVol > 0 ? r.volumeUsd / paidVol : 0;
    r.estRewardUsd = r.shareOfPaid * unlockedUsd;
  }

  return {
    generatedAt: input.generatedAt,
    round,
    roundId: input.roundId,
    status: input.status,
    rewardToken: REWARD_TOKEN,
    disqualifiedInfo: Object.fromEntries(input.disqualified),
    finalizedAt: input.finalizedAt,
    optIn: input.optInInfo,
    prices: { sources: input.priceSources, maxGapSec: 0 },
    dataThroughTs: input.dataThroughTs,
    totals: {
      volumeUsd: competitionVolume,
      indexerUsd: rows.reduce((a, r) => a + r.indexerUsd, 0),
      txs: rows.reduce((a, r) => a + r.txs, 0),
      wallets: rows.length,
      rankedWallets: ranked.length,
      droppedTxs: input.droppedTxs,
    },
    prize: {
      unlockedUsd,
      capUsd: MILESTONES.at(-1)?.poolUsd ?? 0,
      milestones: MILESTONES.map((m) => ({ ...m, reached: competitionVolume >= m.volumeUsd })),
      nextMilestone: MILESTONES.find((m) => competitionVolume < m.volumeUsd) ?? null,
    },
    pools: Object.entries(POOLS).map(([id, p]) => ({ id, name: p.name, feeBps: p.feeBps })),
    poolStats: [...poolStats.values()].sort((a, b) => b.allUsd - a.allUsd),
    rules: { minTxUsd: RULES.minTxUsd, minWalletUsd: RULES.minWalletUsd, paidRanks: RULES.paidRanks },
    rows: [...ranked, ...rows.filter((r) => r.rank === null)],
  };
}
