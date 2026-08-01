/**
 * URL construction for the ADK live server.
 *
 * The UI no longer exposes a base-URL field — the interview screen is for
 * interviewing, not for pointing at servers. The capability survives as a
 * build-time env var, so direct (non-proxied) mode is still reachable without
 * putting a text input in front of the candidate.
 */

/**
 * Default: the same-origin Next proxy (`/adk/*` → ADK server, see
 * next.config.ts). Same-origin means no CORS preflight and no need to start the
 * ADK server with `--allow_origins`.
 *
 * Set `NEXT_PUBLIC_ADK_BASE` to an absolute `http(s)://…` origin to bypass the
 * proxy — that mode DOES require `--allow_origins` on the server.
 */
export const ADK_BASE = (process.env.NEXT_PUBLIC_ADK_BASE || "/adk").replace(/\/$/, "");

/**
 * The `agents_dir` subfolder holding the interview agent — ADK's `app_name`.
 *
 * Defaults to the interview agent, `streaming`. Point it at another agent with
 * `NEXT_PUBLIC_ADK_APP_NAME`: the value must name a directory under
 * `core/src/agents/` that exports a `root_agent`, or the session `POST` 404s.
 *
 * `NEXT_PUBLIC_*` is inlined at build time, so the value comes from the shell
 * `next` was started in — the repo-root `.env` reaches it through the
 * `dotenv:` in `taskfile.yaml`, and a change needs a dev-server restart.
 */
export const ADK_APP = process.env.NEXT_PUBLIC_ADK_APP_NAME || "streaming";

/** True for an absolute base like `http://localhost:8000` (direct, not proxied). */
export function isAbsolute(base: string): boolean {
  return /^https?:\/\//i.test(base);
}

export function toWsBase(httpBase: string): string {
  const t = httpBase.replace(/\/$/, "");
  if (t.startsWith("https://")) return `wss://${t.slice(8)}`;
  if (t.startsWith("http://")) return `ws://${t.slice(7)}`;
  return t;
}

/** `POST` here to create the session; the body becomes its initial state. */
export function sessionUrl(base: string, app: string, userId: string, sessionId: string): string {
  return `${base}/apps/${encodeURIComponent(app)}/users/${encodeURIComponent(
    userId,
  )}/sessions/${encodeURIComponent(sessionId)}`;
}

/** Build the absolute ws(s):// URL for `/run_live` from the configured base. */
export function liveWsUrl(base: string, query: string): string {
  if (isAbsolute(base)) {
    return `${toWsBase(base)}/run_live?${query}`;
  }
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const rel = (base.startsWith("/") ? base : `/${base}`).replace(/\/$/, "");
  return `${proto}//${window.location.host}${rel}/run_live?${query}`;
}
