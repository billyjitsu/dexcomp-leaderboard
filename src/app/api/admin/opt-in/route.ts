import { after } from "next/server";
import { nowSec, sql } from "@/lib/db";
import { errorJson, json, readJson, requireAdmin } from "@/lib/http";
import { isAddress } from "@/lib/optin";
import { refreshIfStale } from "@/lib/refresh";
import { isRoundId, logAdmin, markDirty, roundById } from "@/lib/rounds";

export const maxDuration = 300;

// POST {roundId, action: "add"|"remove", wallet, from?: "start"|"now", note?}
// Manual opt-ins for support tickets ("I forgot to opt in").
export async function POST(req: Request) {
  const actor = requireAdmin(req, true);
  if (actor instanceof Response) return actor;
  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch (e) {
    return errorJson(400, (e as Error).message);
  }
  const round = isRoundId(body.roundId) ? await roundById(body.roundId) : null;
  if (!round) return errorJson(400, "Unknown round.");
  if (round.final) return errorJson(409, "This round is final. Reopen it first.");
  const wallet = String(body.wallet ?? "").toLowerCase();
  if (!isAddress(wallet)) return errorJson(400, "Bad wallet address.");
  const note = String(body.note ?? "").slice(0, 200);
  const now = nowSec();

  if (body.action === "remove") {
    await sql()`delete from opt_ins where round_id = ${round.id} and wallet = ${wallet}`;
  } else if (body.action === "add") {
    const from = body.from === "start" ? round.start : Math.max(now, round.start);
    // Admin adds replace any earlier entry, so a backdate can fix a late opt-in.
    await sql()`insert into opt_ins (round_id, wallet, from_ts, at, source, note) values (${round.id}, ${wallet}, ${from}, ${now}, 'admin', ${note})
                on conflict (round_id, wallet) do update set from_ts = excluded.from_ts, at = excluded.at, source = 'admin',
                  note = excluded.note, message = null, signature = null`;
  } else {
    return errorJson(400, "action must be add or remove");
  }
  await logAdmin(actor, `opt-in ${String(body.action)}${body.action === "add" ? ` from ${String(body.from)}` : ""}`, round.id, wallet, note || null);
  await markDirty(round.id);
  after(() => refreshIfStale(round.id));
  return json({ ok: true });
}
