// Checks the Postgres pipeline against the original file-based leaderboard for a round:
//   1. SQL per-wallet totals vs the TypeScript reference (aggregateTxs) on the stored credits
//   2. the rebuilt board vs the legacy admin/rounds/<id>.json the old pipeline wrote
//   npm run db:verify -- demo-1
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { aggregateInDb, buildSnapshot } from "../src/lib/board.ts";
import { num, nowSec, sql } from "../src/lib/db.ts";
import { loadOptIns, roundById, statusOf } from "../src/lib/rounds.ts";
import { aggregateTxs, type TxCredit } from "../src/lib/score.ts";
import type { Leaderboard } from "../src/lib/types.ts";

const roundId = process.argv[2] ?? "demo-1";
const round = await roundById(roundId);
if (!round) throw new Error(`no round ${roundId}`);
const [cursor] = await sql()`select through_ts from sync_cursors where round_id = ${roundId}`;
const through = Math.min(round.end, num(cursor?.through_ts ?? round.start));

let failures = 0;
const close = (a: number, b: number, tol = 0.005) => Math.abs(a - b) <= tol + Math.abs(b) * 1e-9;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  if (!ok || process.env.VERBOSE) console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` ${detail}` : ""}`);
}

// 1. SQL vs TypeScript aggregation over the same stored credits.
const rows = await sql()`select c.*, coalesce(json_agg(json_build_object('poolId', h.pool_id, 'usd', h.usd, 'buy', h.buy) order by h.hop) filter (where h.tx_hash is not null), '[]') as hops
                         from tx_credits c left join tx_hops h on h.tx_hash = c.tx_hash
                         where c.ts >= ${round.start} and c.ts < ${through} group by c.tx_hash`;
const txs: TxCredit[] = rows.map((r) => ({
  txHash: String(r.tx_hash), wallet: String(r.wallet), timestamp: num(r.ts), creditUsd: num(r.credit_usd), grossUsd: num(r.gross_usd),
  feesUsd: num(r.fees_usd), indexerUsd: num(r.indexer_usd), offMarket: Boolean(r.off_market),
  hops: r.hops as TxCredit["hops"], paid: [], received: [],
})).sort((a, b) => a.timestamp - b.timestamp);
const optIn = round.optInRequired ? await loadOptIns(roundId, round.start) : null;
const ts = aggregateTxs(txs, optIn);
const db = await aggregateInDb(roundId, round.start, through, !round.optInRequired);
check("dropped txs", ts.droppedTxs === db.droppedTxs, `${db.droppedTxs} vs ${ts.droppedTxs}`);
check("wallet count", ts.aggs.length === db.aggs.length, `${db.aggs.length} vs ${ts.aggs.length}`);
const dbBy = new Map(db.aggs.map((a) => [a.wallet, a]));
for (const a of ts.aggs) {
  const b = dbBy.get(a.wallet);
  if (!b) {
    check(`wallet ${a.wallet} present in SQL`, false);
    continue;
  }
  for (const k of ["allTxs", "medianTxUsd", "grossUsd", "offMarketTxs", "volumeUsd", "txs", "feesUsd", "indexerUsd", "firstTs", "lastTs", "uncountedUsd"] as const) {
    check(`${a.wallet} ${k}`, close(b[k], a[k]), `${b[k]} vs ${a[k]}`);
  }
  check(`${a.wallet} pool count`, a.pools.length === b.pools.length, `${b.pools.length} vs ${a.pools.length}`);
  const bp = new Map(b.pools.map((p) => [p.poolId, p]));
  for (const p of a.pools) {
    const q = bp.get(p.poolId);
    for (const k of ["countedUsd", "allUsd", "trades", "buyUsd", "sellUsd"] as const) check(`${a.wallet} ${p.name} ${k}`, q !== undefined && close(q[k], p[k]), `${q?.[k]} vs ${p[k]}`);
  }
}
console.log(`1. SQL vs TypeScript totals: ${txs.length} txs, ${ts.aggs.length} wallets, ${failures} mismatches`);

// 2. Rebuilt board vs the legacy pipeline's output.
const legacyPath = join(import.meta.dirname, "..", "..", "leaderboard", "admin", "rounds", `${roundId}.json`);
if (existsSync(legacyPath)) {
  const before = failures;
  const legacy = JSON.parse(readFileSync(legacyPath, "utf8")) as Leaderboard;
  const now = nowSec();
  const board = await buildSnapshot({ roundId, name: round.name, start: round.start, end: round.end, status: statusOf(round, now), finalizedAt: round.finalizedAt, optInRequired: round.optInRequired }, through, now, []);
  check("total volume", close(board.totals.volumeUsd, legacy.totals.volumeUsd, 0.01), `${board.totals.volumeUsd} vs ${legacy.totals.volumeUsd}`);
  check("credited txs", board.totals.txs === legacy.totals.txs, `${board.totals.txs} vs ${legacy.totals.txs}`);
  check("dropped txs", board.totals.droppedTxs === legacy.totals.droppedTxs, `${board.totals.droppedTxs} vs ${legacy.totals.droppedTxs}`);
  check("ranked wallets", board.totals.rankedWallets === legacy.totals.rankedWallets, `${board.totals.rankedWallets} vs ${legacy.totals.rankedWallets}`);
  check("rows", board.rows.length === legacy.rows.length, `${board.rows.length} vs ${legacy.rows.length}`);
  const newBy = new Map(board.rows.map((r) => [r.wallet, r]));
  for (const r of legacy.rows) {
    const n = newBy.get(r.wallet);
    check(`${r.wallet} present`, n !== undefined);
    if (!n) continue;
    check(`${r.wallet} rank`, n.rank === r.rank, `${n.rank} vs ${r.rank}`);
    check(`${r.wallet} volume`, close(n.volumeUsd, r.volumeUsd, 0.01), `${n.volumeUsd} vs ${r.volumeUsd}`);
    check(`${r.wallet} uncounted`, close(n.uncountedUsd, r.uncountedUsd, 0.01), `${n.uncountedUsd} vs ${r.uncountedUsd}`);
    check(`${r.wallet} reward`, close(n.estRewardUsd, r.estRewardUsd, 0.01), `${n.estRewardUsd} vs ${r.estRewardUsd}`);
    check(`${r.wallet} flags`, [...n.flags].sort().join() === [...r.flags].sort().join(), `${n.flags.join("|")} vs ${r.flags.join("|")}`);
  }
  console.log(`2. Rebuilt board vs legacy file: ${legacy.rows.length} rows, ${failures - before} mismatches`);
} else {
  console.log(`2. skipped: no legacy board at ${legacyPath}`);
}
process.exitCode = failures ? 1 : 0;
