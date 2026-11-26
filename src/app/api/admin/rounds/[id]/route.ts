import { after } from "next/server";
import { sql } from "@/lib/db";
import { errorJson, json, requireAdmin } from "@/lib/http";
import { refresh, refreshIfStale } from "@/lib/refresh";
import { KNOWN_WALLETS, RELAYER_LABEL } from "@/lib/known-wallets";
import { isRoundId } from "@/lib/rounds";
import type { WalletLabel } from "@/lib/types";

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
  // Labels for known bots, farms and app relayers. Added here, not stored in the snapshot.
  const labels: Record<string, WalletLabel> = {};
  const relayers = await sql()`select distinct origin from tx_traders where status <> 'direct'`;
  const relayerSet = new Set(relayers.map((r) => String(r.origin)));
  for (const { wallet } of (rows[0].board as { rows?: { wallet: string }[] }).rows ?? []) {
    const known = KNOWN_WALLETS[wallet] ?? (relayerSet.has(wallet) ? RELAYER_LABEL : undefined);
    if (known) labels[wallet] = known;
  }
  return json({ ...(rows[0].board as object), labels });
}
