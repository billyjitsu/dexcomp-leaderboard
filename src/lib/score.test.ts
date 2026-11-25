import { test } from "node:test";
import assert from "node:assert/strict";
import { creditTx } from "./score.ts";
import { PriceBook } from "./prices.ts";
import type { PoolTokens, Swap } from "./types.ts";

const USDC = "0x203a662b0bd271a6ed5a60edfbd04bfce608fd36";
const ETH = "0xee7d8bcfb72bc1880d0cf19822eb0a2e6577ab62";
const KAT = "0x7f1f4b4b29f5058fa32cc7a97141b8d7e5abdc2d";
const ETH_USDC = "0x2a2c512beaa8eb15495726c235472d82effb7a6b";
const KAT_USDC = "0x10045367e619caae6f60cc80046c43c6cd55f629";
const KAT_ETH = "0xfe4e52ccf659705141e6fa5dee01432a3e637904";

const pools = new Map<string, PoolTokens>([
  [ETH_USDC, { token0: USDC, token1: ETH }],
  [KAT_USDC, { token0: USDC, token1: KAT }],
  [KAT_ETH, { token0: KAT, token1: ETH }],
]);
const prices = PriceBook.fixed({ eth: 2000, kat: 0.005 });

let n = 0;
function swap(poolId: string, amount0: number, amount1: number, amountUSD = 0): Swap {
  return { id: `s${n++}`, timestamp: 1000, origin: "0xaaaa", sender: "0xrouter", poolId, txHash: "0xtx", amount0, amount1, amountUSD };
}

test("simple buy: USDC in, ETH out, credited once at min(in, out)", () => {
  const c = creditTx([swap(ETH_USDC, 1000, -0.4995)], pools, prices);
  assert.equal(c.creditUsd, 999); // 0.4995 ETH * 2000
});

test("two-pool route ETH -> USDC -> KAT counts once, not twice", () => {
  const c = creditTx([swap(ETH_USDC, -1000, 0.5), swap(KAT_USDC, 1000, -200_000)], pools, prices);
  assert.equal(c.creditUsd, 1000); // USDC nets to zero: $1000 of ETH in, $1000 of KAT out
  assert.equal(c.grossUsd, 2000); // naive sum would double count
  assert.equal(c.offMarket, false);
});

test("circular arbitrage USDC -> ETH -> USDC counts zero", () => {
  const c = creditTx([swap(ETH_USDC, 1000, -0.5), swap(ETH_USDC, -1002, 0.5)], pools, prices);
  assert.equal(c.creditUsd, 0);
});

test("KAT price manipulation cannot inflate credit: overpaid KAT side is ignored", () => {
  // 1M KAT ($5000 at exchange price) dumped for 0.05 ETH ($100). Indexer may report a huge amountUSD.
  const c = creditTx([swap(KAT_ETH, 1_000_000, -0.05, 250_000)], pools, prices);
  assert.equal(c.creditUsd, 100);
  assert.equal(c.indexerUsd, 250_000);
  assert.equal(c.offMarket, true);
});

test("off-market buy against own liquidity is credited at market value, not USDC paid", () => {
  // Pay $10,000 USDC for 20,000 KAT worth $100 at exchange price.
  const c = creditTx([swap(KAT_USDC, 10_000, -20_000)], pools, prices);
  assert.equal(c.creditUsd, 100);
  assert.equal(c.offMarket, true);
});

test("normal slippage is not flagged off-market", () => {
  const c = creditTx([swap(KAT_USDC, 1000, -196_000)], pools, prices); // 2% worse than market
  assert.equal(c.offMarket, false);
  assert.equal(c.creditUsd, 980);
});

test("selling KAT for USDC is valued by the USDC received", () => {
  const c = creditTx([swap(KAT_USDC, -45.5, 9_100)], pools, prices);
  assert.equal(c.creditUsd, 45.5);
});
