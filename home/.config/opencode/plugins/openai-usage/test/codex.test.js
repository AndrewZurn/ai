// Exercise the real stdio transport with a local fake CLI, not a real account.
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { queryRateLimits } from "../lib/codex.js"

const WORK_LIMITS = {
  rateLimits: {
    primary: null,
    secondary: null,
    planType: "unknown",
    credits: { hasCredits: true, unlimited: false, balance: null },
    spendControlReached: false,
  },
}

const WINDOW_LIMITS = {
  rateLimits: {
    primary: { usedPercent: 14, windowDurationMins: 300 },
    secondary: { usedPercent: 2, windowDurationMins: 10080 },
    planType: "plus",
  },
}

const TOKEN_USAGE = {
  summary: { lifetimeTokens: 987654321 },
  dailyUsageBuckets: [{ startDate: new Date().toISOString().slice(0, 10), tokens: 1234 }],
}

function assertTokenActivity(result) {
  const bucket = TOKEN_USAGE.dailyUsageBuckets[0]
  assert.equal(result.tokenUsage.latestDate, bucket.startDate)
  // The fixture can become yesterday (or last month) while the suite runs.
  // Check counts only for calendar periods that still contain its date.
  for (const period of ["today", "week", "month"]) {
    if (result.tokenUsage[period] !== undefined) {
      assert.equal(result.tokenUsage[period], bucket.tokens)
    }
  }
}

