import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Spot Trading Competition",
  description: "Katana spot DEX trading competition leaderboard",
  referrer: "no-referrer",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
