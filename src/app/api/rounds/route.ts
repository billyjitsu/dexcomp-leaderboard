import { after } from "next/server";
import { json, PUBLIC_CACHE } from "@/lib/http";
import { refreshIfStale } from "@/lib/refresh";
import { roundsIndex } from "@/lib/rounds";

export const maxDuration = 300; // the after() refresh can pull a backlog of swaps

// Every round for the dropdown, newest first, plus which one to show by default.
export async function GET() {
  const index = await roundsIndex();
  after(() => refreshIfStale(""));
  return json(index, 200, PUBLIC_CACHE);
}
