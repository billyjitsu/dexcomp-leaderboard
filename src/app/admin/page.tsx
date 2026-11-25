import type { Metadata } from "next";
import { Board } from "../board";

// No login: anyone with the URL can use admin actions (see src/lib/admin-auth.ts).
export const metadata: Metadata = {
  title: "Spot Comp Admin",
  robots: { index: false, follow: false },
};

export default function AdminPage() {
  return <Board view="admin" />;
}
