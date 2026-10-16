import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The FalkorDB client is Node-only; keep it out of the client bundle.
  serverExternalPackages: ["falkordb"],
  // Do not write AGENTS.md / CLAUDE.md into the repo on `next dev`.
  agentRules: false,
  // No floating dev badge in screen recordings of the demo.
  devIndicators: false,
};

export default nextConfig;
