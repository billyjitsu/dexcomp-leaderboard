import type { Leaderboard, PublicLeaderboard, PublicRow, RoundsIndex, TradeRow, WalletRow, WalletTrades } from "@/lib/types";

// One script drives both pages: the public board (/) and the admin view (/admin) with
// trades, fees, flags and round management. It renders with DOM methods and textContent
// only, never innerHTML with data. Started once by <Board> (board.tsx).
let ADMIN = false;
// Every board is per round; the dropdown picks which round is shown.
const INDEX_URL = "/api/rounds";
const dataUrl = (roundId: string) => (ADMIN ? `/api/admin/rounds/${roundId}` : `/api/rounds/${roundId}`);
let roundsIndex: RoundsIndex | null = null;
let selectedRound = ""; // round id; "" until the index loads
const EXPLORER = "https://katanascan.com/address/";
const REFRESH_MS = 60_000; // the build refreshes the JSON at most once a minute

const FLAG_TEXT: Record<string, { label: string; tone: string; title: string }> = {
  "high-frequency": { label: "Bot?", tone: "tag-warn", title: "Very high trade count per day. Review before payout." },
  "small-repeat": { label: "Farm?", tone: "tag-warn", title: "Hundreds of tiny trades. Looks like quest farming." },
  circular: { label: "Arb", tone: "tag-warn", title: "Most routed volume nets out (circular trades). Credited at net flow only." },
  "off-market": { label: "Off-market", tone: "tag-bad", title: "Traded far from exchange prices. Credited at market value only." },
  "not-joined": { label: "Not joined", tone: "", title: "Traded this round but hasn't opted in. Its volume isn't counted." },
  disqualified: { label: "Disqualified", tone: "tag-bad", title: "Disqualified by an admin. Not ranked; volume doesn't count." },
  excluded: { label: "Excluded", tone: "tag-bad", title: "Market maker, protocol or team wallet. Not ranked." },
};

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, opts: { cls?: string; text?: string; title?: string } = {}, ...kids: Node[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (opts.cls) e.className = opts.cls;
  if (opts.text !== undefined) e.textContent = opts.text;
  if (opts.title) e.title = opts.title;
  e.append(...kids);
  return e;
}

const usd = (n: number, digits = 0) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: digits, minimumFractionDigits: digits });
const compact = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: n >= 1e6 ? 2 : 1 });
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

type Board = PublicLeaderboard | Leaderboard;
let board: Board | null = null;
let showAll = false;
let account: string | null = null; // connected wallet, lowercase
let myRow: PublicRow | null = null; // connected wallet's own place, from me/<address>.json

async function fetchMine(): Promise<void> {
  const addr = account;
  if (!addr) {
    myRow = null;
    return;
  }
  try {
    const res = await fetch(`/api/me/${selectedRound}/${addr}`, { cache: "no-store" });
    const row = res.ok ? ((await res.json()) as PublicRow) : null;
    myRow = row?.wallet === addr ? row : null; // 404 = no trades this round
  } catch {
    myRow = null;
  }
  if (addr === account) renderRows();
}

const isAdminBoard = (b: Board): b is Leaderboard => ADMIN && "txs" in b.totals;

