// Unit tests for the openai-usage plugin's pure helpers.
// Run: node --test <this file's dir>

import test from "node:test"
import assert from "node:assert/strict"
import {
  clampPercent,
  formatCountdown,
  parseRateLimits,
  windowLabel,
  windowShortLabel,
} from "../lib/usage-core.js"

// ─── clampPercent ──────────────────────────────────────────────────────────

test("clampPercent rounds and clamps to 0–100", () => {
  assert.equal(clampPercent(0), 0)
  assert.equal(clampPercent(42.4), 42)
  assert.equal(clampPercent(42.6), 43)
  assert.equal(clampPercent(-5), 0)
  assert.equal(clampPercent(150), 100)
  assert.equal(clampPercent(Number.NaN), 0)
  assert.equal(clampPercent(undefined), 0)
})

// ─── windowLabel / windowShortLabel ────────────────────────────────────────

test("windowLabel names known windows and falls back gracefully", () => {
  assert.equal(windowLabel(300), "5-hour")
  assert.equal(windowLabel(10080), "Weekly")
  assert.equal(windowLabel(1440), "Daily")
  assert.equal(windowLabel(2880), "2-day")
  assert.equal(windowLabel(45), "45-minute")
  assert.equal(windowLabel(2160), "2160-minute")
  assert.equal(windowLabel(undefined), "Usage")
})

test("windowShortLabel compacts known windows for the footer", () => {
  assert.equal(windowShortLabel(300), "5h")
  assert.equal(windowShortLabel(10080), "Wk")
  assert.equal(windowShortLabel(60), "1h")
  assert.equal(windowShortLabel(1440), "1d")
  assert.equal(windowShortLabel(2880), "2d")
  assert.equal(windowShortLabel(45), "45m")
  assert.equal(windowShortLabel(undefined), "Usage")
})

// ─── formatCountdown (epoch seconds) ──────────────────────────────────────

test("formatCountdown reads Unix-seconds resetsAt", () => {
  const resetSec = 1795168426
  assert.equal(formatCountdown(resetSec, resetSec * 1000 - 2 * 3600 * 1000), "2h")
  assert.equal(formatCountdown(resetSec, resetSec * 1000 - 90 * 60 * 1000), "1h 30m")
  assert.equal(formatCountdown(resetSec, resetSec * 1000 - 4 * 86400 * 1000), "4d")
  assert.equal(
    formatCountdown(resetSec, resetSec * 1000 - (3 * 86400 + 4 * 3600) * 1000),
    "3d 4h",
  )
})

test("formatCountdown handles expired, missing, and invalid input", () => {
  const resetSec = 1795168426
  assert.equal(formatCountdown(resetSec, resetSec * 1000 + 1000), "now")
  assert.equal(formatCountdown(undefined), "—")
  assert.equal(formatCountdown(Number.NaN), "—")
})

// ─── parseRateLimits ────────────────────────────────────────────────────────

test("parseRateLimits maps primary and secondary windows", () => {
  const parsed = parseRateLimits({
    ordinaryUsageAllowed: true,
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 14, windowDurationMins: 300, resetsAt: 1795168426 },
      secondary: { usedPercent: 2, windowDurationMins: 10080, resetsAt: 1795755226 },
      planType: "plus",
      rateLimitReachedType: null,
    },
    rateLimitResetCredits: { availableCount: 3, credits: [] },
  })

  assert.equal(parsed.error, undefined)
  assert.equal(parsed.planType, "plus")
  assert.equal(parsed.resetCredits, 3)
  assert.equal(parsed.windows.length, 2)

  const primary = parsed.windows.find((w) => w.key === "primary")
  const secondary = parsed.windows.find((w) => w.key === "secondary")
  assert.equal(primary.label, "5-hour")
  assert.equal(primary.shortLabel, "5h")
  assert.equal(primary.percent, 14)
  assert.equal(primary.resetsAtSec, 1795168426)
  assert.equal(secondary.label, "Weekly")
  assert.equal(secondary.shortLabel, "Wk")
  assert.equal(secondary.percent, 2)
})

test("parseRateLimits accepts a single window", () => {
  const parsed = parseRateLimits({
    rateLimits: { primary: { usedPercent: 42, windowDurationMins: 300 } },
  })
  assert.equal(parsed.error, undefined)
  assert.equal(parsed.windows.length, 1)
  assert.equal(parsed.windows[0].percent, 42)
  assert.equal(parsed.windows[0].resetsAtSec, undefined)
})

test("parseRateLimits reports errors for invalid shapes", () => {
  assert.ok(parseRateLimits(null).error)
  assert.ok(parseRateLimits({}).error)
  assert.ok(parseRateLimits({ rateLimits: {} }).error)
  assert.ok(
    parseRateLimits({ rateLimits: { primary: { usedPercent: "nope" } } }).error,
  )
})

test("parseRateLimits tolerates missing optional fields and passes reachedType", () => {
  const parsed = parseRateLimits({
    rateLimits: {
      primary: { usedPercent: 9, windowDurationMins: 300 },
      rateLimitReachedType: "blocked",
    },
  })
  assert.equal(parsed.error, undefined)
  assert.equal(parsed.reachedType, "blocked")
  assert.equal(parsed.resetCredits, undefined)
  assert.equal(parsed.planType, undefined)
  assert.equal(parsed.windows[0].resetsAtSec, undefined)
})
