// Admin access: OPEN. There is no login; anyone with the /admin URL can use every admin
// action (create/delete rounds, disqualify, finalize, payout CSV). Keep the link private.
//
// Two protections remain:
// - Writes must come from the admin page itself (same Origin, JSON body, custom header),
//   so another website can't trigger admin actions in a visitor's browser (CSRF).
// - Every action is recorded in admin_log under the name typed on the admin page.

// The name sent by the admin page (x-admin-actor), or "anonymous".
export function adminActorName(header: string | null): string {
  let name = "";
  try {
    name = decodeURIComponent(header ?? "").trim();
  } catch {
    return "anonymous";
  }
  return /^[\p{L}\p{N} ._@-]{1,40}$/u.test(name) ? name : "anonymous";
}

export function adminWriteError(req: Request): string | null {
  const host = req.headers.get("host");
  const origin = req.headers.get("origin");
  if (!host || !origin) return "Missing origin.";
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return "Bad origin.";
  }
  if (originHost !== host) return "Admin actions only from the admin page.";
  if (req.headers.get("x-admin-request") !== "1") return "Missing admin header.";
  if (!String(req.headers.get("content-type") ?? "").startsWith("application/json")) return "Expected application/json.";
  return null;
}