function walletLink(wallet: string): HTMLAnchorElement {
  const a = el("a", { text: short(wallet), title: wallet });
  a.href = EXPLORER + wallet;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

function rankBadge(rank: number | null): HTMLElement {
  const medal = rank === 1 ? " gold" : rank === 2 ? " silver" : rank === 3 ? " bronze" : "";
  return el("span", { cls: `rank${medal}`, text: rank === null ? "–" : String(rank) });
}

function renderHero(b: Board): void {
  $("prize-unlocked").replaceChildren(document.createTextNode(usd(b.prize.unlockedUsd)), el("small", { text: ` / ${usd(b.prize.capUsd)}` }));
  $("round-label").textContent = b.round.label;
  const next = b.prize.nextMilestone;
  $("next-text").textContent = next
    ? `${compact(next.volumeUsd - b.totals.volumeUsd)} more volume unlocks ${usd(next.poolUsd)}`
    : "All milestones unlocked";

  const max = b.prize.milestones.at(-1)?.volumeUsd ?? 1;
  const bar = $("progress");
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", String(max));
  bar.setAttribute("aria-valuenow", String(Math.round(b.totals.volumeUsd)));
  $("progress-fill").style.width = `${Math.min(100, (b.totals.volumeUsd / max) * 100)}%`;
  bar.querySelectorAll(".tick, .tick-label").forEach((n) => n.remove());
  b.prize.milestones.forEach((m, i, all) => {
    const left = `${(m.volumeUsd / max) * 100}%`;
    const tick = el("div", { cls: `tick${m.reached ? " reached" : ""}` });
    tick.style.left = left;
    const cls = `tick-label${m.reached ? " reached" : ""}${i === all.length - 1 ? " last" : ""}`;
    const label = el("div", { cls, text: compact(m.volumeUsd) }, el("span", { cls: "pool", text: ` · ${compact(m.poolUsd)}` }));
    label.style.left = left;
    bar.append(tick, label);
  });

  $("s-volume").textContent = usd(b.totals.volumeUsd);
  $("s-ranked").textContent = b.totals.rankedWallets.toLocaleString("en-US");
  $("s-paid").textContent = isAdminBoard(b) ? b.totals.txs.toLocaleString("en-US") : `Top ${b.rules.paidRanks}`;

  const tag = $("mode-tag");
  const STATUS_TAG: Record<Board["status"], [string, string]> = {
    preview: ["Preview · all wallets", "tag-warn"],
    upcoming: [b.optIn ? "Opens soon · opt-in" : "Opens soon · all wallets", "tag-ok"],
    live: [b.optIn ? "Live · opt-in" : "Live · all wallets", "tag-ok"],
    review: ["Ended · under review", "tag-warn"],
    final: ["Final results", "tag-ok"],
  };
  const [text, tone] = STATUS_TAG[b.status] ?? STATUS_TAG.preview;
  tag.className = `tag ${tone}`;
  tag.textContent = text;
  tag.hidden = false;
}

function publicRow(b: PublicLeaderboard, r: PublicRow): HTMLTableRowElement {
  const reward = r.disqualified ? "Disqualified"
    : r.joined === false ? "Not joined"
    : r.reward > 0 ? `${r.reward.toLocaleString("en-US")} ${b.rewardToken}`
    : r.rank === null ? `Needs ${usd(b.rules.minWalletUsd)}` : "–";
  return el(
    "tr",
    {},
    el("td", {}, rankBadge(r.rank)),
    el("td", { cls: "left wallet" }, walletLink(r.wallet)),
    el("td", { cls: "left", text: usd(r.volumeUsd, 2) }),
    el("td", { cls: r.reward > 0 ? "" : "muted", text: reward }),
  );
}

// What we know about a wallet, under its address: bot, farm or app relayer (known-wallets.ts).
// A note for admins only; it never affects ranking.
function labelCell(wallet: string): Node {
  const known = board && isAdminBoard(board) ? board.labels?.[wallet] : undefined;
  if (!known) return document.createTextNode("");
  return el("span", { cls: "wlabel", text: known.label, title: known.note ?? "" });
}

function adminRow(r: WalletRow): HTMLTableRowElement {
  const flags = el("span", { cls: "flags" });
  for (const f of r.flags) {
    const t = FLAG_TEXT[f];
    if (t) flags.append(el("span", { cls: `tag ${t.tone}`, text: t.label, title: t.title }));
  }
  return el(
    "tr",
    {},
    el("td", {}, rankBadge(r.rank)),
    el("td", { cls: "left wallet" }, expandToggle(r.wallet), walletLink(r.wallet), labelCell(r.wallet)),
    el("td", { text: usd(r.volumeUsd) }),
    el("td", { text: r.txs.toLocaleString("en-US") }),
    el("td", { cls: "muted", text: usd(r.feesUsd) }),
    el("td", { cls: "muted", text: usd(r.indexerUsd) }),
    el("td", { cls: "muted", text: r.shareOfPaid ? `${(r.shareOfPaid * 100).toFixed(1)}%` : "–" }),
    el("td", { cls: r.estRewardUsd ? "" : "muted", text: r.estRewardUsd ? usd(r.estRewardUsd) : "–" }),
    joinCell(r),
    el("td", { cls: "muted", text: r.uncountedUsd > 0 ? usd(r.uncountedUsd) : "–" }),
    el("td", { cls: "left" }, flags, dqControls(r)),
  );
}

function dqControls(r: WalletRow): HTMLElement {
  const box = el("span");
  const b = board && isAdminBoard(board) ? board : null;
  if (!b || b.status === "preview") return box;
  const info = b.disqualifiedInfo[r.wallet];
  if (info) box.append(el("span", { cls: "dq-reason", text: `${info.reason} (${when(info.at)})` }));
  if (b.status === "final") return box;
  box.append(
    info
      ? roundButton("Reinstate", { action: "reinstate", wallet: r.wallet })
      : roundButton("Disqualify", { action: "disqualify", wallet: r.wallet }, true),
  );
  return box;
}

function roundButton(label: string, body: Record<string, string>, danger = false): HTMLButtonElement {
  const btn = el("button", { cls: `btn-xs${danger ? " danger" : ""}`, text: label });
  btn.type = "button";
  btn.addEventListener("click", () => void roundAction(body, btn));
  return btn;
}

// The name typed on the admin page, sent with each action for the activity log.
const NAME_KEY = "spotcomp.adminName";
function adminName(): string {
  return $<HTMLInputElement>("admin-name").value.trim().slice(0, 40);
}

// Admin writes: same-origin JSON plus a custom header (the server's CSRF check).
async function adminPost<T = { ok?: boolean }>(url: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-request": "1", "x-admin-actor": encodeURIComponent(adminName()) },
    body: JSON.stringify(body),
  });
  const out = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
  return out;
}

// Round lifecycle and disqualification.
async function roundAction(body: Record<string, string>, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  const reason = $<HTMLInputElement>("admin-note").value.trim();
  try {
    await adminPost("/api/admin/round", { ...body, roundId: selectedRound, reason });
    $("footnote").textContent = `${body["action"]} done. Rebuilding ${selectedRound}, refreshing in a few seconds...`;
    setTimeout(() => void reloadAdmin(), 6000);
  } catch (err) {
    $("footnote").textContent = `Admin action failed: ${String((err as Error).message)}`;
    btn.disabled = false;
  }
}

function renderRoundAdmin(b: Leaderboard): void {
  const dq = Object.keys(b.disqualifiedInfo).length;
  const TEXT: Record<Leaderboard["status"], string> = {
    preview: "Preview mode: no rounds yet, so every wallet counts. Create a round below to run a competition.",
    upcoming: "Not started yet. Wallets can opt in now.",
    live: "Live. Results update every minute.",
    review: "Ended and under review. Disqualify or add late opt-ins as needed, then Finalize to lock results for payout.",
    final: `Final since ${b.finalizedAt ? when(b.finalizedAt) : "?"}. Results are locked. Reopen only to correct a mistake.`,
  };
  $("round-admin-text").textContent = `${TEXT[b.status]}${dq ? ` ${dq} disqualified.` : ""}`;
  $("round-finalize").hidden = b.status !== "review";
  $("round-reopen").hidden = b.status !== "final";
}

