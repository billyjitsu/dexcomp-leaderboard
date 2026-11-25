import { after } from "next/server";
import { sql } from "@/lib/db";
import { errorJson, json, requireAdmin } from "@/lib/http";
import { refresh, refreshIfStale } from "@/lib/refresh";
import { isRoundId } from "@/lib/rounds";

export const maxDuration = 300;

// The full board for one round: flags, fees, pool breakdowns, every wallet.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = requireAdmin(req, false);
  if (actor instanceof Response) return actor;
  const { id } = await params;
  if (id !== "preview" && !isRoundId(id)) return errorJson(404, "Unknown round.");
  const read = () => sql()`select board from snapshots where round_id = ${id}`;
  let rows = await read();
  if (!rows[0]) {
    await refresh(id).catch(() => undefined);
    rows = await read();
    if (!rows[0]) return errorJson(404, "This round hasn't been built yet. Use Refresh now.");
  }
  after(() => refreshIfStale(id));
  return json(rows[0].board);
}
