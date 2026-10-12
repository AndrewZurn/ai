// Unit tests for the go-usage plugin's pure helpers.
// Run: node --test <this file's dir>

import test from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  clampPercent,
  discoverApiKey,
  formatCountdown,
  parseUsageApi,
  renderBar,
} from "../lib/usage-core.js"

// ─── clampPercent ──────────────────────────────────────────────────────────

test("clampPercent rounds and clamps to 0–100", () => {
  assert.equal(clampPercent(0), 0)
  assert.equal(clampPercent(42.4), 42)
  assert.equal(clampPercent(42.6), 43)
  assert.equal(clampPercent(-5), 0)
  assert.equal(clampPercent(150), 100)
})

test("clampPercent maps non-finite input to 0", () => {
  assert.equal(clampPercent(Number.NaN), 0)
  assert.equal(clampPercent(undefined), 0)
})

// ─── renderBar ──────────────────────────────────────────────────────────────

test("renderBar fills proportionally to percent", () => {
  const bar = renderBar(50, 20)
  assert.equal(bar.length, 20)
  assert.equal(bar, "██████████░░░░░░░░░░")
  assert.equal(renderBar(0, 10).replace(/░/g, ""), "")
  assert.equal(renderBar(100, 10).replace(/█/g, ""), "")
  assert.equal(renderBar(0, 10), "░░░░░░░░░░")
  assert.equal(renderBar(100, 10), "██████████")
})

test("renderBar clamps out-of-range percents and respects width", () => {
  assert.equal(renderBar(200, 5), "█████")
  assert.equal(renderBar(-1, 5), "░░░░░")
  assert.equal(renderBar(50, 0), "")
})

// ─── formatCountdown ────────────────────────────────────────────────────────

test("formatCountdown formats future countdowns", () => {
  const now = Date.parse("2026-10-12T12:00:00Z")
  assert.equal(formatCountdown("2026-10-12T14:00:00Z", now), "2h")
  assert.equal(formatCountdown("2026-10-12T13:30:00Z", now), "1h 30m")
  assert.equal(formatCountdown("2026-10-16T04:00:00Z", now), "3d 16h")
  assert.equal(formatCountdown("2026-11-01T00:00:00Z", now), "19d 12h")
})

test("formatCountdown handles expired, missing, and invalid input", () => {
  const now = Date.parse("2026-10-12T12:00:00Z")
  assert.equal(formatCountdown("2026-10-12T11:00:00Z", now), "now")
  assert.equal(formatCountdown(undefined), "—")
  assert.equal(formatCountdown(""), "—")
  assert.equal(formatCountdown("not-a-date"), "—")
})

// ─── parseUsageApi ──────────────────────────────────────────────────────────

test("parseUsageApi maps all three windows", () => {
  const parsed = parseUsageApi({
    usage: {
      rolling: { status: "ok", percent: 42.5, resetsAt: "2026-10-12T14:00:00Z" },
      weekly: { status: "ok", percent: 17, resetsAt: "2026-10-16T04:00:00Z" },
      monthly: { status: "ok", percent: 8, resetsAt: "2026-11-01T00:00:00Z" },
    },
  })
  assert.equal(parsed.error, undefined)
  assert.equal(parsed.rolling.percent, 42.5)
  assert.equal(parsed.weekly.percent, 17)
  assert.equal(parsed.monthly.percent, 8)
  assert.equal(parsed.rolling.resetsAt, "2026-10-12T14:00:00Z")
})

test("parseUsageApi accepts partial windows", () => {
  const parsed = parseUsageApi({
    usage: { weekly: { percent: 17 } },
  })
  assert.equal(parsed.error, undefined)
  assert.equal(parsed.weekly.percent, 17)
  assert.equal(parsed.rolling, null)
  assert.equal(parsed.monthly, null)
})

test("parseUsageApi reports errors for invalid shapes", () => {
  assert.ok(parseUsageApi(null).error)
  assert.ok(parseUsageApi({}).error)
  assert.ok(parseUsageApi({ usage: {} }).error)
  assert.ok(parseUsageApi({ usage: { rolling: { percent: "nope" } } }).error)
})

// ─── discoverApiKey ─────────────────────────────────────────────────────────

function writeAuthFixture(home, loadLocation, auth) {
  const dir = path.join(home, loadLocation, "opencode")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify(auth))
}

test("discoverApiKey reads the key from opencode auth.json", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "go-usage-test-"))
  try {
    writeAuthFixture(home, ".local/share", {
      opencode: { type: "wellknown", key: "other" },
      "opencode-go": { type: "api", key: " sk-go-1 " },
    })
    const key = discoverApiKey({ homedir: home, env: {} })
    assert.equal(key, "sk-go-1")
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test("discoverApiKey falls back to .config auth.json", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "go-usage-test-"))
  try {
    writeAuthFixture(home, ".config", {
      "opencode-go": { type: "api", key: "sk-go-2" },
    })
    const key = discoverApiKey({ homedir: home, env: {} })
    assert.equal(key, "sk-go-2")
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test("discoverApiKey prefers env override, then recovers from missing files", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "go-usage-test-"))
  try {
    assert.equal(discoverApiKey({ homedir: home, env: {} }), undefined)
    writeAuthFixture(home, ".config", {
      "opencode-go": { type: "api", key: "sk-file" },
    })
    assert.equal(
      discoverApiKey({ homedir: home, env: { OPENCODE_GO_API_KEY: "sk-env" } }),
      "sk-env",
    )
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