// Payout list: paid places with their reward, for the payout team.
function downloadPayoutCsv(b: Leaderboard): void {
  const paid = b.rows.filter((r) => r.rank !== null && r.rank <= b.rules.paidRanks);
  const lines = [["rank", "wallet", "volume_usd", "reward", "token", "status"].join(",")];
  for (const r of paid) lines.push([r.rank, r.wallet, r.volumeUsd.toFixed(2), Math.floor(r.estRewardUsd), b.rewardToken, b.status].join(","));
  const a = el("a");
  a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
  a.download = `payout-${b.roundId}-${b.status}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------------------------------------------------------------------------
// Admin: per-wallet pool breakdown (click the arrow next to a wallet).

const expanded = new Set<string>();

function expandToggle(wallet: string): HTMLButtonElement {
  const open = expanded.has(wallet);
  const b = el("button", { cls: "expand", text: open ? "▾" : "▸", title: open ? "Hide pool breakdown" : "Show pool breakdown" });
  b.type = "button";
  b.setAttribute("aria-expanded", String(open));
  b.addEventListener("click", () => {
    if (expanded.has(wallet)) expanded.delete(wallet);
    else expanded.add(wallet);
    renderRows();
  });
  return b;
}

const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "–");

function detailRow(r: WalletRow): HTMLTableRowElement {
  const all = r.pools.reduce((a, p) => a + p.allUsd, 0);
  const buys = r.pools.reduce((a, p) => a + p.buyUsd, 0);
  const top = r.pools[0];
  const summary = top
    ? `Mostly ${top.name} ${top.feeBps / 100}% (${pct(top.allUsd, all)} of activity) · ${pct(buys, all)} buys / ${pct(all - buys, all)} sells`
    : "No qualifying trades in competition pools.";

  const head = el("tr", {}, ...["Pool", "Counted", "All activity", "Share", "Trades", "Buys", "Sells", "Buy / sell"].map((h, i) => el("th", { cls: i === 0 || i === 7 ? "left" : "", text: h })));
  const body = r.pools.map((p) => {
    const bar = el("div", { cls: "split", title: `${pct(p.buyUsd, p.allUsd)} buys` }, el("span", { cls: "split-buy" }));
    (bar.firstChild as HTMLElement).style.width = pct(p.buyUsd, p.allUsd) === "–" ? "0" : pct(p.buyUsd, p.allUsd);
    return el(
      "tr",
      {},
      el("td", { cls: "left", text: `${p.name} · ${p.feeBps / 100}%` }),
      el("td", { text: usd(p.countedUsd) }),
      el("td", { cls: "muted", text: usd(p.allUsd) }),
      el("td", { cls: "muted", text: pct(p.allUsd, all) }),
      el("td", { text: p.trades.toLocaleString("en-US") }),
      el("td", { cls: "buy", text: usd(p.buyUsd) }),
      el("td", { cls: "sell", text: usd(p.sellUsd) }),
      el("td", { cls: "left" }, bar),
    );
  });
  const inner = el("div", { cls: "detail" }, el("p", { cls: "detail-summary", text: summary }));
  if (body.length) inner.append(el("table", { cls: "pool-table" }, el("thead", {}, head), el("tbody", {}, ...body)));
  inner.append(el("p", { cls: "detail-note", text: "Buys = trader received the pool's first token (ETH, KAT or WBTC). All activity includes trades before opt-in; Counted is what scores." }));
  inner.append(tradeList(r.wallet));
  const td = Object.assign(el("td", {}, inner), { colSpan: 11 });
  return el("tr", { cls: "detail-row" }, td);
}

// ---------------------------------------------------------------------------
// Admin: per-pool totals across all wallets, for campaign reporting.

type PoolStat = Leaderboard["poolStats"][number];

function poolTotals(stats: PoolStat[]): PoolStat {
  const t: PoolStat = { poolId: "", name: "All pools", feeBps: 0, countedUsd: 0, allUsd: 0, trades: 0, traders: 0, netBuyers: 0, netSellers: 0, buyUsd: 0, sellUsd: 0 };
  for (const p of stats) {
    t.countedUsd += p.countedUsd;
    t.allUsd += p.allUsd;
    t.trades += p.trades;
    t.buyUsd += p.buyUsd;
    t.sellUsd += p.sellUsd;
  }
  return t;
}

function renderPoolReport(b: Leaderboard): void {
  const all = b.poolStats.reduce((a, p) => a + p.allUsd, 0);
  const uniqueTraders = b.rows.filter((r) => r.pools.length > 0).length;
  const line = (p: PoolStat, total = false) => {
    const net = p.buyUsd - p.sellUsd;
    const tr = el(
      "tr",
      {},
      el("td", { cls: "left", text: total ? p.name : `${p.name} · ${p.feeBps / 100}%` }),
      el("td", { text: usd(p.countedUsd) }),
      el("td", { cls: "muted", text: usd(p.allUsd) }),
      el("td", { cls: "muted", text: pct(p.allUsd, all) }),
      el("td", { text: p.trades.toLocaleString("en-US") }),
      el("td", { text: total ? uniqueTraders.toLocaleString("en-US") : p.traders.toLocaleString("en-US") }),
      el("td", { text: total ? "–" : p.netBuyers.toLocaleString("en-US") }),
      el("td", { text: total ? "–" : p.netSellers.toLocaleString("en-US") }),
      el("td", { cls: "muted", text: usd(p.buyUsd) }),
      el("td", { cls: "muted", text: usd(p.sellUsd) }),
      el("td", { cls: net > 0 ? "pos" : net < 0 ? "neg" : "muted", text: `${net > 0 ? "+" : ""}${usd(net)}` }),
    );
    if (total) tr.classList.add("total");
    return tr;
  };
  $("pool-report").replaceChildren(...b.poolStats.map((p) => line(p)), line(poolTotals(b.poolStats), true));
  $("pool-report-note").textContent =
    `${b.round.label}. Trades of ${usd(b.rules.minTxUsd)}+ in competition pools. Net flow = buys minus sells of the pool's first token (ETH, KAT or WBTC); ` +
    "positive means traders bought more than they sold. Net buyers/sellers count wallets by their own net flow in that pool. " +
    "Counted is what scores (opted-in, after opt-in); All activity includes everyone.";
}

