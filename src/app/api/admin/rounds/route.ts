import { after } from "next/server";
import { nowSec, sql } from "@/lib/db";
import { errorJson, json, readJson, requireAdmin } from "@/lib/http";
import { refreshIfStale } from "@/lib/refresh";
import { allRounds, isRoundId, logAdmin, markDirty, roundById, statusOf } from "@/lib/rounds";

export const maxDuration = 300;

// Every round with its opt-in count, for the Rounds card on /admin.
export async function GET(req: Request) {
  const actor = requireAdmin(req, false);
  if (actor instanceof Response) return actor;
  const now = nowSec();
  const [rounds, counts] = await Promise.all([
    allRounds(),
    sql()`select round_id, count(*)::int as n from opt_ins group by round_id`,
  ]);
  const joined = new Map(counts.map((r) => [String(r.round_id), Number(r.n)]));
  return json({
    actor,
    rounds: rounds.map((r) => ({ id: r.id, name: r.name, start: r.start, end: r.end, status: statusOf(r, now), joined: joined.get(r.id) ?? 0, optInRequired: r.optInRequired })).reverse(),
  });
}

const parseTime = (v: unknown): number | null => {
  const t = Date.parse(String(v ?? ""));
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
};

// POST {action: "create", id, name, start, end, optInRequired?} | {action: "update", id, name?, start?, end?, optInRequired?} | {action: "delete", id}
// start/end are ISO 8601 times (e.g. 2026-12-01T16:00:00Z). optInRequired defaults to true;
// false = every wallet's trades count (useful for pulling data before opt-in launches).
export async function POST(req: Request) {
  const actor = requireAdmin(req, true);
  if (actor instanceof Response) return actor;
  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch (e) {
    return errorJson(400, (e as Error).message);
  }
  const id = String(body.id ?? "");
  if (!isRoundId(id)) return errorJson(400, "Round id must be 1-40 lowercase letters, digits or dashes (not \"preview\").");
  const now = nowSec();

  if (body.action === "create") {
    const name = String(body.name ?? "").trim();
    const start = parseTime(body.start);
    const end = parseTime(body.end);
    if (!name || name.length > 80) return errorJson(400, "Name is required (up to 80 characters).");
    if (start === null || end === null || start >= end) return errorJson(400, "Start and end must be valid times, start before end.");
    if (await roundById(id)) return errorJson(409, `Round ${id} already exists.`);
    const optInRequired = body.optInRequired !== false;
    await sql()`insert into rounds (id, name, start_ts, end_ts, dirty_at, opt_in_required) values (${id}, ${name}, ${start}, ${end}, ${now}, ${optInRequired})`;
    await logAdmin(actor, "round create", id, null, `${name} ${new Date(start * 1000).toISOString()} to ${new Date(end * 1000).toISOString()}, opt-in ${optInRequired ? "required" : "off"}`);
    // The first round replaces preview mode.
    await sql()`delete from snapshots where round_id = 'preview'`;
  } else if (body.action === "update") {
    const r = await roundById(id);
    if (!r) return errorJson(404, "Unknown round.");
    if (r.final) return errorJson(409, "This round is final. Reopen it first.");
    const name = body.name === undefined ? r.name : String(body.name).trim();
    const start = body.start === undefined ? r.start : parseTime(body.start);
    const end = body.end === undefined ? r.end : parseTime(body.end);
    if (!name || name.length > 80) return errorJson(400, "Name is required (up to 80 characters).");
    if (start === null || end === null || start >= end) return errorJson(400, "Start and end must be valid times, start before end.");
    const optInRequired = body.optInRequired === undefined ? r.optInRequired : body.optInRequired !== false;
    await sql()`update rounds set name = ${name}, start_ts = ${start}, end_ts = ${end}, opt_in_required = ${optInRequired} where id = ${id}`;
    await logAdmin(actor, "round update", id, null, `${name} ${new Date(start * 1000).toISOString()} to ${new Date(end * 1000).toISOString()}, opt-in ${optInRequired ? "required" : "off"}`);
    await markDirty(id);
  } else if (body.action === "delete") {
    const r = await roundById(id);
    if (!r) return errorJson(404, "Unknown round.");
    // Rounds that have started are history (and may have payouts): keep them.
    if (statusOf(r, now) !== "upcoming") return errorJson(409, "Only a round that hasn't started can be deleted.");
    await sql().transaction([
      sql()`delete from rounds where id = ${id}`,
      sql()`delete from snapshots where round_id = ${id}`,
      sql()`delete from sync_cursors where round_id = ${id}`,
    ]);
    await logAdmin(actor, "round delete", id, null, r.name);
    return json({ ok: true });
  } else {
    return errorJson(400, "action must be create, update or delete");
  }
  after(() => refreshIfStale(id));
  return json({ ok: true });
}
