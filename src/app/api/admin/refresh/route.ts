import { errorJson, json, readJson, requireAdmin } from "@/lib/http";
import { refresh } from "@/lib/refresh";
import { isRoundId, logAdmin } from "@/lib/rounds";

export const maxDuration = 300;

// POST {roundId}: rebuild a round now (pulls new swaps first). Waits for the result.
export async function POST(req: Request) {
  const actor = requireAdmin(req, true);
  if (actor instanceof Response) return actor;
  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch (e) {
    return errorJson(400, (e as Error).message);
  }
  const roundId = String(body.roundId ?? "");
  if (roundId !== "preview" && !isRoundId(roundId)) return errorJson(400, "Unknown round.");
  try {
    const result = await refresh(roundId, true);
    if (result.ran) await logAdmin(actor, "refresh", roundId, null, `${result.fetched ?? 0} swaps in ${result.ms ?? 0}ms`);
    return json(result, result.ran || result.reason !== "another refresh is running" ? 200 : 409);
  } catch (err) {
    return errorJson(502, `Refresh failed: ${(err as Error).message}`);
  }
}
