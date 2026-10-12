// Pure helpers for the OpenCode Go usage plugin (opencode plugin).
//
// Response parsing, countdown/bar formatting, and API key discovery live
// here so they can be unit-tested with node --test without the TUI. The
// fetch orchestration (timeouts, status codes) stays in tui.tsx.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * A usage window from the Go usage API.
 * percent: 0–100 number; resetsAt: ISO timestamp string, if provided.
 */
// UsageWindow = { percent: number, resetsAt?: string }

// ─── Key discovery ──────────────────────────────────────────────────────────

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return undefined;
  }
}

/**
 * Discover the OpenCode Go API key.
 *
 * Order: OPENCODE_GO_API_KEY env → opencode's auth.json. The auth entry
 * has the shape { "opencode-go": { type: "api", key: "sk-..." } } and is
 * written by /connect → OpenCode Go.
 *
 * Overridable via `env` and `homedir` for tests.
 */
export function discoverApiKey({ env = process.env, homedir = os.homedir() } = {}) {
  const envKey =
    typeof env.OPENCODE_GO_API_KEY === "string" ? env.OPENCODE_GO_API_KEY.trim() : "";
  if (envKey) return envKey;

  const candidates = [
    path.join(homedir, ".local", "share", "opencode", "auth.json"),
    path.join(homedir, ".config", "opencode", "auth.json"),
  ];
  for (const file of candidates) {
    const parsed = readJsonFile(file);
    const entry = parsed?.["opencode-go"];
    const key = entry && typeof entry === "object" ? entry.key : undefined;
    if (typeof key === "string" && key.trim()) return key.trim();
  }
  return undefined;
}

// ─── Response parsing ────────────────────────────────────────────────────────

/**
 * Parse the official usage API response:
 * { usage: { rolling: { status, percent, resetsAt }, weekly, monthly } }.
 *
 * Returns { rolling, weekly, monthly, error? } where each window is
 * { percent, resetsAt } or null. Invalid/unparseable input yields an
 * `error` message and null windows.
 */
export function parseUsageApi(json) {
  const usage = json && typeof json === "object" ? json.usage : undefined;
  if (!usage || typeof usage !== "object") {
    return {
      rolling: null,
      weekly: null,
      monthly: null,
      error: "usage API response missing usage object",
    };
  }

  const pick = (w) => {
    if (!w || typeof w !== "object") return null;
    const percent = typeof w.percent === "number" ? w.percent : Number.NaN;
    if (!Number.isFinite(percent)) return null;
    return {
      percent,
      resetsAt: typeof w.resetsAt === "string" ? w.resetsAt : undefined,
    };
  };

  const rolling = pick(usage.rolling);
  const weekly = pick(usage.weekly);
  const monthly = pick(usage.monthly);
  if (!rolling && !weekly && !monthly) {
    return {
      rolling: null,
      weekly: null,
      monthly: null,
      error: "usage API response missing usage windows",
    };
  }
  return { rolling, weekly, monthly };
}

// ─── Formatting ──────────────────────────────────────────────────────────────

/** Clamp a value to the 0–100 integer range; non-finite input becomes 0. */
export function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Render a Unicode bar for a percentage. Filled with █, empty with ░, so
 * the bar reads correctly in any monospace terminal regardless of theme.
 */
export function renderBar(percent, width = 18) {
  const w = Math.max(0, Math.floor(width));
  const filled = Math.round((clampPercent(percent) / 100) * w);
  return (
    "█".repeat(Math.min(w, Math.max(0, filled))) + "░".repeat(Math.max(0, w - filled))
  );
}

/**
 * Human-readable countdown until an ISO `resetsAt` timestamp, evaluated
 * against `nowMs` (defaults to the current time).
 * Returns "—" for missing/unparseable input, "now" for expired resets.
 */
export function formatCountdown(resetsAt, nowMs) {
  if (typeof resetsAt !== "string" || !resetsAt) return "—";
  const reset = Date.parse(resetsAt);
  const now = nowMs ?? Date.now();
  if (!Number.isFinite(reset)) return "—";
  const sec = Math.round((reset - now) / 1000);
  if (sec <= 0) return "now";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0 && h > 0) return `${d}d ${h}h`;
  if (d > 0) return `${d}d`;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  if (m > 0) return `${m}m`;
  return "<1m";
}
