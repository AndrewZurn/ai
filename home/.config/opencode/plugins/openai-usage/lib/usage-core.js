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
 * Returns { windows, planType?, credits?, individualLimit?,
 * spendControlReached?, reachedType?, resetCredits?, error? } where
 * `windows` is a list of valid { key, label, shortLabel, percent,
 * resetsAtSec, windowDurationMins }. Explicitly null windows are valid for
 * accounts without reported percentage quotas. Missing/invalid input yields
 * an `error` and an empty window list.
 */
export function parseRateLimits(json) {
  const root = json && typeof json === "object" ? json : undefined
  const rateLimits = root?.rateLimits
  if (!rateLimits || typeof rateLimits !== "object" || Array.isArray(rateLimits)) {
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
  const noWindowsReported = rateLimits.primary === null && rateLimits.secondary === null
  if (windows.length === 0 && !noWindowsReported) {
    return { windows: [], error: "rate limits response missing usage windows" }
  }

  const credits = rateLimits.credits
  const individualLimit = rateLimits.individualLimit
  const remainingPercent = individualLimit?.remainingPercent
  const resetCredits = root?.rateLimitResetCredits
  return {
    windows,
    planType: typeof rateLimits.planType === "string" ? rateLimits.planType : undefined,
    credits:
      credits && typeof credits.hasCredits === "boolean" && typeof credits.unlimited === "boolean"
        ? {
            hasCredits: credits.hasCredits,
            unlimited: credits.unlimited,
            balance: typeof credits.balance === "string" ? credits.balance : undefined,
          }
        : undefined,
    individualLimit:
      typeof remainingPercent === "number" && Number.isFinite(remainingPercent)
        && remainingPercent >= 0 && remainingPercent <= 100
        ? {
            remainingPercent,
            used: typeof individualLimit.used === "string" ? individualLimit.used : undefined,
            limit: typeof individualLimit.limit === "string" ? individualLimit.limit : undefined,
            resetsAtSec:
              typeof individualLimit.resetsAt === "number" && Number.isFinite(individualLimit.resetsAt)
                ? individualLimit.resetsAt
                : undefined,
          }
        : undefined,
    spendControlReached:
      typeof rateLimits.spendControlReached === "boolean" ? rateLimits.spendControlReached : undefined,
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

/**
 * Sum reported daily token buckets using UTC calendar dates and Monday weeks.
 * Missing dates stay unreported, not zero. Lifetime/profile fields are ignored.
 */
export function parseTokenUsage(json, nowMs = Date.now()) {
  if (!Array.isArray(json?.dailyUsageBuckets)) {
    return { error: "Codex did not report daily token usage." }
  }
  const buckets = new Map()
  for (const bucket of json.dailyUsageBuckets) {
    const date = bucket?.startDate
    const timestamp = typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? Date.parse(`${date}T00:00:00Z`)
      : Number.NaN
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date
      || !Number.isSafeInteger(bucket?.tokens) || bucket.tokens < 0 || buckets.has(date)) {
      return { error: "Codex returned invalid or duplicate daily token records." }
    }
    buckets.set(date, bucket.tokens)
  }

  const now = new Date(nowMs)
  const todayDate = now.toISOString().slice(0, 10)
  const monday = new Date(`${todayDate}T00:00:00Z`)
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7)
  const weekStart = monday.toISOString().slice(0, 10)
  const monthStart = `${todayDate.slice(0, 7)}-01`
  const reported = [...buckets].filter(([date]) => date <= todayDate).sort(([a], [b]) => a.localeCompare(b))
  const sumSince = (start) => {
    const rows = reported.filter(([date]) => date >= start)
    return rows.length > 0 ? rows.reduce((sum, [, tokens]) => sum + tokens, 0) : undefined
  }
  const today = buckets.get(todayDate)
  const week = sumSince(weekStart)
  const month = sumSince(monthStart)
  if ([today, week, month].some((value) => value !== undefined && !Number.isSafeInteger(value))) {
    return { error: "Codex token totals exceed the supported integer range." }
  }
  return { today, week, month, todayDate, weekStart, monthStart, latestDate: reported.at(-1)?.[0] }
}

// ─── Formatting ──────────────────────────────────────────────────────────────

/** Exact reported counts for the popup; missing data is not displayed as zero. */
export function formatTokenUsage(usage) {
  return [["Today", usage.today], ["This week", usage.week], ["This month", usage.month]]
    .map(([label, tokens]) => ({
      label,
      value: tokens === undefined ? "not reported" : `${tokens.toLocaleString("en-US")} tokens`,
    }))
}

/** Describe only the credit information Codex actually returned. */
export function formatCredits(credits) {
  if (!credits) return undefined
  const status = credits.unlimited ? "unlimited" : credits.hasCredits ? "available" : "not available"
  const balance = credits.balance === undefined ? "balance not reported" : `balance: ${credits.balance}`
  return `Credits: ${status} · ${balance}`
}

/** Footer text for a successful response, including accounts without windows. */
export function formatUsageSummary(usage) {
  if (usage.spendControlReached) return "Codex spend limit reached"
  const parts = usage.windows.map((w) => `${w.shortLabel}${clampPercent(w.percent)}%`)
  if (usage.individualLimit) {
    parts.push(`Mo${clampPercent(usage.individualLimit.remainingPercent)}% left`)
  }
  if (parts.length > 0) return `Codex ${parts.join(" ")}`
  if (usage.reachedType) return "Codex limit reached"
  if (usage.tokenUsage?.month !== undefined) {
    const tokens = usage.tokenUsage.month.toLocaleString("en-US", {
      notation: "compact",
      maximumFractionDigits: 1,
    })
    return `Codex MTD ${tokens} tokens`
  }
  return "Codex usage n/a"
}

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
