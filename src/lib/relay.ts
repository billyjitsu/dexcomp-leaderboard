// Works out who really traded when a swap was sent by a relayer.
//
// A swap made in the Katana app is two transactions. The trader transfers the input token
// to a one-off deposit account; then a relayer wallet calls the relay entry contract, which
// swaps from that account and sends the output to the trader. The indexer reports the
// relayer as the swap's `origin`, so without this step every app trade is credited to a
// handful of relayer wallets.
//
// For a relayed transaction the trader is, in order:
//   1. funder: the one wallet that supplied the input tokens (it paid the pools itself, or
//      it funded the deposit account that did);
//   2. recipient: otherwise, the one wallet that received the output (covers native ETH
//      in, which leaves no token transfer to trace).
// If neither gives exactly one wallet the transaction is left with its sender and marked
// unresolved. Checked on 72 relayed swaps (22-25 Nov 2026): 63 by funder, 9 by recipient,
// and wherever both applied they agreed.

import { KATANA_RPC_URL, RELAY, RELAY_ENTRIES, RELAY_ROUTERS } from "./config.ts";
import { nowSec, sql } from "./db.ts";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const V3_SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const ZERO = "0x0000000000000000000000000000000000000000";

export interface Log {
  address: string;
  topics: string[];
  data: string;
}

export interface Receipt {
  to: string | null;
  blockNumber: string; // hex
  logs: Log[];
}

const topicAddr = (t: string) => "0x" + t.slice(26).toLowerCase();

// Who put tokens into the pools and who took tokens out, ignoring the pools and routers
// themselves. Pure: works from the receipt's logs alone.
export function tokenFlows(logs: Log[]): { inside: Set<string>; payers: string[]; recipients: string[] } {
  const pools = new Set<string>();
  const inside = new Set<string>([ZERO]);
  for (const l of logs) {
    if (l.topics[0] !== V3_SWAP || l.topics.length < 3) continue;
    pools.add(l.address.toLowerCase());
    inside.add(l.address.toLowerCase());
    inside.add(topicAddr(l.topics[1]!)); // the router that called the pool
  }
  const payers = new Set<string>();
  const largest = new Map<string, { to: string; amount: bigint }>(); // per token
  for (const l of logs) {
    if (l.topics[0] !== TRANSFER || l.topics.length !== 3) continue; // 4 topics = an NFT
    const from = topicAddr(l.topics[1]!);
    const to = topicAddr(l.topics[2]!);
    if (pools.has(to) && !inside.has(from)) payers.add(from);
    if (inside.has(from) && from !== ZERO && !inside.has(to)) {
      const amount = BigInt(l.data === "0x" ? 0 : l.data);
      const token = l.address.toLowerCase();
      const best = largest.get(token);
      // The largest transfer of each token is the trade's output; smaller ones are fees.
      if (!best || amount > best.amount) largest.set(token, { to, amount });
    }
  }
  return { inside, payers: [...payers], recipients: [...new Set([...largest.values()].map((x) => x.to))] };
}

export interface ChainReader {
  isWallet(address: string): Promise<boolean>; // an externally owned account, not a contract
  // Senders of token transfers into `account` in the blocks up to and including `block`.
  fundersOf(account: string, block: number): Promise<string[]>;
}

export type Resolution =
  | { status: "direct" }
  | { status: "resolved"; trader: string; method: "funder" | "recipient" }
  | { status: "unresolved" };

export async function resolveTrader(receipt: Receipt, origin: string, chain: ChainReader): Promise<Resolution> {
  if (!receipt.to || !RELAY_ENTRIES.has(receipt.to.toLowerCase())) return { status: "direct" };
  const { inside, payers, recipients } = tokenFlows(receipt.logs);
  const block = parseInt(receipt.blockNumber, 16);

  const funders = new Set<string>();
  for (const payer of payers) {
    if (await chain.isWallet(payer)) {
      funders.add(payer);
      continue;
    }
    for (const f of await chain.fundersOf(payer, block)) {
      if (!inside.has(f) && f !== payer && f !== origin && (await chain.isWallet(f))) funders.add(f);
    }
  }
  if (funders.size === 1) return { status: "resolved", trader: [...funders][0]!, method: "funder" };

  const receivers: string[] = [];
  for (const r of recipients) if (r !== origin && (await chain.isWallet(r))) receivers.push(r);
  if (receivers.length === 1) return { status: "resolved", trader: receivers[0]!, method: "recipient" };
  return { status: "unresolved" };
}

