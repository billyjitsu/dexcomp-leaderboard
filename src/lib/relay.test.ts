import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveTrader, tokenFlows, type ChainReader, type Log, type Receipt } from "./relay.ts";

// Logs of a real app swap (500 USDC to WBTC, sent by a relayer on behalf of TRADER), with the
// trader, its deposit account and the transaction hash replaced by placeholders.
const fx = JSON.parse(readFileSync(new URL("./relay.fixture.json", import.meta.url), "utf8")) as Receipt & { origin: string };
const TRADER = "0x1111111111111111111111111111111111111111";
const DEPOSIT = "0x2222222222222222222222222222222222222222";
const RELAYER = "0x7b9d8e549ddbe2c88f2233e37cb4f4339bb1e252";
const ENTRY = "0x0000000000006ac72ed1d192fa28f0058d3f8806";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const pad = (a: string) => "0x" + a.slice(2).padStart(64, "0");
const hex = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const transfer = (token: string, from: string, to: string, amount: number): Log => ({ address: token, topics: [TRANSFER, pad(from), pad(to)], data: hex(amount) });
const swap = (pool: string, router: string): Log => ({ address: pool, topics: [SWAP, pad(router), pad(router)], data: "0x" });

function chain(wallets: string[], funders: Record<string, string[]> = {}): ChainReader {
  return { isWallet: async (a) => wallets.includes(a), fundersOf: async (a) => funders[a] ?? [] };
}

const A = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const [POOL, ROUTER, USDC, ETH, ACCOUNT, ALICE, BOB, FEES] = [A(1), A(2), A(3), A(4), A(5), A(6), A(7), A(8)] as [string, string, string, string, string, string, string, string];
const relayed = (logs: Log[]): Receipt => ({ to: ENTRY, blockNumber: "0x10", logs });

test("real app swap: flows find the deposit account and the trader", () => {
  const f = tokenFlows(fx.logs);
  assert.deepEqual(f.payers, [DEPOSIT]);
  assert.deepEqual(f.recipients, [TRADER]);
});

test("real app swap: credited to the wallet that funded the deposit account", async () => {
  const r = await resolveTrader(fx, fx.origin.toLowerCase(), chain([TRADER, RELAYER], { [DEPOSIT]: [TRADER] }));
  assert.deepEqual(r, { status: "resolved", trader: TRADER, method: "funder" });
});

test("a transaction that does not go to the relay entry is left alone", async () => {
  const r = await resolveTrader({ ...fx, to: ROUTER }, RELAYER, chain([TRADER]));
  assert.deepEqual(r, { status: "direct" });
});

test("no token funding to trace (native ETH in): falls back to the output recipient", async () => {
  const logs = [transfer(ETH, ROUTER, POOL, 5), swap(POOL, ROUTER), transfer(USDC, POOL, ROUTER, 1000), transfer(USDC, ROUTER, FEES, 3), transfer(USDC, ROUTER, ALICE, 997)];
  const r = await resolveTrader(relayed(logs), RELAYER, chain([ALICE, FEES]));
  assert.deepEqual(r, { status: "resolved", trader: ALICE, method: "recipient" });
});

test("funder wins when the output goes somewhere else (burned or bridged)", async () => {
  const logs = [transfer(USDC, ACCOUNT, POOL, 1000), swap(POOL, ROUTER), transfer(ETH, POOL, ROUTER, 5), transfer(ETH, ROUTER, "0x0000000000000000000000000000000000000000", 5)];
  const r = await resolveTrader(relayed(logs), RELAYER, chain([ALICE], { [ACCOUNT]: [ALICE] }));
  assert.deepEqual(r, { status: "resolved", trader: ALICE, method: "funder" });
});

test("two wallets funded the account and none received: unresolved", async () => {
  const logs = [transfer(USDC, ACCOUNT, POOL, 1000), swap(POOL, ROUTER), transfer(ETH, POOL, ROUTER, 5), transfer(ETH, ROUTER, ACCOUNT, 5)];
  const r = await resolveTrader(relayed(logs), RELAYER, chain([ALICE, BOB], { [ACCOUNT]: [ALICE, BOB] }));
  assert.deepEqual(r, { status: "unresolved" });
});

test("the relayer itself is never the trader", async () => {
  const logs = [transfer(USDC, ACCOUNT, POOL, 1000), swap(POOL, ROUTER), transfer(ETH, POOL, ROUTER, 5), transfer(ETH, ROUTER, RELAYER, 5)];
  const r = await resolveTrader(relayed(logs), RELAYER, chain([RELAYER], { [ACCOUNT]: [RELAYER] }));
  assert.deepEqual(r, { status: "unresolved" });
});
