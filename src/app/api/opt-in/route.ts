import { after } from "next/server";
import { OPT_IN_MAX_SKEW_SEC } from "@/lib/config";
import { num, nowSec, sql } from "@/lib/db";
import { errorJson, json, rateLimited, readJson } from "@/lib/http";
import { isAddress, optInMessage, recoverSigner } from "@/lib/optin";
import { refreshIfStale } from "@/lib/refresh";
import { allRounds, joinableRound, markDirty } from "@/lib/rounds";

export const maxDuration = 300;

// POST /api/opt-in {wallet, issuedAt, signature}: joins the open round with a free
// personal_sign signature over a message naming the round.
export async function POST(req: Request) {
  if (rateLimited(req)) return errorJson(429, "Too many requests.");
  if (!String(req.headers.get("content-type") ?? "").startsWith("application/json")) return errorJson(400, "Expected application/json.");
  const now = nowSec();
  const round = joinableRound(await allRounds(), now);
  if (!round) return errorJson(409, "Opt-in is closed.");
  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch (e) {
    return errorJson(400, (e as Error).message);
  }
  const wallet = String(body.wallet ?? "").toLowerCase();
  const issuedAt = Number(body.issuedAt);
  const signature = String(body.signature ?? "");
  if (!isAddress(wallet) || !Number.isInteger(issuedAt)) return errorJson(400, "Bad request.");
  if (Math.abs(now - issuedAt) > OPT_IN_MAX_SKEW_SEC) return errorJson(400, "Signature expired. Please try again.");
  const message = optInMessage(round, wallet, issuedAt);
  if (recoverSigner(message, signature) !== wallet) return errorJson(401, "Signature doesn't match this wallet.");

  // Idempotent: an existing opt-in is never moved later.
  const from = Math.max(issuedAt, round.start);
  await sql()`insert into opt_ins (round_id, wallet, from_ts, at, source, message, signature)
              values (${round.id}, ${wallet}, ${from}, ${now}, 'signature', ${message}, ${signature})
              on conflict (round_id, wallet) do nothing`;
  const rows = await sql()`select from_ts from opt_ins where round_id = ${round.id} and wallet = ${wallet}`;
  await markDirty(round.id);
  after(() => refreshIfStale(round.id));
  return json({ joined: true, roundId: round.id, from: num(rows[0]?.from_ts ?? from) });
}