// CSV for reports. Cells that start with = + - @ are prefixed so spreadsheets don't run them.
function downloadPoolCsv(b: Leaderboard): void {
  const cell = (v: string | number) => {
    const s = String(v);
    const safe = /^[=+\-@]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const header = ["pool", "fee_pct", "counted_usd", "all_activity_usd", "trades", "traders", "net_buyers", "net_sellers", "buy_usd", "sell_usd", "net_flow_usd"];
  const rows = b.poolStats.map((p) => [p.name, p.feeBps / 100, p.countedUsd.toFixed(2), p.allUsd.toFixed(2), p.trades, p.traders, p.netBuyers, p.netSellers, p.buyUsd.toFixed(2), p.sellUsd.toFixed(2), (p.buyUsd - p.sellUsd).toFixed(2)]);
  const csv = [header, ...rows].map((r) => r.map(cell).join(",")).join("\n");
  const a = el("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `pool-activity-${new Date(b.generatedAt * 1000).toISOString().slice(0, 10)}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------------------------------------------------------------------------
// Admin: a wallet's individual trades (loaded from /admin/trades/<wallet>.json on expand).

const TX_EXPLORER = "https://katanascan.com/tx/";
const PAGE = 25;
const tradeCache = new Map<string, { gen: number; data: WalletTrades | null }>();
const tradesShown = new Map<string, number>();

const STATUS_TEXT: Record<TradeRow["status"], { label: string; tone: string }> = {
  counted: { label: "Counted", tone: "tag-ok" },
  "under-min": { label: "Under min", tone: "" },
  "before-opt-in": { label: "Before opt-in", tone: "tag-warn" },
  "not-joined": { label: "Not joined", tone: "" },
};

const amount = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 0 : n >= 1 ? 4 : 6 });
const legs = (xs: [string, number][]) => xs.map(([sym, n]) => `${amount(n)} ${sym}`).join(" + ") || "–";

async function loadTrades(wallet: string, gen: number): Promise<void> {
  try {
    const res = await fetch(`/api/admin/trades/${selectedRound}/${wallet}`, { cache: "no-store" });
    tradeCache.set(wallet, { gen, data: res.ok ? ((await res.json()) as WalletTrades) : null });
  } catch {
    tradeCache.set(wallet, { gen, data: null });
  }
  renderRows();
}

function tradeList(wallet: string): HTMLElement {
  const box = el("div", { cls: "trades" }, el("p", { cls: "detail-summary", text: "Trades" }));
  const gen = board?.generatedAt ?? 0;
  const cached = tradeCache.get(wallet);
  if (!cached || cached.gen !== gen) {
    if (!cached) box.append(el("p", { cls: "detail-note", text: "Loading trades..." }));
    void loadTrades(wallet, gen);
    if (!cached) return box;
  }
  const data = tradeCache.get(wallet)?.data;
  if (!data || data.trades.length === 0) {
    box.append(el("p", { cls: "detail-note", text: "No trades in competition pools in this window." }));
    return box;
  }
  const n = Math.min(tradesShown.get(wallet) ?? PAGE, data.trades.length);
  const head = el("tr", {}, ...["Time", "Pools", "Paid", "Received", "Value", "Status", "Tx"].map((h, i) => el("th", { cls: i < 4 || i === 5 ? "left" : "", text: h })));
  const rows = data.trades.slice(0, n).map((t) => {
    const status = STATUS_TEXT[t.status];
    const tags = el("span", { cls: "flags" }, el("span", { cls: `tag ${status.tone}`, text: status.label }));
    if (t.offMarket) tags.append(el("span", { cls: "tag tag-bad", text: "Off-market", title: "Traded far from exchange prices. Credited at market value only." }));
    const link = el("a", { text: `${t.tx.slice(0, 8)}…`, title: t.tx });
    link.href = TX_EXPLORER + t.tx;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    return el(
      "tr",
      {},
      el("td", { cls: "left muted", text: new Date(t.ts * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) }),
      el("td", { cls: "left", text: t.pools.join(", ") }),
      el("td", { cls: "left sell", text: legs(t.paid) }),
      el("td", { cls: "left buy", text: legs(t.received) }),
      el("td", { text: usd(t.usd, 2) }),
      el("td", { cls: "left" }, tags),
      el("td", {}, link),
    );
  });
  box.append(el("table", { cls: "pool-table trade-table" }, el("thead", {}, head), el("tbody", {}, ...rows)));
  const more = data.trades.length - n;
  const capped = data.total > data.trades.length ? ` Showing the newest ${data.trades.length.toLocaleString("en-US")} of ${data.total.toLocaleString("en-US")}; see Katanascan for the rest.` : "";
  const foot = el("p", { cls: "detail-note", text: `${n.toLocaleString("en-US")} of ${data.total.toLocaleString("en-US")} trades, newest first.${capped}` });
  if (more > 0) {
    const btn = el("button", { cls: "btn-xs", text: `Show ${Math.min(PAGE * 4, more)} more` });
    btn.type = "button";
    btn.addEventListener("click", () => {
      tradesShown.set(wallet, n + PAGE * 4);
      renderRows();
    });
    foot.append(btn);
  }
  box.append(foot);
  return box;
}

const when = (t: number) => new Date(t * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function joinCell(r: WalletRow): HTMLTableCellElement {
  const td = el("td", { cls: "left" });
  if (r.joined === null || !board?.optIn || board.status === "final") {
    td.textContent = "–";
    return td;
  }
  if (r.joined) {
    td.append(el("span", { text: r.joinSource === "admin" ? "Admin" : "Signed" }), el("span", { cls: "sub", text: `counts from ${when(r.joinedFrom ?? 0)}` }));
    td.append(adminButton("Remove", r.wallet, { action: "remove" }, true));
  } else {
    td.append(el("span", { cls: "muted", text: "No" }));
    td.append(adminButton("Add from start", r.wallet, { action: "add", from: "start" }), adminButton("Add from now", r.wallet, { action: "add", from: "now" }));
  }
  return td;
}

function adminButton(label: string, wallet: string, body: Record<string, string>, danger = false): HTMLButtonElement {
  const b = el("button", { cls: `btn-xs${danger ? " danger" : ""}`, text: label });
  b.type = "button";
  b.addEventListener("click", () => void adminOptIn(wallet, body, b));
  return b;
}

// Manual opt-in for support tickets.
async function adminOptIn(wallet: string, body: Record<string, string>, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  const note = $<HTMLInputElement>("admin-note").value.trim();
  try {
    await adminPost("/api/admin/opt-in", { ...body, wallet, note, roundId: selectedRound });
    $("footnote").textContent = `${body["action"] === "remove" ? "Removed" : "Added"} ${short(wallet)}. Rebuilding, refreshing in a few seconds...`;
    setTimeout(() => void reloadAdmin(), 6000);
  } catch (err) {
    $("footnote").textContent = `Admin action failed: ${String((err as Error).message)}`;
    btn.disabled = false;
  }
}

function emptyRow(msg: string, cls = "empty"): HTMLTableRowElement {
  return el("tr", {}, Object.assign(el("td", { cls, text: msg }), { colSpan: ADMIN ? 11 : 4 }));
}

function renderRows(): void {
  if (!board) return;
  if (isAdminBoard(board)) renderAdminRows(board);
  else renderPublicRows(board as PublicLeaderboard);
}

// Public: the paid places only (RULES.paidRanks in config.ts). A connected wallet outside
// them sees its own place pinned on top, loaded from its per-wallet file.
function renderPublicRows(b: PublicLeaderboard): void {
  const top = b.rows.filter((r) => r.rank !== null && r.rank <= b.rules.paidRanks);
  const inTop = account ? top.find((r) => r.wallet === account) : undefined;
  const rows: HTMLTableRowElement[] = [];
  if (account && !inTop) {
    const mine = myRow?.wallet === account ? myRow : { rank: null, wallet: account, volumeUsd: 0, reward: 0, joined: b.optIn ? joinedNow : null, disqualified: false };
    const tr = publicRow(b, mine);
    tr.classList.add("you", "pinned");
    rows.push(tr);
  }
  for (const r of top) {
    const tr = publicRow(b, r);
    if (r === inTop) tr.classList.add("you");
    rows.push(tr);
  }
  $("rows").replaceChildren(...(rows.length ? rows : [emptyRow("No ranked traders yet.")]));
  renderJoinBanner(b, inTop ?? (myRow?.wallet === account ? myRow : null));
}

// ---------------------------------------------------------------------------
// Per-round opt-in (public page). Shown only while a round is set in config.ts.
// Joining = signing a free message that names the round; it never sends a transaction.

let joinedNow = false; // set right after a successful join, until the next rebuild shows it
let joinError = "";
let joining = false;

function renderJoinBanner(b: PublicLeaderboard, mine: PublicRow | null): void {
  const box = $("join-banner");
  const o = b.optIn;
  const joined = joinedNow || mine?.joined === true;
  box.className = "join-banner";
  // Also switch the moment the end time passes, before the server's next rebuild.
  const endedNow = b.status === "live" && Date.now() / 1000 >= b.round.end;
  if (b.status === "review" || b.status === "final" || endedNow) {
    box.hidden = false;
    if (b.status !== "final") box.classList.add("review");
    box.replaceChildren(el("span", {
      text: b.status !== "final"
        ? `${b.round.label.split(":")[0]} has ended. Results are under review and may change before payout.`
        : `Final results for ${b.round.label.split(":")[0]}.`,
    }));
    return;
  }
  if (!o) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  if (!account) {
    box.replaceChildren(el("span", { text: `Connect your wallet and join ${o.roundName} to compete. Only trades after you join count.` }));
  } else if (joined) {
    box.classList.add("ok");
    box.replaceChildren(el("span", { text: `You're in ${o.roundName}. Your trades count until the round ends.` }));
  } else if (!o.open) {
    box.replaceChildren(el("span", { text: `${o.roundName} has ended. Watch for the next round.` }));
  } else {
    if (joinError) box.classList.add("err");
    const btn = el("button", { cls: "btn-join", text: joining ? "Check your wallet..." : `Join ${o.roundName}` });
    btn.type = "button";
    btn.disabled = joining;
    btn.addEventListener("click", () => void join(o.roundId));
    box.replaceChildren(
      el("span", { text: joinError || `You haven't joined ${o.roundName} yet. Only trades after you join count. Joining is a free signature, not a transaction.` }),
      btn,
    );
  }
}

const toHex = (text: string) => "0x" + [...new TextEncoder().encode(text)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function join(roundId: string): Promise<void> {
  const wallet = account;
  if (!wallet || !active || joining) return;
  joining = true;
  joinError = "";
  renderRows();
  try {
    const m = await fetch(`/api/opt-in/message?wallet=${wallet}`, { cache: "no-store" });
    const msg = (await m.json()) as { message?: string; issuedAt?: number; roundId?: string; error?: string };
    if (!m.ok || !msg.message || msg.roundId !== roundId) throw new Error(msg.error ?? "Couldn't start opt-in.");
    const signature = await active.request({ method: "personal_sign", params: [toHex(msg.message), wallet] });
    const res = await fetch("/api/opt-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet, issuedAt: msg.issuedAt, signature }),
    });
    const out = (await res.json()) as { joined?: boolean; error?: string };
    if (!res.ok || !out.joined) throw new Error(out.error ?? "Opt-in failed.");
    if (wallet === account) joinedNow = true;
  } catch (err) {
    const code = (err as { code?: number }).code;
    joinError = code === 4001 ? "Signature cancelled. You haven't joined yet." : String((err as Error).message ?? err);
  } finally {
    joining = false;
    renderRows();
  }
}

// Admin default: the most active wallets, joined or not, so big traders who haven't
// opted in are visible (counted volume first, then uncounted volume).
function mostActive(b: Leaderboard): WalletRow[] {
  return [...b.rows].sort((x, y) => y.volumeUsd + y.uncountedUsd - (x.volumeUsd + x.uncountedUsd)).slice(0, b.rules.paidRanks);
}

// Admin: search any wallet, or page through everyone.
function renderAdminRows(b: Leaderboard): void {
  const q = $<HTMLInputElement>("search").value.trim().toLowerCase();
  // A search is a wallet address (prefix) or part of a label.
  const isAddr = /^0x[0-9a-f]{0,40}$/.test(q);
  const list = q
    ? b.rows.filter((r) => (isAddr ? r.wallet.startsWith(q) : (b.labels?.[r.wallet]?.label ?? "").toLowerCase().includes(q)))
    : showAll ? b.rows : mostActive(b);

  if (list.length === 0) {
    const msg = q
      ? isAddr ? "No trades from this wallet in competition pools this round." : "No wallet on this board has a label matching that."
      : "No ranked traders yet.";
    $("rows").replaceChildren(emptyRow(msg));
  } else {
    $("rows").replaceChildren(
      ...list.flatMap((r, i) => {
        const tr = adminRow(r);
        if (q) tr.classList.add("match");
        if (showAll && !q && i > 0 && r.rank === b.rules.paidRanks + 1) tr.classList.add("cutoff");
        return expanded.has(r.wallet) ? [tr, detailRow(r)] : [tr];
      }),
    );
  }
  const toggle = $<HTMLButtonElement>("toggle-all");
  toggle.hidden = Boolean(q) || b.rows.length <= b.rules.paidRanks;
  toggle.textContent = showAll ? `Show top ${b.rules.paidRanks}` : `Show all ${b.rows.length} wallets`;
}

function renderRules(b: Board): void {
  const p = (strong: string, rest: string) => el("p", {}, el("b", { text: strong }), document.createTextNode(` ${rest}`));
  $("rules").replaceChildren(
    p("Volume, not profit.", "Every swap in an eligible Sushi pool on Katana counts toward your total. Stable pairs don't count."),
    p("One trade, counted once.", "A route through two competition pools counts once. Trades that start and end in the same token (arbitrage loops) count as zero."),
    p("Fair prices.", "USDC counts at $1. ETH, BTC and KAT use live exchange prices, never Katana pool prices, so trades at off-market prices only count for what the tokens were worth."),
    p("Minimums.", `A trade must be worth ${usd(b.rules.minTxUsd)} to count, and a wallet needs ${usd(b.rules.minWalletUsd)} to be ranked.`),
    p("Prizes.", `Total volume unlocks the prize pool in steps. The top ${b.rules.paidRanks} wallets split it in proportion to their volume.`),
  );
  $("pools").replaceChildren(
    ...b.pools.map((pool) => el("div", { cls: "pool-row" }, el("span", { text: `${pool.name} · ${pool.feeBps / 100}%` }))),
  );
  const dropped = isAdminBoard(b) ? ` · ${b.totals.droppedTxs.toLocaleString("en-US")} trades under ${usd(b.rules.minTxUsd)} not counted` : "";
  $("footnote").textContent = `Updated ${new Date(b.generatedAt * 1000).toLocaleString()}${dropped}`;
}

// ---------------------------------------------------------------------------
// Countdown to the round start (upcoming) or end (live), ticking every second. At zero it
// refreshes the data so the status flips (upcoming -> live -> ended) without a reload.

let countdownFired = 0; // minute we last asked for fresh data after a boundary

function renderCountdown(): void {
  const box = $("countdown");
  const b = board;
  if (!b || (b.status !== "upcoming" && b.status !== "live")) {
    box.hidden = true;
    return;
  }
  // Switch at the exact second from the round times we already have; the server's next
  // rebuild (within a minute) then catches the data up.
  const now = Math.floor(Date.now() / 1000);
  const phase = now < b.round.start ? "upcoming" : now < b.round.end ? "live" : "ended";
  if (phase !== b.status && countdownFired !== now - (now % 60)) {
    countdownFired = now - (now % 60);
    for (const ms of [5_000, 20_000, 40_000, 70_000]) setTimeout(() => void load(), ms);
    renderRows(); // banner follows the phase too
  }
  const tag = $("mode-tag");
  if (phase === "ended") {
    box.hidden = true;
    tag.className = "tag tag-warn";
    tag.textContent = "Ended · under review";
    return;
  }
  if (phase === "live") {
    tag.className = "tag tag-ok";
    tag.textContent = b.optIn ? "Live · opt-in" : "Live · all wallets";
  }
  const left = Math.max(0, (phase === "upcoming" ? b.round.start : b.round.end) - now);
  box.hidden = false;
  $("cd-label").textContent = phase === "upcoming" ? "Starts in" : "Ends in";
  $("cd-d").textContent = String(Math.floor(left / 86_400));
  $("cd-h").textContent = String(Math.floor((left % 86_400) / 3600)).padStart(2, "0");
  $("cd-m").textContent = String(Math.floor((left % 3600) / 60)).padStart(2, "0");
  $("cd-s").textContent = String(left % 60).padStart(2, "0");
}

function renderRoundSelect(idx: RoundsIndex): void {
  const sel = $<HTMLSelectElement>("round-select");
  const fmt = (t: number) => new Date(t * 1000).toLocaleString(undefined, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const LABEL: Record<RoundsIndex["rounds"][number]["status"], string> = { preview: "", upcoming: "Starts", live: "Ends", review: "Ended", final: "Ended" };
  sel.replaceChildren(
    ...idx.rounds.filter((r) => r.built || r.id === idx.current).map((r) => {
      const o = el("option", {
        text: r.status === "preview" ? r.name : `${r.name} · ${LABEL[r.status]} ${fmt(r.status === "upcoming" ? r.start : r.end)}${r.id === idx.current ? " (Current)" : ""}`,
      });
      o.value = r.id;
      o.selected = r.id === selectedRound;
      return o;
    }),
  );
  sel.hidden = idx.rounds.length < 2;
}

async function load(): Promise<void> {
  try {
    const ir = await fetch(INDEX_URL, { cache: "no-store" });
    if (!ir.ok) throw new Error(`HTTP ${ir.status}`);
    roundsIndex = (await ir.json()) as RoundsIndex;
    if (!selectedRound || !roundsIndex.rounds.some((r) => r.id === selectedRound)) selectedRound = roundsIndex.current;
    renderRoundSelect(roundsIndex);
    const res = await fetch(dataUrl(selectedRound), { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    board = (await res.json()) as Board;
    renderHero(board);
    renderCountdown();
    renderRows();
    renderRules(board);
    if (isAdminBoard(board)) {
      renderPoolReport(board);
      renderRoundAdmin(board);
    }
    if (!ADMIN && account) void fetchMine();
  } catch (err) {
    if (!board) $("rows").replaceChildren(emptyRow(`Could not load leaderboard: ${String(err)}`, "error"));
  }
}

// ---------------------------------------------------------------------------
// Wallet connection (public page). Read-only: we ask for the address and nothing
// else. No signatures, no transactions. Wallets are discovered with EIP-6963, with
// window.ethereum as a fallback for older or in-app browsers.

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, cb: (...args: unknown[]) => void): void;
}
interface WalletInfo { uuid: string; name: string; icon: string; rdns: string }
interface WalletDetail { info: WalletInfo; provider: Eip1193 }

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const STORE_KEY = "spotcomp.wallet";
const wallets = new Map<string, WalletDetail>();
let active: Eip1193 | null = null;

function remember(rdns: string | null): void {
  try {
    if (rdns) localStorage.setItem(STORE_KEY, rdns);
    else localStorage.removeItem(STORE_KEY);
  } catch {
    // storage unavailable: the page works, it just won't reconnect silently
  }
}

function remembered(): string | null {
  try {
    return localStorage.getItem(STORE_KEY);
  } catch {
    return null;
  }
}

function setAccount(addr: unknown): void {
  account = typeof addr === "string" && ADDRESS.test(addr) ? addr.toLowerCase() : null;
  const btn = $<HTMLButtonElement>("connect");
  btn.classList.toggle("connected", account !== null);
  btn.replaceChildren(...(account ? [el("span", { cls: "dot" }), document.createTextNode(short(account))] : [document.createTextNode("Connect wallet")]));
  myRow = null;
  joinedNow = false;
  joinError = "";
  renderRows();
  void fetchMine();
}

async function connect(detail: { provider: Eip1193; info?: WalletInfo }, prompt: boolean): Promise<void> {
  try {
    const accounts = await detail.provider.request({ method: prompt ? "eth_requestAccounts" : "eth_accounts" });
    const first = Array.isArray(accounts) ? accounts[0] : null;
    if (!first) return;
    active = detail.provider;
    remember(detail.info?.rdns ?? "injected");
    detail.provider.on?.("accountsChanged", (accs: unknown) => {
      if (active === detail.provider) setAccount(Array.isArray(accs) ? accs[0] : null);
    });
    setAccount(first);
  } catch {
    // user rejected or the wallet errored: stay disconnected
  }
}

function legacyProvider(): Eip1193 | null {
  const eth = (window as unknown as { ethereum?: Eip1193 }).ethereum;
  return eth && typeof eth.request === "function" ? eth : null;
}

function closeMenu(): void {
  $("wallet-menu").hidden = true;
  $("connect").setAttribute("aria-expanded", "false");
}

function openMenu(items: HTMLElement[]): void {
  const menu = $("wallet-menu");
  menu.replaceChildren(...items);
  menu.hidden = false;
  $("connect").setAttribute("aria-expanded", "true");
}

function menuButton(label: string, onClick: () => void, icon?: string): HTMLButtonElement {
  const b = el("button");
  b.type = "button";
  b.setAttribute("role", "menuitem");
  // Wallet icons are data URIs supplied by the extension; only allow image types.
  if (icon && /^data:image\/(png|svg\+xml|webp|jpeg);/.test(icon)) {
    const img = el("img");
    img.src = icon;
    img.alt = "";
    b.append(img);
  }
  b.append(document.createTextNode(label));
  b.addEventListener("click", () => {
    closeMenu();
    onClick();
  });
  return b;
}

function onConnectClick(): void {
  if (!$("wallet-menu").hidden) return closeMenu();
  if (account) {
    return openMenu([
      menuButton("Disconnect", () => {
        active = null;
        remember(null);
        setAccount(null);
      }),
    ]);
  }
  const found = [...wallets.values()];
  if (found.length === 1) return void connect(found[0]!, true);
  if (found.length > 1) return openMenu(found.map((w) => menuButton(w.info.name, () => void connect(w, true), w.info.icon)));
  const legacy = legacyProvider();
  if (legacy) return void connect({ provider: legacy }, true);
  openMenu([el("p", { text: "No wallet found. Install a browser wallet, or open this page in your wallet app's browser." })]);
}

function initWallet(): void {
  window.addEventListener("eip6963:announceProvider", (e) => {
    const d = (e as CustomEvent<WalletDetail>).detail;
    if (d?.info?.uuid && typeof d.provider?.request === "function") wallets.set(d.info.uuid, d);
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  $("connect").addEventListener("click", onConnectClick);
  document.addEventListener("click", (e) => {
    const box = $("wallet-menu").parentElement;
    if (!(e.target instanceof Node) || !box?.contains(e.target)) closeMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenu();
  });

  // Silent reconnect if this browser connected before (eth_accounts never prompts).
  const rdns = remembered();
  if (rdns) {
    setTimeout(() => {
      const match = [...wallets.values()].find((w) => w.info.rdns === rdns);
      const legacy = rdns === "injected" ? legacyProvider() : null;
      if (match) void connect(match, false);
      else if (legacy) void connect({ provider: legacy }, false);
    }, 300);
  }
}

// ---------------------------------------------------------------------------
// Admin: rounds ("sprints") management, manual refresh and the activity log.

interface AdminRound { id: string; name: string; start: number; end: number; status: RoundsIndex["rounds"][number]["status"]; joined: number; optInRequired: boolean }
let adminRounds: AdminRound[] = [];

const STATUS_LABEL: Record<AdminRound["status"], [string, string]> = {
  preview: ["Preview", "tag-warn"],
  upcoming: ["Upcoming", ""],
  live: ["Live", "tag-ok"],
  review: ["Under review", "tag-warn"],
  final: ["Final", "tag-ok"],
};

// <input type="datetime-local"> works in the viewer's local time zone.
const toLocalInput = (t: number) => {
  const d = new Date(t * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : "");
const utc = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";

async function loadRoundsAdmin(): Promise<void> {
  try {
    const res = await fetch("/api/admin/rounds", { cache: "no-store" });
    const out = (await res.json()) as { actor?: string; rounds?: AdminRound[]; error?: string };
    if (!res.ok || !out.rounds) throw new Error(out.error ?? `HTTP ${res.status}`);
    adminRounds = out.rounds;
    renderRoundsAdmin();
  } catch (err) {
    $("rounds-note").textContent = `Could not load rounds: ${String((err as Error).message)}`;
  }
}

function renderRoundsAdmin(): void {
  const rows = adminRounds.map((r) => {
    const [label, tone] = STATUS_LABEL[r.status];
    const actions = el("td", { cls: "left" });
    if (r.status !== "final") {
      const edit = el("button", { cls: "btn-xs", text: "Edit" });
      edit.type = "button";
      edit.addEventListener("click", () => fillRoundForm(r));
      actions.append(edit);
    }
    if (r.status === "upcoming") {
      const del = el("button", { cls: "btn-xs danger", text: "Delete" });
      del.type = "button";
      del.addEventListener("click", () => void roundsPost({ action: "delete", id: r.id }, del, `Deleted ${r.id}.`));
      actions.append(del);
    }
    return el(
      "tr",
      {},
      el("td", { cls: "left", text: r.id }),
      el("td", { cls: "left", text: r.name }),
      el("td", { cls: "left muted", text: utc(r.start), title: new Date(r.start * 1000).toLocaleString() }),
      el("td", { cls: "left muted", text: utc(r.end), title: new Date(r.end * 1000).toLocaleString() }),
      el("td", { cls: "left" }, el("span", { cls: `tag ${tone}`, text: label })),
      el("td", r.optInRequired
        ? { text: r.joined.toLocaleString("en-US") }
        : { cls: "muted", text: "Off · all count", title: "Opt-in is off: every wallet's trades count. Edit the round to require opt-in." }),
      actions,
    );
  });
  $("rounds-rows").replaceChildren(...(rows.length ? rows : [Object.assign(el("td", { cls: "empty", text: "No rounds yet. The board is in preview mode (last 14 days, every wallet)." }), { colSpan: 7 })].map((td) => el("tr", {}, td))));
}

function fillRoundForm(r: AdminRound | null): void {
  const editing = r !== null;
  const id = $<HTMLInputElement>("rf-id");
  id.value = r?.id ?? "";
  id.readOnly = editing;
  $<HTMLInputElement>("rf-name").value = r?.name ?? "";
  $<HTMLInputElement>("rf-start").value = r ? toLocalInput(r.start) : "";
  $<HTMLInputElement>("rf-end").value = r ? toLocalInput(r.end) : "";
  $<HTMLInputElement>("rf-optin").checked = r?.optInRequired ?? true;
  $("rf-submit").textContent = editing ? `Save ${r.id}` : "Create round";
  $("rf-cancel").hidden = !editing;
  if (editing) $<HTMLInputElement>("rf-name").focus();
}

async function roundsPost(body: Record<string, unknown>, btn: HTMLButtonElement, done: string): Promise<boolean> {
  btn.disabled = true;
  try {
    await adminPost("/api/admin/rounds", body);
    $("rounds-note").textContent = `${done} Rebuilding, refreshing in a few seconds...`;
    setTimeout(() => void reloadAdmin(), 5000);
    await loadRoundsAdmin();
    return true;
  } catch (err) {
    $("rounds-note").textContent = `Failed: ${String((err as Error).message)}`;
    return false;
  } finally {
    btn.disabled = false;
  }
}

async function submitRoundForm(e: Event): Promise<void> {
  e.preventDefault();
  const id = $<HTMLInputElement>("rf-id").value.trim().toLowerCase();
  const editing = $<HTMLInputElement>("rf-id").readOnly;
  const body = {
    action: editing ? "update" : "create",
    id,
    name: $<HTMLInputElement>("rf-name").value.trim(),
    start: fromLocalInput($<HTMLInputElement>("rf-start").value),
    end: fromLocalInput($<HTMLInputElement>("rf-end").value),
    optInRequired: $<HTMLInputElement>("rf-optin").checked,
  };
  const ok = await roundsPost(body, $<HTMLButtonElement>("rf-submit"), editing ? `Saved ${id}.` : `Created ${id}.`);
  if (ok) fillRoundForm(null);
}

async function refreshNow(btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  $("footnote").textContent = `Refreshing ${selectedRound}: pulling new swaps and rebuilding...`;
  try {
    const out = await adminPost<{ ran?: boolean; reason?: string; fetched?: number; complete?: boolean; ms?: number }>("/api/admin/refresh", { roundId: selectedRound });
    $("footnote").textContent = out.ran
      ? `Refreshed ${selectedRound}: ${out.fetched ?? 0} new swaps in ${((out.ms ?? 0) / 1000).toFixed(1)}s${out.complete === false ? " (still backfilling; it continues on the next refresh)" : ""}.`
      : `Not refreshed: ${out.reason ?? "unknown"}.`;
    await reloadAdmin();
  } catch (err) {
    $("footnote").textContent = `Refresh failed: ${String((err as Error).message)}`;
  } finally {
    btn.disabled = false;
  }
}

async function loadLog(): Promise<void> {
  try {
    const res = await fetch("/api/admin/log", { cache: "no-store" });
    if (!res.ok) return;
    const entries = (await res.json()) as { at: number; actor: string; action: string; roundId: string | null; wallet: string | null; detail: string | null }[];
    $("log-rows").replaceChildren(
      ...(entries.length
        ? entries.map((e) => el(
            "tr",
            {},
            el("td", { cls: "left muted", text: when(e.at) }),
            el("td", { cls: "left", text: e.actor }),
            el("td", { cls: "left", text: e.action }),
            el("td", { cls: "left muted", text: e.roundId ?? "–" }),
            el("td", { cls: "left wallet" }, e.wallet ? walletLink(e.wallet) : document.createTextNode("–")),
            el("td", { cls: "left muted", text: e.detail ?? "" }),
          ))
        : [el("tr", {}, Object.assign(el("td", { cls: "empty", text: "No admin actions yet." }), { colSpan: 6 }))]),
    );
  } catch {
    // the log is informational; the rest of the page still works
  }
}

async function reloadAdmin(): Promise<void> {
  await Promise.all([load(), loadRoundsAdmin(), loadLog()]);
}

// ---------------------------------------------------------------------------

let started = false;

export function start(view: "public" | "admin"): void {
  if (started) return; // React dev mode runs effects twice
  started = true;
  ADMIN = view === "admin";
  $("round-select").addEventListener("change", (e) => {
    selectedRound = (e.target as HTMLSelectElement).value;
    board = null;
    myRow = null;
    expanded.clear();
    void load();
  });
  if (ADMIN) {
    $("round-finalize").addEventListener("click", (e) => void roundAction({ action: "finalize" }, e.currentTarget as HTMLButtonElement));
    $("round-reopen").addEventListener("click", (e) => void roundAction({ action: "reopen" }, e.currentTarget as HTMLButtonElement));
    $("refresh-now").addEventListener("click", (e) => void refreshNow(e.currentTarget as HTMLButtonElement));
    $("payout-csv").addEventListener("click", () => {
      if (board && isAdminBoard(board)) downloadPayoutCsv(board);
    });
    $("pool-csv").addEventListener("click", () => {
      if (board && isAdminBoard(board)) downloadPoolCsv(board);
    });
    $("search").addEventListener("input", renderRows);
    $("toggle-all").addEventListener("click", () => {
      showAll = !showAll;
      renderRows();
    });
    $("round-form").addEventListener("submit", (e) => void submitRoundForm(e));
    $("rf-cancel").addEventListener("click", () => fillRoundForm(null));
    const name = $<HTMLInputElement>("admin-name");
    try {
      name.value = localStorage.getItem(NAME_KEY) ?? "";
    } catch {
      // storage unavailable: the name just isn't remembered
    }
    name.addEventListener("change", () => {
      try {
        localStorage.setItem(NAME_KEY, adminName());
      } catch {
        // ignore
      }
    });
    void loadRoundsAdmin();
    void loadLog();
    setInterval(() => void loadLog(), REFRESH_MS);
  } else {
    initWallet();
  }
  void load();
  setInterval(() => void load(), REFRESH_MS);
  setInterval(renderCountdown, 1000);
}
