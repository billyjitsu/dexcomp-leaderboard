import { after } from "next/server";
import { sql } from "@/lib/db";
import { errorJson, json, PUBLIC_CACHE } from "@/lib/http";
import { refresh, refreshIfStale } from "@/lib/refresh";
import { isRoundId } from "@/lib/rounds";

export const maxDuration = 300;

// The public board for one round: top places only, no admin fields.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (id !== "preview" && !isRoundId(id)) return errorJson(404, "Unknown round.");
  const read = () => sql()`select public from snapshots where round_id = ${id}`;
  let rows = await read();
  if (!rows[0]) {
    // First view of a new round: build it now rather than show nothing.
    await refresh(id).catch(() => undefined);
    rows = await read();
    if (!rows[0]) return errorJson(404, "This round hasn't been built yet. Try again in a minute.");
  }
  after(() => refreshIfStale(id));
  return json(rows[0].public, 200, PUBLIC_CACHE);
}
