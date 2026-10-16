import type { ReactNode } from "react";

export const metadata = { title: "Lineage", description: "Trace how a claim mutated, as a graph." };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
