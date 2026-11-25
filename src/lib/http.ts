import { adminActorName, adminWriteError } from "./admin-auth.ts";

export function json(body: unknown, status = 200, cache = "no-store"): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": cache },
  });
}

export const errorJson = (status: number, error: string) => json({ error }, status);

// Public board data: Vercel's CDN serves repeat reads for a few seconds, so visitor
// count barely touches the database.
export const PUBLIC_CACHE = "public, max-age=0, s-maxage=10, stale-while-revalidate=50";

export async function readJson(req: Request, limit = 4096): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > limit) throw new Error("body too large");
  const v = JSON.parse(text) as unknown;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("expected a JSON object");
  return v as Record<string, unknown>;
}

// Admin route guard (no login: see admin-auth.ts). Returns the actor name for the log, or
// a Response when a write didn't come from the admin page.
export function requireAdmin(req: Request, write: boolean): string | Response {
  const actor = adminActorName(req.headers.get("x-admin-actor"));
  if (write) {
    const err = adminWriteError(req);
    if (err) return errorJson(403, err);
  }
  return actor;
}

// Best-effort per-instance limiter for the public opt-in endpoints. Signature checks are
// cheap and opt-ins are idempotent, so this only blunts floods.
const hits = new Map<string, number[]>();
export function rateLimited(req: Request, perMinute = 20): boolean {
  const ip = (req.headers.get("x-forwarded-for") ?? "?").split(",")[0]!.trim();
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 10_000) hits.clear();
  return recent.length > perMinute;
}
