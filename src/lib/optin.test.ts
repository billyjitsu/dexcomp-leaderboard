import { test } from "node:test";
import assert from "node:assert/strict";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { optInMessage, recoverSigner, type RoundInfo } from "./optin.ts";
import { buildLeaderboard } from "./score.ts";
import { PriceBook } from "./prices.ts";
import type { PoolTokens, Swap } from "./types.ts";

// Same signing a wallet does for personal_sign (EIP-191), with a throwaway key.
function personalSign(message: string, key: Uint8Array): string {
  const body = utf8ToBytes(message);
  const hash = keccak_256(new Uint8Array([...utf8ToBytes(`\x19Ethereum Signed Message:\n${body.length}`), ...body]));
  const sig = secp256k1.sign(hash, key, { prehash: false, format: "recovered" }); // [rec, r, s]
  return "0x" + bytesToHex(new Uint8Array([...sig.slice(1), sig[0]! + 27]));
}
function addressOf(key: Uint8Array): string {
  const pub = secp256k1.getPublicKey(key, false);
  return "0x" + bytesToHex(keccak_256(pub.slice(1)).slice(-20));
}

const key = secp256k1.utils.randomSecretKey();
const wallet = addressOf(key);
const round1: RoundInfo = { id: "round-1", name: "Round 1", start: 1_000_000, end: 2_000_000 };
const round2: RoundInfo = { id: "round-2", name: "Round 2", start: 2_000_000, end: 3_000_000 };

test("known web3.js vector recovers the right address", () => {
  const sig = "0xb91467e570a6466aa9e9876cbcd013baba02900b8979d43fe208a4a4f339f5fd6007e74cd82e037b800186422fc2da167c747ef045e5d18a5f5d4300f8e1a0291c";
  assert.equal(recoverSigner("Some data", sig), "0x2c7536e3605d9c16a7a3d7b1898e529396a65c23");
});

test("a wallet's own opt-in signature verifies", () => {
  const msg = optInMessage(round1, wallet, 1_500_000);
  assert.equal(recoverSigner(msg, personalSign(msg, key)), wallet);
});

test("a round 1 signature does not work for round 2 (must opt in again)", () => {
  const sig = personalSign(optInMessage(round1, wallet, 1_500_000), key);
  assert.notEqual(recoverSigner(optInMessage(round2, wallet, 1_500_000), sig), wallet);
});

test("someone else's signature can't opt in your wallet", () => {
  const other = secp256k1.utils.randomSecretKey();
  const msg = optInMessage(round1, wallet, 1_500_000);
  assert.notEqual(recoverSigner(msg, personalSign(msg, other)), wallet);
});

test("malformed signatures are rejected, not thrown", () => {
  assert.equal(recoverSigner("x", "0x1234"), null);
  assert.equal(recoverSigner("x", "0x" + "00".repeat(65)), null);
});

test("only trades after opt-in count; earlier volume is kept as uncounted", () => {
  const USDC = "0x203a662b0bd271a6ed5a60edfbd04bfce608fd36";
  const ETH = "0xee7d8bcfb72bc1880d0cf19822eb0a2e6577ab62";
  const POOL = "0x2a2c512beaa8eb15495726c235472d82effb7a6b";
  const pools = new Map<string, PoolTokens>([[POOL, { token0: USDC, token1: ETH }]]);
  const mk = (id: string, ts: number, who: string): Swap => ({ id, timestamp: ts, origin: who, sender: "0xr", poolId: POOL, txHash: id, amount0: 2000, amount1: -1, amountUSD: 2000 });
  const late = "0x00000000000000000000000000000000000000aa";
  const never = "0x00000000000000000000000000000000000000bb";
  const swaps = [mk("t1", 100, late), mk("t2", 300, late), mk("t3", 300, never)];
  const board = buildLeaderboard({
    swaps, pools, prices: PriceBook.fixed({ eth: 2000 }),
    round: { start: 0, end: 1000, label: "t" }, dataThroughTs: 1000,
    optIn: new Map([[late, { from: 200, source: "signature" as const }]]),
    optInInfo: { roundId: "t", roundName: "T", open: true, closesAt: 1000, joinedWallets: 1 },
    excluded: new Set(),
    roundId: "t",
    status: "live",
  });
  const rowLate = board.rows.find((r) => r.wallet === late)!;
  const rowNever = board.rows.find((r) => r.wallet === never)!;
  assert.equal(rowLate.volumeUsd, 2000); // only t2
  assert.equal(rowLate.uncountedUsd, 2000); // t1 was before opt-in
  assert.equal(rowLate.rank, 1);
  assert.equal(rowNever.volumeUsd, 0);
  assert.equal(rowNever.rank, null);
  assert.ok(rowNever.flags.includes("not-joined"));
  assert.equal(board.totals.volumeUsd, 2000); // competition volume counts opted-in trades only

  // Pool breakdown: both trades were USDC in, ETH out, i.e. buys of ETH in ETH/USDC.
  const pool = rowLate.pools[0]!;
  assert.equal(pool.name, "ETH/USDC");
  assert.equal(pool.allUsd, 4000); // all activity, including the trade before opt-in
  assert.equal(pool.countedUsd, 2000); // only what scores
  assert.equal(pool.buyUsd, 4000);
  assert.equal(pool.sellUsd, 0);
  assert.equal(pool.trades, 2);
});

test("a disqualified wallet loses its rank and prize share; the next wallet moves up", () => {
  const USDC = "0x203a662b0bd271a6ed5a60edfbd04bfce608fd36";
  const ETH = "0xee7d8bcfb72bc1880d0cf19822eb0a2e6577ab62";
  const POOL = "0x2a2c512beaa8eb15495726c235472d82effb7a6b";
  const pools = new Map<string, PoolTokens>([[POOL, { token0: USDC, token1: ETH }]]);
  const a = "0x00000000000000000000000000000000000000a1";
  const b = "0x00000000000000000000000000000000000000b2";
  // a trades $20M (unlocks milestones on its own), b trades $2K.
  const swaps: Swap[] = [
    { id: "x1", timestamp: 10, origin: a, sender: "0xr", poolId: POOL, txHash: "x1", amount0: 20_000_000, amount1: -10_000, amountUSD: 0 },
    { id: "x2", timestamp: 20, origin: b, sender: "0xr", poolId: POOL, txHash: "x2", amount0: 2_000, amount1: -1, amountUSD: 0 },
  ];
  const base = { swaps, pools, prices: PriceBook.fixed({ eth: 2000 }), round: { start: 0, end: 1000, label: "t" }, dataThroughTs: 1000, optIn: null, optInInfo: null, excluded: new Set<string>(), roundId: "t", status: "review" as const };
  const before = buildLeaderboard(base);
  assert.equal(before.rows.find((r) => r.wallet === a)!.rank, 1);
  assert.ok(before.prize.unlockedUsd > 0);

  const after = buildLeaderboard({ ...base, disqualified: new Set([a]) });
  const rowA = after.rows.find((r) => r.wallet === a)!;
  assert.equal(rowA.rank, null);
  assert.equal(rowA.estRewardUsd, 0);
  assert.ok(rowA.flags.includes("disqualified"));
  assert.equal(after.rows.find((r) => r.wallet === b)!.rank, 1);
  assert.equal(after.totals.volumeUsd, 2000); // a's volume no longer counts toward milestones
  assert.equal(after.prize.unlockedUsd, 0);
});