// ---------------------------------------------------------------------------
// Katana RPC

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    await sleep(RELAY.callGapMs);
    try {
      const res = await fetch(KATANA_RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = (await res.json()) as { result?: T; error?: { message: string } };
      if (body.error) throw new Error(`rpc ${method}: ${body.error.message}`);
      if (body.result === undefined || body.result === null) throw new Error(`rpc ${method}: empty result`);
      return body.result;
    } catch (err) {
      if (attempt >= 4) throw err;
      await sleep(1500 * 2 ** attempt); // rate limits clear within a few seconds
    }
  }
}

export function rpcChainReader(): ChainReader {
  const wallets = new Map<string, boolean>();
  return {
    async isWallet(address) {
      const known = wallets.get(address);
      if (known !== undefined) return known;
      const code = await rpc<string>("eth_getCode", [address, "latest"]);
      // 0xef0100... is an EIP-7702 delegation: still a wallet with a key.
      const is = code === "0x" || code.startsWith("0xef0100");
      wallets.set(address, is);
      return is;
    },
    async fundersOf(account, block) {
      const logs = await rpc<Log[]>("eth_getLogs", [{
        fromBlock: "0x" + Math.max(0, block - RELAY.fundingLookbackBlocks).toString(16),
        toBlock: "0x" + block.toString(16),
        topics: [TRANSFER, null, "0x" + account.slice(2).padStart(64, "0")],
      }]);
      return [...new Set(logs.filter((l) => l.topics.length === 3).map((l) => topicAddr(l.topics[1]!)))];
    },
  };
}

export const fetchReceipt = (txHash: string) => rpc<Receipt>("eth_getTransactionReceipt", [txHash]);

// ---------------------------------------------------------------------------
// Database pass

export interface RelayResult {
  checked: number;
  resolved: number;
  unresolved: number;
  remaining: boolean; // more to check than this refresh had room for
}

// Checks the window's not-yet-checked candidate transactions and moves resolved ones to
// their trader. A candidate went through a relay router, or was sent by a wallet already
// seen relaying. A transaction whose check fails (RPC down) gets no row and is retried.
export async function resolveRelayed(start: number, end: number): Promise<RelayResult> {
  const rows = await sql().query(
    `select s.tx_hash, min(s.origin) as origin
     from swaps s
     where s.ts >= $1 and s.ts < $2
       and (s.sender = any($3::text[]) or s.origin in (select origin from tx_traders where status <> 'direct'))
       and not exists (select 1 from tx_traders t where t.tx_hash = s.tx_hash)
     group by s.tx_hash order by min(s.ts) limit $4`,
    [start, end, RELAY_ROUTERS, RELAY.maxTxsPerRefresh + 1],
  );
  const result: RelayResult = { checked: 0, resolved: 0, unresolved: 0, remaining: rows.length > RELAY.maxTxsPerRefresh };
  if (rows.length === 0) return result;

  const chain = rpcChainReader();
  const deadline = Date.now() + RELAY.maxSecPerRefresh * 1000;
  for (const row of rows.slice(0, RELAY.maxTxsPerRefresh)) {
    if (Date.now() > deadline) {
      result.remaining = true;
      break;
    }
    const txHash = String(row.tx_hash);
    const origin = String(row.origin);
    let r: Resolution;
    try {
      r = await resolveTrader(await fetchReceipt(txHash), origin, chain);
    } catch (err) {
      console.error(`[relay] ${txHash} not checked:`, err);
      result.remaining = true;
      break; // most likely rate-limited; leave the rest for the next refresh
    }
    const trader = r.status === "resolved" ? r.trader : null;
    const method = r.status === "resolved" ? r.method : null;
    await sql().transaction([
      sql()`insert into tx_traders (tx_hash, origin, status, trader, method, checked_at)
            values (${txHash}, ${origin}, ${r.status}, ${trader}, ${method}, ${nowSec()})
            on conflict (tx_hash) do nothing`,
      sql()`update tx_credits set wallet = ${trader ?? origin} where tx_hash = ${txHash}`,
    ]);
    result.checked++;
    if (r.status === "resolved") result.resolved++;
    if (r.status === "unresolved") result.unresolved++;
  }
  if (result.checked) console.log(`[relay] ${JSON.stringify(result)}`);
  return result;
}
