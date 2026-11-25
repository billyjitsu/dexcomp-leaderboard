import { BINANCE_API, COINBASE_API, PRICE_SYMBOLS, type PriceKey } from "./config.ts";

const MIN = 60;
const MAX_LOOKBACK_MIN = 60; // a trade more than an hour from any candle has no trustworthy price

type Series = Map<number, number>; // minute open (unix s) -> typical price (high+low+close)/3
export type PricedKey = Exclude<PriceKey, "usd">;
export const PRICED_KEYS = Object.keys(PRICE_SYMBOLS) as PricedKey[];

// Where cached candles come from and go to (the `prices` table in production).
export interface PriceStore {
  load(key: PricedKey, fromTs: number, toTs: number): Promise<[number, number][]>;
  save(key: PricedKey, rows: [number, number][]): Promise<void>;
}

// One-minute USD prices from centralized exchanges, never from the Katana pools.
// KAT trades millions a day on Binance/OKX/Coinbase versus ~$40K/day on Katana, so a
// pushed Katana pool cannot move these prices. Binance's public market-data mirror is
// primary (api.binance.com is geo-blocked in the US); Coinbase is the fallback.
export class PriceBook {
  private series = new Map<PricedKey, Series>();
  private fixedMode = false; // tests: one constant price per asset
  readonly sources = new Set<string>();
  maxGapSec = 0; // worst distance between a priced trade and its candle, for the admin view

  // Loads candles covering [fromTs - 1h, toTs] from the store and fetches only what's missing.
  static async load(fromTs: number, toTs: number, store: PriceStore): Promise<PriceBook> {
    const book = new PriceBook();
    for (const key of PRICED_KEYS) {
      const lo = fromTs - MAX_LOOKBACK_MIN * MIN;
      const series: Series = new Map(await store.load(key, lo, toTs));
      const minutes = [...series.keys()];
      const covered = minutes.length > 0 && Math.min(...minutes) <= Math.max(lo, fromTs - 2 * MIN);
      const start = covered ? Math.max(...minutes) - 2 * MIN : lo;
      if (start < toTs) {
        const before = new Set(series.keys());
        const source = await fetchCandles(key, start, toTs, series);
        book.sources.add(source);
        const added = [...series].filter(([t]) => !before.has(t));
        if (added.length) await store.save(key, added);
      } else {
        book.sources.add("cache");
      }
      if (series.size === 0) throw new Error(`no ${key} prices from any source`);
      book.series.set(key, series);
    }
    return book;
  }

  static fixed(prices: Partial<Record<PricedKey, number>>): PriceBook {
    const book = new PriceBook();
    for (const [k, v] of Object.entries(prices)) book.series.set(k as PricedKey, new Map([[0, v]]));
    book.fixedMode = true;
    return book;
  }

  // Price of the candle containing ts, or the nearest earlier one within an hour.
  at(key: PriceKey, ts: number): number {
    if (key === "usd") return 1;
    const s = this.series.get(key);
    if (!s) throw new Error(`no price series for ${key}`);
    if (this.fixedMode) return s.get(0)!;
    const minute = ts - (ts % MIN);
    for (let back = 0; back <= MAX_LOOKBACK_MIN; back++) {
      const px = s.get(minute - back * MIN);
      if (px !== undefined) {
        this.maxGapSec = Math.max(this.maxGapSec, back * MIN);
        return px;
      }
    }
    throw new Error(`no ${key} price within ${MAX_LOOKBACK_MIN} min of ${new Date(ts * 1000).toISOString()}`);
  }
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { "user-agent": "katana-spot-leaderboard" }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

function addCandle(series: Series, t: number, high: number, low: number, close: number): void {
  const px = (high + low + close) / 3;
  if (Number.isFinite(t) && Number.isFinite(px) && px > 0) series.set(t, px);
}

// Fills series in place. Tries Binance for the whole range, then Coinbase. Returns the source used.
async function fetchCandles(key: PricedKey, fromTs: number, toTs: number, series: Series): Promise<string> {
  const sym = PRICE_SYMBOLS[key];
  try {
    for (let start = fromTs; start < toTs; start += 1000 * MIN) {
      const url = `${BINANCE_API}/api/v3/klines?symbol=${sym.binance}&interval=1m&startTime=${start * 1000}&endTime=${toTs * 1000}&limit=1000`;
      const rows = (await getJson(url)) as [number, string, string, string, string][];
      if (!Array.isArray(rows)) throw new Error("bad klines response");
      for (const r of rows) addCandle(series, r[0] / 1000, Number(r[2]), Number(r[3]), Number(r[4]));
      if (rows.length < 1000) break;
    }
    return "binance";
  } catch (err) {
    console.warn(`Binance ${sym.binance} failed (${String(err)}), falling back to Coinbase`);
  }
  for (let start = fromTs; start < toTs; start += 300 * MIN) {
    const end = Math.min(toTs, start + 300 * MIN);
    const url = `${COINBASE_API}/products/${sym.coinbase}/candles?granularity=60&start=${new Date(start * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`;
    const rows = (await getJson(url)) as [number, number, number, number, number][];
    if (!Array.isArray(rows)) throw new Error(`bad Coinbase response for ${sym.coinbase}`);
    for (const r of rows) addCandle(series, r[0], r[2], r[1], r[4]);
  }
  return "coinbase";
}
