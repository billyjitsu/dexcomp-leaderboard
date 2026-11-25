import { nowSec } from "@/lib/db";
import { errorJson, json, rateLimited } from "@/lib/http";
import { isAddress, optInMessage } from "@/lib/optin";
import { allRounds, joinableRound } from "@/lib/rounds";

// GET /api/opt-in/message?wallet=0x...  -> the exact text to sign for the open round.
export async function GET(req: Request) {
  if (rateLimited(req)) return errorJson(429, "Too many requests.");
  const now = nowSec();
  const round = joinableRound(await allRounds(), now);
  if (!round) return errorJson(409, "No competition round is open.");
  const wallet = String(new URL(req.url).searchParams.get("wallet") ?? "").toLowerCase();
  if (!isAddress(wallet)) return errorJson(400, "Bad wallet address.");
  return json({ roundId: round.id, issuedAt: now, message: optInMessage(round, wallet, now) });
}
