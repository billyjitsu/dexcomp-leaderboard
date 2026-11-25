import { walletTrades } from "@/lib/board";
import { num, sql } from "@/lib/db";
import { errorJson, json, requireAdmin } from "@/lib/http";
import { isAddress } from "@/lib/optin";
import { isRoundId, roundById } from "@/lib/rounds";

// A wallet's trades in the round, newest first (the ▸ expander on /admin).
export async function GET(req: Request, { params }: { params: Promise<{ id: string; wallet: string }> }) {
  const actor = requireAdmin(req, false);
  if (actor instanceof Response) return actor;
  const { id, wallet } = await params;
  if (!isAddress(wallet)) return errorJson(404, "Not found.");
  let window: { start: number; end: number; everyone: boolean } | null = null;
  if (id === "preview") {
    const rows = await sql()`select (board->'round'->>'start')::bigint as start, (board->'round'->>'end')::bigint as "end" from snapshots where round_id = 'preview'`;
    if (rows[0]) window = { start: num(rows[0].start), end: num(rows[0].end), everyone: true };
  } else if (isRoundId(id)) {
    const r = await roundById(id);
    if (r) window = { start: r.start, end: r.end, everyone: !r.optInRequired };
  }
  if (!window) return errorJson(404, "Unknown round.");
  return json(await walletTrades(id, window.start, window.end, wallet, window.everyone));
}