function fakeCodex(t, { replies = {}, exitOn, hangOn, delays = {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "openai-usage-test-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const codexBin = join(directory, "codex")
  const requestsFile = join(directory, "requests.jsonl")
  writeFileSync(requestsFile, "")
  writeFileSync(codexBin, `#!/usr/bin/env node
import { appendFileSync } from "node:fs"
import readline from "node:readline"
const config = JSON.parse(process.env.USAGE_TEST_CONFIG)
if (process.argv[2] !== "app-server") process.exit(2)
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line)
  appendFileSync(process.env.USAGE_TEST_REQUESTS, line + "\\n")
  if (request.method === config.exitOn) process.exit(3)
  const hangs = Array.isArray(config.hangOn) ? config.hangOn : [config.hangOn]
  if (hangs.includes(request.method) || request.id === undefined) return
  const reply = config.replies[request.method] ?? { error: { code: -32601, message: "Method not found" } }
  setTimeout(() => process.stdout.write(JSON.stringify({ id: request.id, ...reply }) + "\\n"), config.delays[request.method] ?? 0)
})
`, { mode: 0o700 })
  const config = {
    exitOn,
    hangOn,
    delays,
    replies: {
      initialize: { result: {} },
      "account/read": {
        result: {
          account: { type: "chatgpt", planType: "enterprise", email: "not-retained@example.invalid" },
          requiresOpenaiAuth: true,
        },
      },
      "account/rateLimits/read": { result: WORK_LIMITS },
      "account/usage/read": { result: TOKEN_USAGE },
      ...replies,
    },
  }
  return {
    directory,
    query: (options = {}) => queryRateLimits({
      codexBin,
      timeoutMs: 5_000,
      env: {
        PATH: process.env.PATH,
        USAGE_TEST_CONFIG: JSON.stringify(config),
        USAGE_TEST_REQUESTS: requestsFile,
      },
      ...options,
    }),
    requests: () => readFileSync(requestsFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse),
  }
}

test("queryRateLimits accepts Enterprise credits and fills an unknown plan from account metadata", async (t) => {
  const cli = fakeCodex(t)
  const result = await cli.query()
  assert.equal(result.error, undefined)
  assert.equal(result.planType, "enterprise")
  assert.deepEqual(result.windows, [])
  assert.deepEqual(result.credits, { hasCredits: true, unlimited: false, balance: undefined })
  assert.equal(result.spendControlReached, false)
  assertTokenActivity(result)
  assert.equal(JSON.stringify(result).includes("not-retained"), false)
  assert.equal(JSON.stringify(result).includes("lifetime"), false)
  assert.equal(JSON.stringify(result).includes("987654321"), false)
  assert.deepEqual(cli.requests().map((request) => request.method), [
    "initialize",
    "initialized",
    "account/rateLimits/read",
    "account/usage/read",
    "account/read",
  ])
  assert.deepEqual(cli.requests()[4].params, { refreshToken: false })
})

test("a known snapshot plan preserves windows without requesting account metadata", async (t) => {
  const cli = fakeCodex(t, {
    replies: { "account/rateLimits/read": { result: WINDOW_LIMITS } },
  })
  const result = await cli.query()
  assert.equal(result.error, undefined)
  assert.equal(result.planType, "plus")
  assert.deepEqual(result.windows.map((window) => window.percent), [14, 2])
  assert.equal(cli.requests().some((request) => request.method === "account/read"), false)
})

test("account metadata also fills a missing snapshot plan", async (t) => {
  const cli = fakeCodex(t, {
    replies: {
      "account/rateLimits/read": { result: { rateLimits: { primary: null, secondary: null } } },
    },
  })
  const result = await cli.query()
  assert.equal(result.error, undefined)
  assert.equal(result.planType, "enterprise")
})

test("account metadata errors do not prevent a usage query", async (t) => {
  const cli = fakeCodex(t, {
    replies: { "account/read": { error: { code: -32601, message: "Method not found" } } },
  })
  const result = await cli.query()
  assert.equal(result.error, undefined)
  assert.equal(result.planType, "unknown")
  assert.deepEqual(result.windows, [])
})

test("a hung optional metadata lookup returns valid usage within its own short bound", { timeout: 3_000 }, async (t) => {
  const cli = fakeCodex(t, { hangOn: "account/read" })
  const result = await cli.query()
  assert.equal(result.error, undefined)
  assert.equal(result.planType, "unknown")
  assert.deepEqual(result.credits, { hasCredits: true, unlimited: false, balance: undefined })
  assert.deepEqual(cli.requests().map((request) => request.method), [
    "initialize",
    "initialized",
    "account/rateLimits/read",
    "account/usage/read",
    "account/read",
  ])
})

test("the overall deadline preserves usage received before metadata stalled", async (t) => {
  const cli = fakeCodex(t, { hangOn: "account/read" })
  const result = await cli.query({ timeoutMs: 750 })
  assert.equal(result.error, undefined)
  assert.equal(result.planType, "unknown")
  assert.equal(result.credits.hasCredits, true)
})

test("exiting during optional metadata lookup preserves valid usage", async (t) => {
  const cli = fakeCodex(t, { exitOn: "account/read" })
  const result = await cli.query()
  assert.equal(result.error, undefined)
  assert.equal(result.planType, "unknown")
  assert.equal(result.credits.hasCredits, true)
})

test("malformed limits preserve tokens and report a parsing error, not a login instruction", async (t) => {
  const cli = fakeCodex(t, {
    replies: { "account/rateLimits/read": { result: { rateLimits: {} } } },
  })
  const result = await cli.query()
  assert.equal(result.error, undefined)
  assertTokenActivity(result)
  assert.match(result.rateLimitsError, /missing usage windows/)
  assert.doesNotMatch(result.rateLimitsError, /sign.in|codex login/i)
})

test("usage request errors preserve the server error", async (t) => {
  const cli = fakeCodex(t, {
    replies: {
      "account/rateLimits/read": { error: { code: -32000, message: "Quota service unavailable" } },
    },
  })
  const result = await cli.query()
  assert.equal(result.error, undefined)
  assert.match(result.rateLimitsError, /-32000.*Quota service unavailable/)
  assert.doesNotMatch(result.rateLimitsError, /Make sure Codex is signed in/)
  assertTokenActivity(result)
})

test("handshake rejection stops before account requests", async (t) => {
  const cli = fakeCodex(t, {
    replies: { initialize: { error: { code: -32600, message: "Unsupported client" } } },
  })
  const result = await cli.query()
  assert.match(result.error, /handshake.*-32600.*Unsupported client/)
  assert.equal(cli.requests().length, 1)
})

test("early exit produces a configuration error, not a login instruction", async (t) => {
  const cli = fakeCodex(t, { exitOn: "account/rateLimits/read" })
  const result = await cli.query()
  assert.match(result.error, /exited before returning usage \(code 3\)/)
  assert.doesNotMatch(result.error, /codex login/)
})

test("a hung limits query preserves tokens and reports a partial timeout", async (t) => {
  const cli = fakeCodex(t, { hangOn: "account/rateLimits/read" })
  const result = await cli.query({ timeoutMs: 750 })
  assert.equal(result.error, undefined)
  assertTokenActivity(result)
  assert.match(result.rateLimitsError, /timed out/)
})

test("a missing CLI produces the installation message", async (t) => {
  const cli = fakeCodex(t)
  const result = await cli.query({ codexBin: join(cli.directory, "not-installed") })
  assert.match(result.error, /CLI not found on PATH/)
})

test("an unsupported token endpoint preserves rate limits with a warning", async (t) => {
  const cli = fakeCodex(t, {
    replies: { "account/usage/read": { error: { code: -32601, message: "Method not found" } } },
  })
  const result = await cli.query()
  assert.equal(result.error, undefined)
  assert.equal(result.planType, "enterprise")
  assert.equal(result.credits.hasCredits, true)
  assert.equal(result.tokenUsage, undefined)
  assert.match(result.tokenUsageError, /-32601.*Method not found/)
})

test("invalid token records do not hide valid limits", async (t) => {
  const cli = fakeCodex(t, {
    replies: { "account/usage/read": { result: { dailyUsageBuckets: [{ startDate: "bad", tokens: -1 }] } } },
  })
  const result = await cli.query()
  assert.equal(result.error, undefined)
  assert.equal(result.credits.hasCredits, true)
  assert.match(result.tokenUsageError, /invalid/)
})

test("a hung token endpoint preserves limits at the deadline", async (t) => {
  const cli = fakeCodex(t, { hangOn: "account/usage/read" })
  const result = await cli.query({ timeoutMs: 750 })
  assert.equal(result.error, undefined)
  assert.equal(result.planType, "enterprise")
  assert.equal(result.credits.hasCredits, true)
  assert.match(result.tokenUsageError, /timed out/)
})

test("failure of both usage methods produces a combined error", async (t) => {
  const cli = fakeCodex(t, {
    replies: {
      "account/rateLimits/read": { error: { code: -32000, message: "Limits unavailable" } },
      "account/usage/read": { error: { code: -32001, message: "Tokens unavailable" } },
    },
  })
  const result = await cli.query()
  assert.deepEqual(result.windows, [])
  assert.match(result.error, /Limits unavailable/)
  assert.match(result.error, /Tokens unavailable/)
})

test("a hung CLI with no usage data produces a timeout error", async (t) => {
  const cli = fakeCodex(t, { hangOn: ["account/rateLimits/read", "account/usage/read"] })
  const result = await cli.query({ timeoutMs: 750 })
  assert.match(result.error, /timed out/)
})

test("token replies can arrive before limits and optional account metadata", async (t) => {
  const cli = fakeCodex(t, { delays: { "account/rateLimits/read": 150 } })
  const result = await cli.query()
  assert.equal(result.error, undefined)
  assertTokenActivity(result)
  assert.equal(result.planType, "enterprise")
})

test("an app-reported monthly percentage is preserved with token totals", async (t) => {
  const cli = fakeCodex(t, {
    replies: {
      "account/rateLimits/read": {
        result: {
          rateLimits: {
            ...WORK_LIMITS.rateLimits,
            individualLimit: { remainingPercent: 95, used: "5", limit: "100", resetsAt: 1796083200 },
          },
        },
      },
    },
  })
  const result = await cli.query()
  assert.equal(result.error, undefined)
  assert.equal(result.individualLimit.remainingPercent, 95)
  assertTokenActivity(result)
})
