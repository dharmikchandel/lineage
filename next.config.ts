import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The FalkorDB client is Node-only; keep it out of the client bundle.
  serverExternalPackages: ["falkordb"],
};

export default nextConfig;
