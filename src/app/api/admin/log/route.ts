import { sql } from "@/lib/db";
import { json, requireAdmin } from "@/lib/http";

// The 50 most recent admin actions, newest first.
export async function GET(req: Request) {
  const actor = requireAdmin(req, false);
  if (actor instanceof Response) return actor;
  const rows = await sql()`select extract(epoch from at)::bigint as at, actor, action, round_id, wallet, detail
                           from admin_log order by id desc limit 50`;
  return json(rows.map((r) => ({ at: Number(r.at), actor: r.actor, action: r.action, roundId: r.round_id, wallet: r.wallet, detail: r.detail })));
}
