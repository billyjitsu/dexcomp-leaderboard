import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

// Neon over HTTP: stateless, one round trip per query, nothing to pool or close. Uses the
// pooled DATABASE_URL (Vercel env, or .env.local locally).
let client: NeonQueryFunction<false, false> | null = null;

export function sql(): NeonQueryFunction<false, false> {
  if (!client) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    client = neon(url);
  }
  return client;
}

// Row helpers: bigint columns come back as strings, float8 as numbers.
export const num = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`expected a number, got ${String(v)}`);
  return n;
};

export const nowSec = () => Math.floor(Date.now() / 1000);

// Splits rows into chunks so each insert stays well under the HTTP request size limit.
export function chunks<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}
