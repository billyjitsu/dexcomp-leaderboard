import { INDEXER_URL } from "./config.ts";
import type { PoolTokens, Swap } from "./types.ts";

const PAGE = 1000; // indexer hard cap per query
const ADDRESS = /^0x[0-9a-f]{40}$/;

// Retries with exponential backoff (2s, 4s, 8s), as engineering asked for 429s. The hosted
// endpoint is rate-limited by the Envio plan (floor 100 req/min); we use ~1 per refresh.
async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  let retryAfterMs = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(INDEXER_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status === 429) retryAfterMs = Math.min(60_000, Number(res.headers.get("retry-after") ?? 0) * 1000 || 0);
      if (!res.ok) throw new Error(`indexer HTTP ${res.status}`);
      const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
      if (body.errors?.length) throw new Error(`indexer: ${body.errors.map((e) => e.message).join("; ")}`);
      if (!body.data) throw new Error("indexer: empty response");
      return body.data;
    } catch (err) {
      if (attempt >= 4) throw err;
      await new Promise((r) => setTimeout(r, Math.max(1000 * 2 ** attempt, retryAfterMs)));
      retryAfterMs = 0;
    }
  }
}

function addr(v: unknown, field: string): string {
  const s = String(v).toLowerCase();
  if (!ADDRESS.test(s)) throw new Error(`indexer returned bad ${field}: ${String(v)}`);
  return s;
}

function num(v: unknown, field: string): number {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`indexer returned bad ${field}: ${String(v)}`);
  return n;
}

export async function fetchPoolTokens(poolIds: string[]): Promise<Map<string, PoolTokens>> {
  const data = await gql<{ Pool: { id: string; token0_id: string; token1_id: string }[] }>(
    `query($ids: [String!]!) { Pool(where: {id: {_in: $ids}}) { id token0_id token1_id } }`,
    { ids: poolIds },
  );
  const out = new Map<string, PoolTokens>();
  for (const p of data.Pool) {
    out.set(addr(p.id, "pool id"), { token0: addr(p.token0_id, "token0"), token1: addr(p.token1_id, "token1") });
  }
  return out;
}

interface RawSwap {
  id: string;
  timestamp: string;
  origin: string;
  sender: string;
  pool_id: string;
  transaction_id: string;
  amount0: string;
  amount1: string;
  amountUSD: string;
}

// Pages through swaps in the given pools with fromTs <= timestamp < toTs, ordered by
// (timestamp, id) so the cursor is stable even when many swaps share a second.
// Stops after maxPages. `throughTs` is then the last second that is known to be complete:
// every swap with fromTs <= ts < throughTs is in `swaps` (swaps at the last timestamp of a
// capped pull may be partial, so they are left for the next pull).
export async function fetchSwapsUpTo(
  poolIds: string[],
  fromTs: number,
  toTs: number,
  maxPages: number,
): Promise<{ swaps: Swap[]; throughTs: number }> {
  let pages = 0;
  let lastTs = fromTs;
  let capped = false;
  const swaps = await fetchSwaps(poolIds, fromTs, toTs, (_count, ts) => {
    lastTs = ts;
    if (++pages >= maxPages) {
      capped = true;
      return false;
    }
    return true;
  });
  if (!capped) return { swaps, throughTs: toTs };
  return { swaps: swaps.filter((s) => s.timestamp < lastTs), throughTs: lastTs };
}

export async function fetchSwaps(
  poolIds: string[],
  fromTs: number,
  toTs: number,
  onPage?: (count: number, ts: number) => boolean | void,
): Promise<Swap[]> {
  const query = `query($pools: [String!]!, $ts: numeric!, $id: String!, $end: numeric!) {
    Swap(limit: ${PAGE}, order_by: [{timestamp: asc}, {id: asc}],
         where: {pool_id: {_in: $pools}, timestamp: {_lt: $end},
                 _or: [{timestamp: {_gt: $ts}}, {timestamp: {_eq: $ts}, id: {_gt: $id}}]}) {
      id timestamp origin sender pool_id transaction_id amount0 amount1 amountUSD
    }
  }`;
  const out: Swap[] = [];
  let ts = fromTs - 1;
  let id = "";
  for (;;) {
    const data = await gql<{ Swap: RawSwap[] }>(query, { pools: poolIds, ts, id, end: toTs });
    for (const s of data.Swap) {
      out.push({
        id: String(s.id),
        timestamp: num(s.timestamp, "timestamp"),
        origin: addr(s.origin, "origin"),
        sender: addr(s.sender, "sender"),
        poolId: addr(s.pool_id, "pool_id"),
        txHash: String(s.transaction_id).toLowerCase(),
        amount0: num(s.amount0, "amount0"),
        amount1: num(s.amount1, "amount1"),
        amountUSD: num(s.amountUSD, "amountUSD"),
      });
    }
    const last = data.Swap.at(-1);
    if (!last || data.Swap.length < PAGE) return out;
    if (onPage?.(out.length, Number(last.timestamp)) === false) return out;
    ts = Number(last.timestamp);
    id = last.id;
  }
}
