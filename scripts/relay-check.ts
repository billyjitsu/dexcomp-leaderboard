// Dry run of relay attribution against live data. Reads the indexer and the Katana RPC,
// writes nothing.   node scripts/relay-check.ts <startTs> [endTs]
import { INDEXER_URL, RELAY_ROUTERS } from "../src/lib/config.ts";
import { fetchReceipt, resolveTrader, rpcChainReader } from "../src/lib/relay.ts";

const start = Number(process.argv[2]);
const end = Number(process.argv[3] ?? Math.floor(Date.now() / 1000));
if (!Number.isFinite(start)) throw new Error("usage: node scripts/relay-check.ts <startTs> [endTs]");

const res = await fetch(INDEXER_URL, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    query: `query($s: [String!]!, $a: numeric!, $b: numeric!) {
      Swap(limit: 1000, order_by: [{timestamp: asc}, {id: asc}], where: {sender: {_in: $s}, timestamp: {_gte: $a, _lt: $b}}) { timestamp origin transaction_id }
    }`,
    variables: { s: RELAY_ROUTERS, a: start, b: end },
  }),
});
const swaps = ((await res.json()) as { data: { Swap: { timestamp: string; origin: string; transaction_id: string }[] } }).data.Swap;
const txs = [...new Map(swaps.map((s) => [s.transaction_id, s])).values()];
console.log(`${swaps.length} swaps in ${txs.length} transactions through the relay routers${swaps.length === 1000 ? " (first 1000 only)" : ""}`);

const chain = rpcChainReader();
const tally: Record<string, number> = {};
for (const t of txs) {
  const r = await resolveTrader(await fetchReceipt(t.transaction_id), t.origin.toLowerCase(), chain);
  const key = r.status === "resolved" ? `resolved by ${r.method}` : r.status;
  tally[key] = (tally[key] ?? 0) + 1;
  if (r.status !== "direct") console.log(`${new Date(Number(t.timestamp) * 1000).toISOString().slice(0, 16)} ${t.transaction_id} sent by ${t.origin.slice(0, 10)} -> ${r.status === "resolved" ? `${r.trader} (${r.method})` : "UNRESOLVED"}`);
}
console.log(tally);
