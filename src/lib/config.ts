// Competition rules. Values marked PROPOSED are still open questions for engineering
// (see marketing/campaigns/spot-dex-comp-eng-questions.md). Prize ladder defaults
// come from ../dex-comp-sim.html (tiered ladder, $15K cap).
//
// Rounds are no longer listed here: they live in the `rounds` table and are created on
// /admin. With no rounds, the site runs in preview mode (last 14 days, every wallet).

export const INDEXER_URL = "https://indexer.hyperindex.xyz/e92f230/v1/graphql";
// Exchange market data. api.binance.com is geo-blocked in the US; the data-api mirror is not.
export const BINANCE_API = "https://data-api.binance.vision";
export const COINBASE_API = "https://api.exchange.coinbase.com";

export type PriceKey = "usd" | "eth" | "btc" | "kat";

export interface TokenInfo {
  symbol: string;
  // How the token is valued. Prices always come from exchanges, never from the Katana
  // pools, because thin pools can be pushed (question 12). null = unpriced.
  price: PriceKey | null;
}

// Keys are lowercase token addresses on Katana (chain 747474).
export const TOKENS: Record<string, TokenInfo> = {
  "0x203a662b0bd271a6ed5a60edfbd04bfce608fd36": { symbol: "USDC", price: "usd" },
  "0xee7d8bcfb72bc1880d0cf19822eb0a2e6577ab62": { symbol: "ETH", price: "eth" },
  "0x0913da6da4b42f538b445599b46bb4622342cf52": { symbol: "WBTC", price: "btc" },
  "0x7f1f4b4b29f5058fa32cc7a97141b8d7e5abdc2d": { symbol: "KAT", price: "kat" },
};

// One-minute candles. USDT pairs on Binance are treated as USD.
export const PRICE_SYMBOLS: Record<Exclude<PriceKey, "usd">, { binance: string; coinbase: string }> = {
  eth: { binance: "ETHUSDT", coinbase: "ETH-USD" },
  btc: { binance: "BTCUSDT", coinbase: "BTC-USD" },
  kat: { binance: "KATUSDT", coinbase: "KAT-USD" },
};

export interface PoolInfo {
  name: string;
  feeBps: number;
}

// Eligible competition pools: the non-stable pools from the economics sim.
export const POOLS: Record<string, PoolInfo> = {
  "0x2a2c512beaa8eb15495726c235472d82effb7a6b": { name: "ETH/USDC", feeBps: 5 },
  "0x10045367e619caae6f60cc80046c43c6cd55f629": { name: "KAT/USDC", feeBps: 5 },
  "0x744676b3ced942d78f9b8e9cd22246db5c32395c": { name: "WBTC/USDC", feeBps: 5 },
  "0xfe4e52ccf659705141e6fa5dee01432a3e637904": { name: "KAT/ETH", feeBps: 5 },
  "0x8d6daef922532571e33924dccc5aa09edd9eef77": { name: "WBTC/ETH", feeBps: 30 },
  "0x105f833d8522f33d8dc3e9599455e9412b63d049": { name: "ETH/USDC", feeBps: 30 },
  "0x4488005fd5eea2e22a80cb2a0e820ed6066e687f": { name: "WBTC/USDC", feeBps: 30 },
  "0x6d8a30f4b2501de8f0b443cb11eb512f12d5355f": { name: "KAT/USDC", feeBps: 30 },
  // PROPOSED exclusion (question 17): ~$8K TVL and a 1 bp fee make it the cheapest place to wash.
  // "0x136e82d68b61bcf76334c6227f53e43b8f79b3e8": { name: "ETH/USDC", feeBps: 1 },
};

export const RULES = {
  minTxUsd: 10, // PROPOSED: a transaction must be worth $10 to count (question 18)
  minWalletUsd: 1_000, // PROPOSED: $1,000 total to appear on the leaderboard
  paidRanks: 50, // top 50 split the unlocked pool pro rata
  // A hop whose two legs differ by more than this at exchange prices traded off-market.
  // Credit already uses the smaller leg, so this only flags the wallet for review.
  offMarket: { maxDeviation: 0.03, minHopUsd: 100 },
  // Heuristic flags. Informational only: humans decide exclusions (question 27).
  flags: {
    highFrequencyTxPerDay: 150,
    farmingMinTxs: 200,
    farmingMedianTxUsd: 25,
  },
};

// Tiered milestone ladder from the sim defaults: first milestone at $10M unlocks $5,500,
// then +$2,750 every $5M, capped at $15,000.
export const MILESTONES: { volumeUsd: number; poolUsd: number }[] = [
  { volumeUsd: 10_000_000, poolUsd: 5_500 },
  { volumeUsd: 15_000_000, poolUsd: 8_250 },
  { volumeUsd: 20_000_000, poolUsd: 11_000 },
  { volumeUsd: 25_000_000, poolUsd: 13_750 },
  { volumeUsd: 30_000_000, poolUsd: 15_000 },
];

// PROPOSED payout token (question 30). Rewards are computed in USD and shown 1:1 in this token.
export const REWARD_TOKEN = "vbUSDC";

// Wallets never ranked: market makers, protocol-owned, team. Lowercase.
export const EXCLUDED_WALLETS = new Set<string>([]);

export const OPT_IN_TERMS = "v1"; // bump when the competition terms change; it is in the signed text
export const OPT_IN_MAX_SKEW_SEC = 600; // a signed message must be used within 10 minutes

// How far behind real time to read. The indexer runs ~14s behind the chain.
export const INDEXER_LAG_SEC = 30;
// Seconds of overlap when resuming a pull, so late-indexed swaps are not missed.
export const RESUME_OVERLAP_SEC = 300;

// Refresh policy. A page view rebuilds a live board when its snapshot is older than
// REFRESH_SEC (one refresh at a time, shared across all visitors), so indexer load stays at
// most one query a minute no matter how many people are watching.
export const REFRESH_SEC = 60;
// Indexer pages (1,000 swaps each) pulled per refresh. A long backfill finishes over
// several refreshes instead of running past the function time limit.
export const MAX_PAGES_PER_REFRESH = 60;
export const PREVIEW_DAYS = 14;
