import { join } from "node:path";

import { loadEnvConfig } from "@next/env";

import type { LiveAvatarEnv } from "@/lib/liveAvatarToken";

/**
 * Reads the repo-root `.env`, matching the convention the sibling packages
 * document (`LIVEAVATAR_API_KEY` and friends live there, not in a per-package
 * file).
 *
 * Next only auto-loads `.env` from the package directory, and neither
 * `next.config.ts` nor a one-shot mutation of `process.env` survives: in dev,
 * `@next/env` snapshots `initialEnv` and calls `resetEnv()` around requests so
 * edits to `.env` get picked up, which also discards anything we added. So we
 * keep our own snapshot of the parsed result instead of trusting `process.env`
 * to hold it.
 *
 * `loadEnvConfig` ships with Next, so this costs no new dependency.
 */
let cached: Record<string, string | undefined> | null = null;

function loadRootEnv(): Record<string, string | undefined> {
  if (!cached) {
    // cwd is the package dir (web/packages/app) for dev, build and start.
    const rootDir = join(process.cwd(), "..", "..", "..");
    const { combinedEnv } = loadEnvConfig(
      rootDir,
      process.env.NODE_ENV !== "production",
      // Next already logs its own env loading on boot; don't double up.
      { info: () => {}, error: console.error },
      // forceReload: `@next/env` caches globally and Next has already loaded the
      // package directory, so without this we'd just get that cache back.
      true,
    );
    cached = combinedEnv;
  }
  return cached;
}

/**
 * Server-side env with the repo-root `.env` folded in.
 *
 * Anything actually present in `process.env` takes precedence, so a real shell
 * export (`LIVEAVATAR_SANDBOX=false npm run dev`) still overrides the file.
 */
export function rootEnv(): LiveAvatarEnv {
  const merged: Record<string, string | undefined> = { ...loadRootEnv() };
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}
