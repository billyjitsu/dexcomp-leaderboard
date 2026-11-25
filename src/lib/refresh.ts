// Keeps snapshots fresh without a per-minute cron (the Vercel Hobby plan only allows a
// daily one). Public reads call refreshIfStale() after responding; it rebuilds when the
// snapshot is older than REFRESH_SEC for a live round, when an admin changed something, or
// when a round changed phase. A database lease makes sure only one rebuild runs at a time
// across every serverless instance, so indexer load doesn't grow with visitors.

import { randomUUID } from "node:crypto";
import { PREVIEW_DAYS, REFRESH_SEC } from "./config.ts";
import { num, nowSec, sql } from "./db.ts";
import { buildSnapshot, type BoardTarget } from "./board.ts";
import { allRounds, defaultRound, previewWindow, statusOf, type Round } from "./rounds.ts";
import { syncWindow } from "./sync.ts";

const LEASE_SEC = 280; // just under the 300s function limit

async function acquireLease(holder: string): Promise<boolean> {
  const rows = await sql()`update build_lock set holder = ${holder}, until = now() + make_interval(secs => ${LEASE_SEC})
                           where id = 1 and until < now() returning id`;
  return rows.length > 0;
}

async function releaseLease(holder: string): Promise<void> {
  await sql()`update build_lock set until = 'epoch' where id = 1 and holder = ${holder}`;
}

function targetOf(r: Round | null, now: number): BoardTarget {
  if (!r) {
    const w = previewWindow(now);
    return { roundId: "preview", name: `Preview: last ${PREVIEW_DAYS} days`, start: w.start, end: w.end, status: "preview", finalizedAt: null, optInRequired: false };
  }
  return { roundId: r.id, name: r.name, start: r.start, end: r.end, status: statusOf(r, now), finalizedAt: r.finalizedAt, optInRequired: r.optInRequired };
}

// Resolves "" (the default round) or a round id to what should be built.
async function resolve(roundId: string, now: number): Promise<{ target: BoardTarget; dirtyAt: number } | null> {
  const rounds = await allRounds();
  if (rounds.length === 0) return roundId === "" || roundId === "preview" ? { target: targetOf(null, now), dirtyAt: 0 } : null;
  const r = roundId === "" ? defaultRound(rounds, now) : rounds.find((x) => x.id === roundId) ?? null;
  return r ? { target: targetOf(r, now), dirtyAt: r.dirtyAt } : null;
}

export interface RefreshResult {
  ran: boolean;
  reason: string;
  roundId?: string;
  fetched?: number;
  complete?: boolean;
  ms?: number;
}

async function needsRebuild(target: BoardTarget, dirtyAt: number, now: number): Promise<string | null> {
  const rows = await sql()`select generated_at, status, (board->>'dataThroughTs')::bigint as through from snapshots where round_id = ${target.roundId}`;
  const s = rows[0];
  if (!s) return "no snapshot";
  const generatedAt = num(s.generated_at);
  if (dirtyAt >= generatedAt) return "admin change";
  if (String(s.status) !== target.status) return `status ${String(s.status)} -> ${target.status}`;
  const running = target.status === "live" || target.status === "preview";
  // A first pull of a long window spans several refreshes; keep going without waiting.
  if (running && num(s.through) < now - 600) return "backfilling";
  if (running && now - generatedAt >= REFRESH_SEC) return "stale";
  // Ended, but the last build didn't have every swap up to the end yet.
  if (target.status === "review" && num(s.through) < target.end) return "catching up to round end";
  return null;
}

// Rebuilds `roundId` ("" = default round) if it needs it. force = rebuild regardless.
export async function refresh(roundId: string, force = false): Promise<RefreshResult> {
  const started = Date.now();
  const now = nowSec();
  const resolved = await resolve(roundId, now);
  if (!resolved) return { ran: false, reason: "unknown round" };
  const why = force ? "forced" : await needsRebuild(resolved.target, resolved.dirtyAt, now);
  if (!why) return { ran: false, reason: "fresh", roundId: resolved.target.roundId };

  const holder = randomUUID();
  if (!(await acquireLease(holder))) return { ran: false, reason: "another refresh is running", roundId: resolved.target.roundId };
  try {
    let fetched = 0;
    let complete = true;
    // Admin changes made while building are picked up by one more pass.
    for (let pass = 0; pass < 3; pass++) {
      const passStart = nowSec();
      const again = await resolve(roundId, passStart);
      if (!again) break;
      const t = again.target;
      const sync = await syncWindow(t.roundId, t.start, t.end, passStart, t.roundId === "preview");
      fetched += sync.fetched;
      complete = sync.complete;
      await buildSnapshot(t, sync.throughTs, passStart, sync.priceSources);
      const latest = await resolve(roundId, nowSec());
      if (!latest || latest.dirtyAt < passStart) break;
    }
    const result = { ran: true, reason: why, roundId: resolved.target.roundId, fetched, complete, ms: Date.now() - started };
    console.log(`[refresh] ${JSON.stringify(result)}`);
    return result;
  } catch (err) {
    console.error(`[refresh] ${resolved.target.roundId} failed:`, err);
    throw err;
  } finally {
    await releaseLease(holder);
  }
}

// For after(): never throws, so a failed refresh can't break the response it follows.
export async function refreshIfStale(roundId: string): Promise<void> {
  try {
    await refresh(roundId);
  } catch {
    // logged in refresh(); the board stays on its last good snapshot
  }
}
