// One-time import of the file-based leaderboard (../leaderboard) into Postgres: rounds,
// opt-ins, disqualifications/finalization, cached swaps (credited on the way in), prices
// and pool tokens. Safe to re-run.   npm run db:import-legacy
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { POOLS } from "../src/lib/config.ts";
import { chunks, sql } from "../src/lib/db.ts";
import { PRICED_KEYS } from "../src/lib/prices.ts";
import { dbPriceStore, storeSwapsAndCredits } from "../src/lib/sync.ts";
import type { PoolTokens, Swap } from "../src/lib/types.ts";

const LEGACY = join(import.meta.dirname, "..", "..", "leaderboard");
// Loaded at runtime (not a static import) so builds don't need the legacy folder.
const { ROUNDS } = (await import(pathToFileURL(join(LEGACY, "src", "config.ts")).href)) as {
  ROUNDS: { id: string; name: string; start: string; end: string }[];
};
const readJson = <T>(p: string): T => JSON.parse(readFileSync(join(LEGACY, p), "utf8")) as T;
const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

// Rounds and their state.
for (const r of ROUNDS) {
  const statePath = join("data", "rounds", `${r.id}.json`);
  const state = existsSync(join(LEGACY, statePath))
    ? readJson<{ final: boolean; finalizedAt: number | null; disqualified: Record<string, { reason: string; at: number }> }>(statePath)
    : { final: false, finalizedAt: null, disqualified: {} };
  await sql()`insert into rounds (id, name, start_ts, end_ts, final, finalized_at) values (${r.id}, ${r.name}, ${sec(r.start)}, ${sec(r.end)}, ${state.final}, ${state.finalizedAt})
              on conflict (id) do nothing`;
  for (const [wallet, d] of Object.entries(state.disqualified)) {
    await sql()`insert into disqualifications (round_id, wallet, reason, at, actor) values (${r.id}, ${wallet}, ${d.reason}, ${d.at}, 'legacy import') on conflict do nothing`;
  }
  console.log(`round ${r.id}: ${Object.keys(state.disqualified).length} disqualified, final=${state.final}`);
}

// Opt-ins.
const optDir = join(LEGACY, "data", "opt-in");
for (const f of existsSync(optDir) ? readdirSync(optDir).filter((f) => f.endsWith(".json")) : []) {
  const roundId = f.replace(/\.json$/, "");
  const list = readJson<{ wallet: string; from: number; at: number; source: string; message?: string; signature?: string; note?: string }[]>(join("data", "opt-in", f));
  for (const o of list) {
    await sql()`insert into opt_ins (round_id, wallet, from_ts, at, source, message, signature, note)
                values (${roundId}, ${o.wallet}, ${o.from}, ${o.at}, ${o.source}, ${o.message ?? null}, ${o.signature ?? null}, ${o.note ?? null})
                on conflict do nothing`;
  }
  console.log(`opt-ins ${roundId}: ${list.length}`);
}

// Pool tokens and prices.
const pools = readJson<Record<string, PoolTokens>>(join("data", "pools.json"));
for (const [id, p] of Object.entries(pools)) {
  await sql()`insert into pool_tokens (pool_id, token0, token1) values (${id}, ${p.token0}, ${p.token1}) on conflict do nothing`;
}
const prices = readJson<Record<string, [number, number][]>>(join("data", "prices.json"));
for (const key of PRICED_KEYS) {
  const rows = prices[key] ?? [];
  for (const part of chunks(rows, 5000)) await dbPriceStore.save(key, part);
  console.log(`prices ${key}: ${rows.length} minutes`);
}

// Cached swaps per round (not the 19 MB preview cache: preview re-pulls itself).
const poolSig = Object.keys(POOLS).sort().join(",");
for (const r of ROUNDS) {
  const file = join("data", `swaps-${r.id}.json`);
  if (!existsSync(join(LEGACY, file))) continue;
  const cache = readJson<{ start: number; end: number; pools: string[]; throughTs: number; swaps: Swap[] }>(file);
  await storeSwapsAndCredits(cache.swaps);
  await sql()`insert into sync_cursors (round_id, start_ts, through_ts, pools) values (${r.id}, ${cache.start}, ${cache.throughTs}, ${poolSig})
              on conflict (round_id) do update set start_ts = excluded.start_ts, through_ts = excluded.through_ts, pools = excluded.pools`;
  console.log(`swaps ${r.id}: ${cache.swaps.length} stored and credited, through ${new Date(cache.throughTs * 1000).toISOString()}`);
}

const [counts] = await sql()`select (select count(*) from swaps)::int as swaps, (select count(*) from tx_credits)::int as txs, (select count(*) from opt_ins)::int as opt_ins`;
console.log(`done: ${JSON.stringify(counts)}`);
