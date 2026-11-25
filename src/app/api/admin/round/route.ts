import { after } from "next/server";
import { nowSec, sql } from "@/lib/db";
import { errorJson, json, readJson, requireAdmin } from "@/lib/http";
import { isAddress } from "@/lib/optin";
import { refreshIfStale } from "@/lib/refresh";
import { isRoundId, logAdmin, markDirty, roundById, statusOf } from "@/lib/rounds";

export const maxDuration = 300;

// POST {roundId, action: "disqualify"|"reinstate"|"finalize"|"reopen", wallet?, reason?}
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
  const now = nowSec();
  const action = body.action;
  const wallet = String(body.wallet ?? "").toLowerCase();
  const reason = String(body.reason ?? "").trim().slice(0, 300);

  if (action === "disqualify" || action === "reinstate") {
    if (round.final) return errorJson(409, "This round is final. Reopen it first.");
    if (!isAddress(wallet)) return errorJson(400, "Bad wallet address.");
    if (action === "disqualify") {
      if (!reason) return errorJson(400, "Add a reason in the note field first.");
      await sql()`insert into disqualifications (round_id, wallet, reason, at, actor) values (${round.id}, ${wallet}, ${reason}, ${now}, ${actor})
                  on conflict (round_id, wallet) do update set reason = excluded.reason, at = excluded.at, actor = excluded.actor`;
    } else {
      await sql()`delete from disqualifications where round_id = ${round.id} and wallet = ${wallet}`;
    }
  } else if (action === "finalize") {
    if (statusOf(round, now) !== "review") return errorJson(409, "Only an ended round under review can be finalized.");
    await sql()`update rounds set final = true, finalized_at = ${now} where id = ${round.id}`;
  } else if (action === "reopen") {
    await sql()`update rounds set final = false, finalized_at = null where id = ${round.id}`;
  } else {
    return errorJson(400, "Unknown action.");
  }
  await logAdmin(actor, String(action), round.id, isAddress(wallet) ? wallet : null, reason || null);
  await markDirty(round.id);
  after(() => refreshIfStale(round.id));
  return json({ ok: true });
}
