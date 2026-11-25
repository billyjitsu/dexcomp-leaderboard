import { errorJson, json } from "@/lib/http";
import { refresh } from "@/lib/refresh";

export const maxDuration = 300;

// Vercel cron (vercel.json). A safety net: page views keep live boards fresh, this makes
// sure the default round is rebuilt at least daily even if nobody visits.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return errorJson(401, "Unauthorized.");
  try {
    return json(await refresh(""));
  } catch (err) {
    return errorJson(502, `Refresh failed: ${(err as Error).message}`);
  }
}
