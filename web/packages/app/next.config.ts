import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadEnvConfig } from "@next/env";
import type { NextConfig } from "next";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Repo root (``awa/``): load root ``.env`` for ElevenLabs + optional overrides. */
loadEnvConfig(path.resolve(__dirname, "../../.."));

const awaOrigin = process.env.AWA_API_ORIGIN || "http://127.0.0.1:8080";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/awa/:path*",
        destination: `${awaOrigin.replace(/\/$/, "")}/:path*`,
      },
    ];
  },
};

export default nextConfig;
