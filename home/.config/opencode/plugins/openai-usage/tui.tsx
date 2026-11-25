// CLI plugin for opencode: shows OpenAI Codex (ChatGPT) plan usage.
//
// 1. `/openai-usage` slash + palette command opens a popup with the Codex
//    rate-limit windows, monthly credit allowance when reported, and
//    today/week/month token activity with its latest reporting date.
// 2. A footer status segment (`Codex 5h 14% Wk 2%`) renders on
//    home.footer.status. The Codex allowance is account-level (tied to the
//    ChatGPT sign-in of the local `codex` CLI), so it shows regardless of the
//    selected OpenCode model.
//
// Data source: the local `codex app-server` account rate limits and usage
// JSON-RPC methods, which reuse the existing Codex sign-in — no credential
// handling here.

import { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import {
  clampPercent,
  formatCountdown,
  formatCredits,
  formatTokenUsage,
  formatUsageSummary,
} from "./lib/usage-core.js"
import { queryRateLimits } from "./lib/codex.js"

const FETCH_TIMEOUT_MS = 15_000
const CACHE_TTL_MS = 60_000
const POLL_INTERVAL_MS = 60_000
const BAR_WIDTH = 18

function usageColors(percent) {
  if (percent > 90) return ["#ef4444", "#f87171", "#fecaca"]
  if (percent > 50) return ["#eab308", "#facc15", "#fef08a"]
  return ["#22c55e", "#4ade80", "#bbf7d0"]
}

function titleCase(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : ""
}

function usageRow(window, wavePosition) {
  const percent = window ? `${clampPercent(window.percent)}%`.padStart(3) : "—%"
  const countdown = window ? formatCountdown(window.resetsAtSec) : "—"
  const filled = Math.round((clampPercent(window?.percent ?? 0) / 100) * BAR_WIDTH)
  const localWavePosition = filled > 0 ? wavePosition % filled : -1
  const colors = window ? usageColors(window.percent) : ["#737373", "#737373", "#737373"]
  const resetText = `resets ${countdown}`.padStart(16)

  return (
    <box flexDirection="row" marginBottom={1}>
      <text>{(window?.label ?? "").padEnd(12)}</text>
      <box flexDirection="row">
        {Array.from({ length: BAR_WIDTH }, (_, index) => {
          const isFilled = index < filled
          const isWavePeak = isFilled && index === localWavePosition
          const isWaveTrail = isFilled && index === localWavePosition - 1
          const color = isWavePeak ? colors[2] : isWaveTrail ? colors[1] : isFilled ? colors[0] : "#404040"
          return <text fg={color}>{isFilled ? "█" : "░"}</text>
        })}
      </box>
      <text>{` ${percent}`}</text>
      <text>{`  ${resetText}`}</text>
    </box>
  )
}

export default Plugin.define({
  id: "openai-usage",
  setup(context) {
    // Solid signal shared by the popup and footer slot. Kept local to the
    // plugin instance: usage is transient data, not plugin configuration.
    const [usage, setUsage] = createSignal(undefined)
    const [wavePosition, setWavePosition] = createSignal(0)

    let inFlight

    // Read Codex rate limits and token activity (60s cache). Errors are
    // surfaced through usage().error, never thrown.
    function refresh(force = false) {
      const current = usage()
      if (!force && current?.fetchedAt && Date.now() - current.fetchedAt < CACHE_TTL_MS) {
        return current
      }
      if (inFlight) return inFlight
      inFlight = (async () => {
        try {
          const result = await queryRateLimits({ timeoutMs: FETCH_TIMEOUT_MS })
          const next = { ...result, fetchedAt: Date.now() }
          setUsage(next)
          return next
        } catch (err) {
          // No fetchedAt on errors: the next poll should retry immediately
          // instead of serving a stale error from the cache.
          const next = {
            windows: [],
            error: err instanceof Error ? err.message : String(err),
          }
          setUsage(next)
          return next
        } finally {
          inFlight = undefined
        }
      })()
      return inFlight
    }

    // ─── /openai-usage: popup ────────────────────────────────────────────
    function showPopup() {
      void Promise.resolve()
        .then(() => refresh(true))
        .then((data) => {
          if (data?.error) {
            void context.ui.dialog.alert({
              title: "OpenAI Codex usage",
              message: data.error,
            })
            return
          }

          const windows = data?.windows ?? []
          const credits = formatCredits(data?.credits)
          const individualLimit = data?.individualLimit
          const tokenRows = data?.tokenUsage ? formatTokenUsage(data.tokenUsage) : []
          context.ui.dialog.set({ size: "large", centered: true })
          context.ui.dialog.show(
            () => (
              <box marginLeft={2} marginRight={2} marginBottom={1}>
                <box marginBottom={1}>
                  <text>OpenAI Codex Usage</text>
                </box>
                {windows.map((w) => usageRow(w, wavePosition()))}
                {individualLimit ? (
                  <box flexDirection="column" marginBottom={1}>
                    <text>{`Monthly credit allowance: ${clampPercent(individualLimit.remainingPercent)}% remaining`}</text>
                    {individualLimit.used !== undefined && individualLimit.limit !== undefined ? (
                      <text>{`${individualLimit.used} of ${individualLimit.limit} credits used`}</text>
                    ) : null}
                    {individualLimit.resetsAtSec !== undefined ? (
                      <text>{`Resets ${formatCountdown(individualLimit.resetsAtSec)}`}</text>
                    ) : null}
                  </box>
                ) : null}
                {windows.length === 0 && !individualLimit && !data?.rateLimitsError ? (
                  <box flexDirection="column" marginBottom={1}>
                    <text>Remaining allowance not reported by Codex CLI.</text>
                    <text>Detailed usage: https://chatgpt.com/codex/settings/usage</text>
                  </box>
                ) : null}
                {data?.rateLimitsError ? <text>{`Limits unavailable: ${data.rateLimitsError}`}</text> : null}
                {credits ? <text>{credits}</text> : null}
                {data?.spendControlReached ? <text>Workspace spend limit reached.</text> : null}
                {tokenRows.length > 0 ? (
                  <box flexDirection="column" marginTop={1}>
                    <text>Reported tokens (UTC dates; week starts Monday)</text>
                    {tokenRows.map((row) => <text>{`${row.label.padEnd(12)}${row.value}`}</text>)}
                    <text>{data.tokenUsage.latestDate
                      ? `Latest reported day: ${data.tokenUsage.latestDate}`
                      : "No dated token records returned."}</text>
                  </box>
                ) : null}
                {data?.tokenUsageError ? <text>{`Token usage unavailable: ${data.tokenUsageError}`}</text> : null}
                {data?.planType ? (
                  <box marginTop={1}>
                    <text>{`Plan: ${titleCase(data.planType)}`}</text>
                  </box>
                ) : null}
                {typeof data?.resetCredits === "number" && data.resetCredits > 0 ? (
                  <text>{`${data.resetCredits} free reset${data.resetCredits === 1 ? "" : "s"} available`}</text>
                ) : null}
                {data?.reachedType ? <text>{`Limit reached: ${data.reachedType}`}</text> : null}
                <box marginTop={1}>
                  <text>
                    {data?.fetchedAt
                      ? `fetched ${Math.max(1, Math.round((Date.now() - data.fetchedAt) / 1000))}s ago · escape to close`
                      : "no data · escape to close"}
                  </text>
                </box>
              </box>
            ),
          )
        })
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "openai.usage",
          title: "OpenAI Codex usage",
          group: "OpenAI",
          palette: true,
          suggested: true,
          slash: { name: "openai-usage" },
          enabled: () => true,
          run: async () => showPopup(),
        },
      ],
    }))

    // ─── footer status segment ───────────────────────────────────────────
    context.ui.slot({
      append: "home.footer.status",
      render: () => {
        const s = usage()
        if (s?.error) return <text>Codex ?</text>
        if (!s?.fetchedAt) return <text>{""}</text>
        return <text>{formatUsageSummary(s)}</text>
      },
    })

    // ─── polling ─────────────────────────────────────────────────────────
    // Poll every 60s so the footer stays current; the cache prevents
    // redundant fetches within the window.
    function tick() {
      void refresh()
    }

    const initial = setTimeout(tick, 2_000)
    const timer = setInterval(tick, POLL_INTERVAL_MS)
    const waveTimer = setInterval(
      () => setWavePosition((position) => (position + 1) % BAR_WIDTH),
      140,
    )

    return () => {
      clearTimeout(initial)
      clearInterval(timer)
      clearInterval(waveTimer)
    }
  },
})
