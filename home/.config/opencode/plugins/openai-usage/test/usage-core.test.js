// Unit tests for the openai-usage plugin's pure helpers.
// Run: node --test <this file's dir>

import test from "node:test"
import assert from "node:assert/strict"
import {
  clampPercent,
  formatCountdown,
  formatCredits,
  formatTokenUsage,
  formatUsageSummary,
  parseRateLimits,
  parseTokenUsage,
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

test("parseRateLimits accepts work-account credits without percentage windows", () => {
  // Sanitized shape returned by an Enterprise account on codex-cli 0.172.0.
  const parsed = parseRateLimits({
    ordinaryUsageAllowed: null,
    rateLimits: {
      limitId: "codex",
      primary: null,
      secondary: null,
      credits: { hasCredits: true, unlimited: false, balance: null },
      planType: "unknown",
      rateLimitReachedType: null,
      spendControlReached: false,
    },
    rateLimitResetCredits: { availableCount: 0, credits: [] },
  })

  assert.equal(parsed.error, undefined)
  assert.deepEqual(parsed.windows, [])
  assert.equal(parsed.planType, "unknown")
  assert.deepEqual(parsed.credits, { hasCredits: true, unlimited: false, balance: undefined })
  assert.equal(parsed.spendControlReached, false)
  assert.equal(parsed.resetCredits, 0)
  assert.equal(formatCredits(parsed.credits), "Credits: available · balance not reported")
  assert.equal(formatUsageSummary(parsed), "Codex usage n/a")
})

test("explicitly null windows are valid even without credit details", () => {
  const parsed = parseRateLimits({ rateLimits: { primary: null, secondary: null } })
  assert.equal(parsed.error, undefined)
  assert.deepEqual(parsed.windows, [])
  assert.equal(parsed.credits, undefined)
  assert.equal(formatUsageSummary(parsed), "Codex usage n/a")
})

test("missing or malformed windows are not mistaken for unreported windows", () => {
  for (const rateLimits of [
    [],
    { primary: null },
    { primary: {}, secondary: null },
    { primary: { usedPercent: "42" }, secondary: null },
    { primary: { usedPercent: Number.NaN }, secondary: null },
  ]) {
    assert.ok(parseRateLimits({ rateLimits }).error)
  }
})

test("credits remain available alongside percentage-based usage", () => {
  const parsed = parseRateLimits({
    rateLimits: {
      primary: { usedPercent: 14, windowDurationMins: 300 },
      credits: { hasCredits: true, unlimited: false, balance: "125.50" },
    },
  })
  assert.equal(parsed.windows[0].percent, 14)
  assert.equal(formatCredits(parsed.credits), "Credits: available · balance: 125.50")
})

test("credit formatting does not infer unlimited credits or a zero balance", () => {
  assert.equal(formatCredits(undefined), undefined)
  assert.equal(
    formatCredits({ hasCredits: false, unlimited: false, balance: "0" }),
    "Credits: not available · balance: 0",
  )
  assert.equal(
    formatCredits({ hasCredits: false, unlimited: true }),
    "Credits: unlimited · balance not reported",
  )
  const parsed = parseRateLimits({
    rateLimits: {
      primary: null,
      secondary: null,
      credits: { hasCredits: "true", unlimited: "false", balance: 0 },
    },
  })
  assert.equal(parsed.credits, undefined)
})

test("footer keeps percentage windows and distinguishes reached limits from unavailable usage", () => {
  assert.equal(
    formatUsageSummary({
      windows: [
        { shortLabel: "5h", percent: 14.2 },
        { shortLabel: "Wk", percent: 2 },
      ],
    }),
    "Codex 5h14% Wk2%",
  )
  assert.equal(
    formatUsageSummary({ windows: [], spendControlReached: true }),
    "Codex spend limit reached",
  )
  assert.equal(
    formatUsageSummary({ windows: [], reachedType: "workspace" }),
    "Codex limit reached",
  )
})

test("monthly credit allowance keeps the server's remaining percentage and reset", () => {
  const parsed = parseRateLimits({
    rateLimits: {
      primary: null,
      secondary: null,
      individualLimit: { remainingPercent: 95, used: "5.25", limit: "100", resetsAt: 1796083200 },
    },
  })
  assert.equal(parsed.error, undefined)
  assert.deepEqual(parsed.individualLimit, {
    remainingPercent: 95, used: "5.25", limit: "100", resetsAtSec: 1796083200,
  })
  assert.equal(formatUsageSummary(parsed), "Codex Mo95% left")
})

test("a missing or invalid monthly allowance is never inferred from tokens or credits", () => {
  for (const individualLimit of [null, {}, { remainingPercent: "95" }, { remainingPercent: -1 }, { remainingPercent: 101 }]) {
    const parsed = parseRateLimits({
      rateLimits: {
        primary: null,
        secondary: null,
        individualLimit,
        credits: { hasCredits: true, unlimited: false, balance: "95" },
      },
    })
    assert.equal(parsed.individualLimit, undefined)
    assert.equal(formatUsageSummary(parsed), "Codex usage n/a")
  }
})

test("zero monthly allowance remains visible as zero percent remaining", () => {
  const parsed = parseRateLimits({
    rateLimits: { primary: null, secondary: null, individualLimit: { remainingPercent: 0 } },
  })
  assert.equal(formatUsageSummary(parsed), "Codex Mo0% left")
})

const NOW = Date.parse("2026-11-25T12:00:00Z")
const tokenProfile = (buckets) => ({
  summary: { lifetimeTokens: 999999999 },
  dailyUsageBuckets: buckets.map(([startDate, tokens]) => ({ startDate, tokens })),
})

test("token totals use calendar day, Monday week, and calendar month, not lifetime", () => {
  const parsed = parseTokenUsage(tokenProfile([
    ["2026-11-25", 5],
    ["2026-10-31", 1000],
    ["2026-11-01", 100],
    ["2026-11-22", 50],
    ["2026-11-23", 10],
    ["2026-11-24", 20],
    ["2026-11-26", 9999],
  ]), NOW)
  assert.deepEqual(parsed, {
    today: 5,
    week: 35,
    month: 185,
    todayDate: "2026-11-25",
    weekStart: "2026-11-23",
    monthStart: "2026-11-01",
    latestDate: "2026-11-25",
  })
  assert.equal(JSON.stringify(parsed).includes("lifetime"), false)
})

test("unreported days are not zero and the latest available day is shown", () => {
  const parsed = parseTokenUsage(tokenProfile([["2026-11-24", 20]]), NOW)
  assert.equal(parsed.today, undefined)
  assert.equal(parsed.week, 20)
  assert.equal(parsed.month, 20)
  assert.equal(parsed.latestDate, "2026-11-24")
  assert.deepEqual(formatTokenUsage(parsed), [
    { label: "Today", value: "not reported" },
    { label: "This week", value: "20 tokens" },
    { label: "This month", value: "20 tokens" },
  ])
})

test("reported zero activity is displayed as zero, not missing data", () => {
  const parsed = parseTokenUsage(tokenProfile([["2026-11-25", 0]]), NOW)
  assert.equal(parsed.today, 0)
  assert.equal(parsed.week, 0)
  assert.equal(parsed.month, 0)
  assert.equal(formatTokenUsage(parsed)[0].value, "0 tokens")
})

test("empty and old token records do not invent current-period totals", () => {
  for (const buckets of [[], [["2026-10-01", 100]], [["2026-11-26", 100]]]) {
    const parsed = parseTokenUsage(tokenProfile(buckets), NOW)
    assert.equal(parsed.today, undefined)
    assert.equal(parsed.week, undefined)
    assert.equal(parsed.month, undefined)
  }
})

test("week-to-date can cross a month and year boundary", () => {
  const parsed = parseTokenUsage(tokenProfile([
    ["2025-12-28", 500],
    ["2025-12-29", 100],
    ["2025-12-31", 50],
    ["2026-01-01", 25],
  ]), Date.parse("2026-01-01T00:00:00Z"))
  assert.equal(parsed.weekStart, "2025-12-29")
  assert.equal(parsed.week, 175)
  assert.equal(parsed.month, 25)
  assert.equal(parsed.today, 25)
})

test("UTC dates are stable across local timezone offsets and Sunday/Monday boundaries", () => {
  const buckets = tokenProfile([["2026-11-22", 50], ["2026-11-23", 10]])
  const sunday = parseTokenUsage(buckets, Date.parse("2026-11-22T23:59:59Z"))
  assert.equal(sunday.weekStart, "2026-11-16")
  assert.equal(sunday.week, 50)
  const monday = parseTokenUsage(buckets, Date.parse("2026-11-22T20:00:00-05:00"))
  assert.equal(monday.todayDate, "2026-11-23")
  assert.equal(monday.weekStart, "2026-11-23")
  assert.equal(monday.week, 10)
})

test("a record remains available when UTC midnight moves it out of today and this month", () => {
  const profile = tokenProfile([["2026-12-31", 1234]])
  const before = parseTokenUsage(profile, Date.parse("2026-12-31T23:59:59.999Z"))
  const after = parseTokenUsage(profile, Date.parse("2027-01-01T00:00:00Z"))
  assert.equal(before.today, 1234)
  assert.equal(after.today, undefined)
  assert.equal(after.week, 1234)
  assert.equal(after.month, undefined)
  assert.equal(after.latestDate, before.latestDate)
})

test("missing daily buckets, malformed dates, invalid numbers, and duplicates are rejected", () => {
  for (const data of [
    null,
    {},
    { dailyUsageBuckets: null },
    { dailyUsageBuckets: {} },
    { dailyUsageBuckets: [null] },
    tokenProfile([["2026-02-30", 10]]),
    tokenProfile([["2026-1-01", 10]]),
    tokenProfile([["bad", 10]]),
    tokenProfile([["2026-11-25", -1]]),
    tokenProfile([["2026-11-25", 1.5]]),
    tokenProfile([["2026-11-25", "10"]]),
    tokenProfile([["2026-11-25", Number.POSITIVE_INFINITY]]),
    tokenProfile([["2026-11-25", Number.MAX_SAFE_INTEGER + 1]]),
    tokenProfile([["2026-11-25", 10], ["2026-11-25", 20]]),
    tokenProfile([["2026-11-24", Number.MAX_SAFE_INTEGER], ["2026-11-25", 1]]),
  ]) {
    assert.ok(parseTokenUsage(data, NOW).error)
  }
})

test("the popup uses exact counts while the footer uses compact month-to-date tokens", () => {
  const parsed = parseTokenUsage(tokenProfile([["2026-11-24", 19263142]]), NOW)
  assert.equal(formatTokenUsage(parsed)[2].value, "19,263,142 tokens")
  assert.equal(formatUsageSummary({ windows: [], tokenUsage: parsed }), "Codex MTD 19.3M tokens")
  assert.equal(
    formatUsageSummary({ windows: [{ shortLabel: "5h", percent: 5 }], tokenUsage: parsed }),
    "Codex 5h5%",
  )
})
