import type { NextConfig } from "next";

/**
 * Same-origin proxy to the ADK live `api_server`.
 *
 * The browser talks only to the Next dev origin (e.g. http://localhost:5173)
 * under `/adk/*`; Next forwards to the ADK server server-side. That request
 * carries no browser `Origin` header, which ADK's `_OriginCheckMiddleware`
 * allows — so the agent works WITHOUT starting the server with
 * `--allow_origins`, and no CORS preflight is ever involved.
 *
 * Override the upstream with `ADK_API_ORIGIN` (default http://localhost:8000).
 * Next proxies the WebSocket upgrade for `/adk/run_live` through this rewrite.
 */
const adkOrigin = (process.env.ADK_API_ORIGIN || "http://localhost:8000").replace(
  /\/$/,
  "",
);

const nextConfig: NextConfig = {
  /**
   * `next dev` and `next build` share `.next`, so a build run while the dev
   * server is up replaces the dev chunks with hashed production ones and the
   * running page starts 404ing them ("Loading chunk … failed"). Set
   * `NEXT_DIST_DIR=.next-build` to check a build without touching dev.
   */
  distDir: process.env.NEXT_DIST_DIR || ".next",

  async rewrites() {
    return [
      {
        source: "/adk/:path*",
        destination: `${adkOrigin}/:path*`,
      },
    ];
  },
};

export default nextConfig;
