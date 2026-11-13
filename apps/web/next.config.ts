import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER } from "next/constants";

const nextConfig = (phase: string): NextConfig => ({
  reactStrictMode: true,
  // Keep production output isolated from the development server's live cache.
  distDir: phase === PHASE_PRODUCTION_BUILD || phase === PHASE_PRODUCTION_SERVER ? ".next-production" : ".next",
});
export default nextConfig;
