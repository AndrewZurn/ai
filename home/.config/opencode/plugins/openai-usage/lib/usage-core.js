// Pure helpers for the OpenCode OpenAI (Codex) usage plugin.
//
// Rate-limit response parsing and countdown/bar formatting live here so they
// can be unit-tested with node --test without the TUI. The `codex app-server`
// orchestration lives in ./codex.js.

// ─── Types ───────────────────────────────────────────────────────────────────

// Window = {
//   key: "primary" | "secondary",
//   label: string,          // "5-hour", "Weekly", …
//   shortLabel: string,     // "5h", "Wk", … for the footer
//   percent: number,        // 0–100
//   resetsAtSec?: number,   // Unix seconds
//   windowDurationMins?: number,
// }

// ─── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Map a window duration (minutes) to a human label. Known Codex windows get
 * friendly names; anything else falls back to a `<n>-minute`/`<n>-day` form.
 */
export function windowLabel(durationMins) {
  if (typeof durationMins !== "number" || !Number.isFinite(durationMins) || durationMins <= 0) {
    return "Usage"
  }
  if (durationMins === 300) return "5-hour"
  if (durationMins === 10080) return "Weekly"
  if (durationMins === 1440) return "Daily"
  if (durationMins < 1440) return `${durationMins}-minute`
  const days = durationMins / 1440
  if (Number.isInteger(days)) return `${days}-day`
  return `${durationMins}-minute`
}

/** Compact label for the footer status segment. */
export function windowShortLabel(durationMins) {
  if (durationMins === 300) return "5h"
  if (durationMins === 10080) return "Wk"
  if (typeof durationMins !== "number" || !Number.isFinite(durationMins) || durationMins <= 0) {
    return "Usage"
  }
  const days = durationMins / 1440
  if (durationMins >= 1440 && Number.isInteger(days)) return `${days}d`
  const hours = durationMins / 60
  if (Number.isInteger(hours)) return `${hours}h`
  return `${durationMins}m`
}

/**
 * Parse the `account/rateLimits/read` result:
 * { rateLimits: { primary, secondary, planType, rateLimitReachedType }, … }.
 *
 * Returns { windows, planType?, reachedType?, resetCredits?, error? } where
 * `windows` is a list of valid { key, label, shortLabel, percent,
 * resetsAtSec, windowDurationMins }. Missing/invalid input yields an `error`
 * and an empty window list.
 */
export function parseRateLimits(json) {
  const root = json && typeof json === "object" ? json : undefined
  const rateLimits = root?.rateLimits
  if (!rateLimits || typeof rateLimits !== "object") {
    return { windows: [], error: "rate limits response missing rateLimits" }
  }

  const pick = (key) => {
    const w = rateLimits[key]
    if (!w || typeof w !== "object") return null
    const percent = w.usedPercent
    if (typeof percent !== "number" || !Number.isFinite(percent)) return null
    return {
      key,
      label: windowLabel(w.windowDurationMins),
      shortLabel: windowShortLabel(w.windowDurationMins),
      percent,
      resetsAtSec:
        typeof w.resetsAt === "number" && Number.isFinite(w.resetsAt) ? w.resetsAt : undefined,
      windowDurationMins:
        typeof w.windowDurationMins === "number" ? w.windowDurationMins : undefined,
    }
  }

  const windows = [pick("primary"), pick("secondary")].filter(Boolean)
  if (windows.length === 0) {
    return { windows: [], error: "rate limits response missing usage windows" }
  }

  const resetCredits = root?.rateLimitResetCredits
  return {
    windows,
    planType: typeof rateLimits.planType === "string" ? rateLimits.planType : undefined,
    reachedType:
      typeof rateLimits.rateLimitReachedType === "string"
        ? rateLimits.rateLimitReachedType
        : undefined,
    resetCredits:
      resetCredits && typeof resetCredits.availableCount === "number"
        ? resetCredits.availableCount
        : undefined,
  }
}

// ─── Formatting ──────────────────────────────────────────────────────────────

/** Clamp a value to the 0–100 integer range; non-finite input becomes 0. */
export function clampPercent(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, Math.round(n)))
}

/**
 * Human-readable countdown until a Unix-seconds `resetsAt` timestamp,
 * evaluated against `nowMs` (defaults to the current time).
 * Returns "—" for missing/unparseable input, "now" for expired resets.
 */
export function formatCountdown(resetsAtSec, nowMs) {
  if (typeof resetsAtSec !== "number" || !Number.isFinite(resetsAtSec)) return "—"
  const now = nowMs ?? Date.now()
  const sec = Math.round((resetsAtSec * 1000 - now) / 1000)
  if (sec <= 0) return "now"
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0 && h > 0) return `${d}d ${h}h`
  if (d > 0) return `${d}d`
  if (h > 0 && m > 0) return `${h}h ${m}m`
  if (h > 0) return `${h}h`
  if (m > 0) return `${m}m`
  return "<1m"
}
