// CLI plugin for opencode: shows OpenCode Go plan usage.
//
// 1. `/go-usage` slash + palette command opens a popup with Rolling (5h),
//    Weekly, and Monthly usage bars plus reset countdowns.
// 2. A footer status segment (`Go R42% W17% M8%`) renders on
//    home.footer.status whenever an opencode-go model is active.
//
// Data source: GET https://opencode.ai/zen/go/v1/usage (official endpoint,
// added via opencode#16513; public docs tracked in opencode#31084) with the
// opencode-go API key from opencode's auth.json. Key discovery and response
// parsing live in ./lib/usage-core.js; fetch orchestration (timeouts,
// status-code handling) stays here.
//
// Rendering is intentionally monochrome: verified theme-token names for
// success/warning/error colors are not documented, so text uses defaults
// and the ░/█ characters carry the visual load. Colors can be layered in
// once token names are confirmed.

import { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import {
  clampPercent,
  discoverApiKey,
  formatCountdown,
  parseUsageApi,
} from "./lib/usage-core.js"

const USAGE_URL = process.env.OPENCODE_GO_USAGE_URL || "https://opencode.ai/zen/go/v1/usage"
const FETCH_TIMEOUT_MS = 10_000
const CACHE_TTL_MS = 60_000
const POLL_INTERVAL_MS = 30_000
const BAR_WIDTH = 18

// Current model info shape is not pinned by the docs; look at every likely
// provider field so model switching stays reactive and correct.
function isGoModel(current) {
  if (!current || typeof current !== "object") return false
  const provider =
    current.providerID ?? current.provider ?? current.model?.providerID ?? ""
  return typeof provider === "string" && provider.startsWith("opencode-go")
}

function currentModel(context) {
  try {
    return context.ui.model.current()
  } catch {
    return undefined
  }
}

function usageColors(percent) {
  if (percent > 90) return ["#ef4444", "#f87171", "#fecaca"]
  if (percent > 50) return ["#eab308", "#facc15", "#fef08a"]
  return ["#22c55e", "#4ade80", "#bbf7d0"]
}

function usageRow(label, window, wavePosition) {
  const percent = window ? `${clampPercent(window.percent)}%`.padStart(3) : "—%"
  const countdown = window ? formatCountdown(window.resetsAt) : "—"
  const filled = Math.round((clampPercent(window?.percent ?? 0) / 100) * BAR_WIDTH)
  const localWavePosition = filled > 0 ? wavePosition % filled : -1
  const colors = window ? usageColors(window.percent) : ["#737373", "#737373", "#737373"]
  const resetText = `resets ${countdown}`.padStart(16)

  return (
    <box flexDirection="row" marginBottom={1}>
      <text>{label.padEnd(12)}</text>
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
  id: "go-usage",
  setup(context) {
    // Solid signal shared by the popup and footer slot. Keep this local to
    // the plugin instance: usage is transient data, not plugin configuration.
    const [usage, setUsage] = createSignal(undefined)
    const [wavePosition, setWavePosition] = createSignal(0)

    let inFlight

    // Fetch usage (60s cache) and publish the result to the signal. Errors
    // are surfaced to the caller through usage().error, never thrown.
    function refresh(force = false) {
      const current = usage()
      if (!force && current?.fetchedAt && Date.now() - current.fetchedAt < CACHE_TTL_MS) {
        return current
      }
      if (inFlight) return inFlight
      inFlight = (async () => {
        try {
          const key = discoverApiKey()
          if (!key) {
            const result = {
              rolling: null,
              weekly: null,
              monthly: null,
              error: "No opencode-go API key found. Run /connect and select OpenCode Go, then paste your key.",
            }
            setUsage(result)
            return result
          }

          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
          try {
            const resp = await fetch(USAGE_URL, {
              headers: { Authorization: `Bearer ${key}` },
              signal: controller.signal,
            })
            if (resp.status === 401) {
              const result = {
                rolling: null,
                weekly: null,
                monthly: null,
                error: "Usage API rejected the key (401) — run /connect and re-enter your OpenCode Go key.",
              }
              setUsage(result)
              return result
            }
            if (resp.status === 403) {
              const result = {
                rolling: null,
                weekly: null,
                monthly: null,
                error: "This key is not entitled to the OpenCode Go plan (403).",
              }
              setUsage(result)
              return result
            }
            if (!resp.ok) {
              const result = {
                rolling: null,
                weekly: null,
                monthly: null,
                error: `Usage API returned HTTP ${resp.status}.`,
              }
              setUsage(result)
              return result
            }

            const parsed = parseUsageApi(await resp.json())
            if (parsed.error) {
              const result = {
                rolling: null,
                weekly: null,
                monthly: null,
                error: parsed.error,
              }
              setUsage(result)
              return result
            }
            const result = {
              rolling: parsed.rolling,
              weekly: parsed.weekly,
              monthly: parsed.monthly,
              error: undefined,
              fetchedAt: Date.now(),
            }
            setUsage(result)
            return result
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            const result = {
              rolling: null,
              weekly: null,
              monthly: null,
              error: /abort/i.test(message)
                ? "Usage request timed out."
                : `Usage fetch failed: ${message}`,
            }
            setUsage(result)
            return result
          } finally {
            clearTimeout(timer)
          }
        } finally {
          inFlight = undefined
        }
      })()
      return inFlight
    }

    // ─── /go-usage: popup ────────────────────────────────────────────────
    function showPopup() {
      void Promise.resolve()
        .then(() => refresh(true))
        .then((data) => {
          if (data?.error) {
            void context.ui.dialog.alert({
              title: "OpenCode Go usage",
              message: data.error,
            })
            return
          }

          context.ui.dialog.set({ size: "large", centered: true })
          context.ui.dialog.show(
            () => (
              <box marginLeft={2} marginRight={2} marginBottom={1}>
                <box marginBottom={1}>
                  <text>OpenCode Go Usage</text>
                </box>
                {usageRow("Rolling (5h)", data?.rolling, wavePosition())}
                {usageRow("Weekly", data?.weekly, wavePosition())}
                {usageRow("Monthly", data?.monthly, wavePosition())}
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
          id: "go.usage",
          title: "OpenCode Go usage",
          group: "Go",
          palette: true,
          slash: { name: "go-usage" },
          enabled: () => true,
          run: async () => showPopup(),
        },
      ],
    }))

    // ─── footer status segment ───────────────────────────────────────────
    context.ui.slot({
      append: "home.footer.status",
      render: () => {
        if (!isGoModel(currentModel(context))) return <text>{""}</text>
        const s = usage()
        if (s?.error) return <text>Go {s.error.includes("No opencode-go") ? "?" : "!"}</text>
        if (!s?.fetchedAt) return <text>{""}</text>
        const seg = (name, w) => `${name}${clampPercent(w?.percent)}%`
        return (
          <text>
            {`Go ${seg("R", s.rolling)} ${seg("W", s.weekly)} ${seg("M", s.monthly)}`}
          </text>
        )
      },
    })

    // ─── polling ─────────────────────────────────────────────────────────
    // Poll every 30s so footer bars stay current; only fetch while a
    // opencode-go model is selected.
    function tick() {
      if (!isGoModel(currentModel(context))) return
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
