// One Sushi V3 swap event as returned by the indexer. amount0/amount1 are already
// decimal-adjusted and signed from the pool's view: positive = tokens into the pool.
export interface Swap {
  id: string;
  timestamp: number;
  origin: string;
  sender: string;
  poolId: string;
  txHash: string;
  amount0: number;
  amount1: number;
  amountUSD: number;
}

export interface PoolTokens {
  token0: string;
  token1: string;
}

export interface WalletRow {
  rank: number | null;
  wallet: string;
  volumeUsd: number;
  txs: number;
  offMarketTxs: number;
  feesUsd: number;
  indexerUsd: number;
  firstTs: number;
  lastTs: number;
  flags: string[];
  shareOfPaid: number;
  estRewardUsd: number;
  joined: boolean | null; // null in preview mode (no opt-in)
  joinedFrom: number | null; // trades at or after this count
  joinSource: "signature" | "admin" | null;
  uncountedUsd: number; // volume before opt-in or without one (admin only)
  // Where the volume came from, per pool, over every qualifying trade (admin only).
  pools: { poolId: string; name: string; feeBps: number; countedUsd: number; allUsd: number; trades: number; buyUsd: number; sellUsd: number }[];
}

// What the public page gets: no trade counts, fees, flags or comparison fields.
export interface PublicRow {
  rank: number | null;
  wallet: string;
  volumeUsd: number;
  reward: number;
  joined: boolean | null;
  disqualified: boolean;
}

export interface PublicLeaderboard {
  generatedAt: number;
  round: Leaderboard["round"];
  roundId: string;
  status: Leaderboard["status"];
  dataThroughTs: number;
  totals: { volumeUsd: number; rankedWallets: number };
  prize: Leaderboard["prize"];
  rewardToken: string;
  pools: { name: string; feeBps: number }[];
  rules: Leaderboard["rules"];
  optIn: Leaderboard["optIn"];
  rows: PublicRow[];
}

// What we know about a wallet (known-wallets.ts). Admin only.
export interface WalletLabel {
  label: string;
  note: string | null;
}

export interface Leaderboard {
  // Added by the admin API when it serves a board; not stored in the snapshot.
  labels?: Record<string, WalletLabel>;
  generatedAt: number;
  round: { start: number; end: number; label: string };
  roundId: string; // "preview" when no rounds are configured
  rewardToken: string;
  disqualifiedInfo: Record<string, { reason: string; at: number }>; // admin only
  finalizedAt: number | null;
  status: "preview" | "upcoming" | "live" | "review" | "final";
  // Present only in a round: opt-in is required and stays open until closesAt.
  optIn: { roundId: string; roundName: string; open: boolean; closesAt: number; joinedWallets: number } | null;
  prices: { sources: string[]; maxGapSec: number };
  dataThroughTs: number;
  totals: {
    volumeUsd: number;
    indexerUsd: number;
    txs: number;
    wallets: number;
    rankedWallets: number;
    droppedTxs: number;
  };
  prize: {
    unlockedUsd: number;
    capUsd: number;
    milestones: { volumeUsd: number; poolUsd: number; reached: boolean }[];
    nextMilestone: { volumeUsd: number; poolUsd: number } | null;
  };
  pools: { id: string; name: string; feeBps: number }[];
  // Per-pool totals across all wallets, for reporting (admin only). Built from each
  // wallet's breakdown, so it covers trades at or above RULES.minTxUsd.
  poolStats: {
    poolId: string; name: string; feeBps: number;
    countedUsd: number; allUsd: number; trades: number; traders: number;
    netBuyers: number; netSellers: number; buyUsd: number; sellUsd: number;
  }[];
  rules: { minTxUsd: number; minWalletUsd: number; paidRanks: number };
  rows: WalletRow[];
}

// One transaction in a wallet's admin trade list (admin/trades/<wallet>.json).
export interface TradeRow {
  ts: number;
  tx: string;
  pools: string[]; // e.g. ["ETH/USDC 0.05%"], two entries for a routed trade
  paid: [string, number][]; // [symbol, amount] the wallet gave up
  received: [string, number][]; // [symbol, amount] the wallet got
  usd: number; // credited value at exchange prices
  status: "counted" | "under-min" | "before-opt-in" | "not-joined";
  offMarket: boolean;
}

export interface WalletTrades {
  wallet: string;
  total: number; // all transactions in the window
  trades: TradeRow[]; // newest first, capped
}

// public/rounds/index.json: every round for the dropdown, newest first.
export interface RoundsIndex {
  current: string; // round id shown by default
  rounds: { id: string; name: string; start: number; end: number; status: Leaderboard["status"]; built: boolean }[];
}
