// Rounds ("sprints") and their per-round state, stored in Postgres.
//
// Lifecycle: upcoming (not started; opt-in open) -> live (trading counts) -> review (ended;
// admins can disqualify and add late opt-ins) -> final (locked by an admin for payout).

import { PREVIEW_DAYS } from "./config.ts";
import { num, nowSec, sql } from "./db.ts";
import type { RoundInfo } from "./optin.ts";
import type { OptInMap } from "./score.ts";
import type { RoundsIndex } from "./types.ts";

export type { RoundInfo };
export type RoundStatus = "upcoming" | "live" | "review" | "final";

export interface Round extends RoundInfo {
  optInRequired: boolean; // false = every wallet counts, no opt-in
  final: boolean;
  finalizedAt: number | null;
  dirtyAt: number;
}

const ROUND_ID = /^[a-z0-9-]{1,40}$/;
export const isRoundId = (s: unknown): s is string => typeof s === "string" && ROUND_ID.test(s) && s !== "preview";

type Row = Record<string, unknown>;
const toRound = (r: Row): Round => ({
  id: String(r.id),
  name: String(r.name),
  start: num(r.start_ts),
  end: num(r.end_ts),
  optInRequired: r.opt_in_required !== false,
  final: Boolean(r.final),
  finalizedAt: r.finalized_at == null ? null : num(r.finalized_at),
  dirtyAt: num(r.dirty_at),
});

export async function allRounds(): Promise<Round[]> {
  const rows = await sql()`select * from rounds order by start_ts, id`;
  return rows.map(toRound);
}

export async function roundById(id: string): Promise<Round | null> {
  if (!isRoundId(id)) return null;
  const rows = await sql()`select * from rounds where id = ${id}`;
  return rows[0] ? toRound(rows[0]) : null;
}

export function statusOf(r: Round, now: number): RoundStatus {
  if (r.final) return "final";
  if (now < r.start) return "upcoming";
  if (now < r.end) return "live";
  return "review";
}

// The round people can join right now: the earliest one that hasn't ended and needs opt-in.
export const joinableRound = (rounds: Round[], now: number) => rounds.find((r) => now < r.end && !r.final && r.optInRequired) ?? null;

// What the site shows by default: the live round, else the next upcoming one, else the
// most recent ended one.
export function defaultRound(rounds: Round[], now: number): Round | null {
  return rounds.find((r) => r.start <= now && now < r.end) ?? rounds.find((r) => now < r.start) ?? rounds.at(-1) ?? null;
}

// Preview mode (no rounds yet): the last PREVIEW_DAYS days, every wallet counts.
export function previewWindow(now: number): { start: number; end: number } {
  return { start: now - PREVIEW_DAYS * 86_400, end: now };
}

export async function roundsIndex(now = nowSec()): Promise<RoundsIndex> {
  const [rounds, built] = await Promise.all([
    allRounds(),
    sql()`select round_id from snapshots`.then((rows) => new Set(rows.map((r) => String(r.round_id)))),
  ]);
  if (rounds.length === 0) {
    const w = previewWindow(now);
    return { current: "preview", rounds: [{ id: "preview", name: `Preview: last ${PREVIEW_DAYS} days`, start: w.start, end: w.end, status: "preview", built: built.has("preview") }] };
  }
  const list = rounds.map((r) => ({ id: r.id, name: r.name, start: r.start, end: r.end, status: statusOf(r, now), built: built.has(r.id) })).reverse();
  return { current: defaultRound(rounds, now)?.id ?? list[0]!.id, rounds: list };
}

export async function loadOptIns(roundId: string, roundStart: number): Promise<OptInMap> {
  const rows = await sql()`select wallet, from_ts, source from opt_ins where round_id = ${roundId}`;
  return new Map(rows.map((r) => [String(r.wallet), { from: Math.max(num(r.from_ts), roundStart), source: r.source === "admin" ? "admin" as const : "signature" as const }]));
}

export async function loadDisqualified(roundId: string): Promise<Map<string, { reason: string; at: number }>> {
  const rows = await sql()`select wallet, reason, at from disqualifications where round_id = ${roundId}`;
  return new Map(rows.map((r) => [String(r.wallet), { reason: String(r.reason), at: num(r.at) }]));
}

// Marks a round for rebuild on the next refresh.
export async function markDirty(roundId: string): Promise<void> {
  await sql()`update rounds set dirty_at = ${nowSec()} where id = ${roundId}`;
}

export async function logAdmin(actor: string, action: string, roundId: string | null, wallet: string | null, detail: string | null): Promise<void> {
  await sql()`insert into admin_log (actor, action, round_id, wallet, detail) values (${actor}, ${action}, ${roundId}, ${wallet}, ${detail})`;
}
