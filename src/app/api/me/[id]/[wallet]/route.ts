import { sql } from "@/lib/db";
import { errorJson, json, PUBLIC_CACHE } from "@/lib/http";
import { isAddress } from "@/lib/optin";
import { isRoundId } from "@/lib/rounds";
import { publicWalletRow } from "@/lib/score";
import type { WalletRow } from "@/lib/types";

// One wallet's own place, looked up when it connects, so the public list never exposes
// anyone below the paid places.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; wallet: string }> }) {
  const { id, wallet } = await params;
  if ((id !== "preview" && !isRoundId(id)) || !isAddress(wallet)) return errorJson(404, "Not found.");
  const rows = await sql()`select r.value as row
                           from snapshots s, jsonb_array_elements(s.board->'rows') r
                           where s.round_id = ${id} and r.value->>'wallet' = ${wallet}`;
  const row = rows[0] ? publicWalletRow(rows[0].row as WalletRow) : null;
  if (!row) return errorJson(404, "No trades this round.");
  return json(row, 200, PUBLIC_CACHE);
}
