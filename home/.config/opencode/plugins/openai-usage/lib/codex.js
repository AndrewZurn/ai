// Spawns the local `codex app-server` and reads rate limits and account token
// activity over its stdio JSON-RPC transport. Uses the existing Codex sign-in,
// so no API key or token is read or stored here.
//
// Returns a Promise that resolves to either:
//   { windows: Window[], tokenUsage?, planType?, credits?, individualLimit?,
//     spendControlReached?, reachedType?, resetCredits?,
//     rateLimitsError?, tokenUsageError? } on success (partial data is allowed)
//   { windows: [], error: string } on failure
// It never rejects.

import { spawn } from "node:child_process"
import readline from "node:readline"
import { parseRateLimits, parseTokenUsage } from "./usage-core.js"

const CLIENT_INFO = {
  name: "opencode-openai-usage",
  title: "OpenCode OpenAI Usage",
  version: "0.1.0",
}

const ACCOUNT_METADATA_TIMEOUT_MS = 1_000

export function queryRateLimits({ codexBin = "codex", timeoutMs = 15_000, env = process.env } = {}) {
  return new Promise((resolve) => {
    let proc
    let settled = false
    let limits
    let tokenUsage
    let rateLimitsError
    let tokenUsageError
    let limitsDone = false
    let tokensDone = false
    let accountDone = true
    let accountTimer
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(accountTimer)
      try {
        proc?.stdin?.end()
      } catch {}
      try {
        proc?.kill()
      } catch {}
      resolve(result)
    }

    const result = () => {
      const data = { ...(limits ?? { windows: [] }), tokenUsage, rateLimitsError, tokenUsageError }
      if (!limits && !tokenUsage) {
        data.error = [rateLimitsError, tokenUsageError].filter(Boolean).join(" ")
      }
      return data
    }
    const finishPartial = (message) => {
      if (!limits && !tokenUsage) {
        finish({ windows: [], error: message })
        return
      }
      if (!limitsDone) rateLimitsError = message
      if (!tokensDone) tokenUsageError = message
      finish(result())
    }
    const maybeFinish = () => {
      if (limitsDone && tokensDone && accountDone) finish(result())
    }
    const timer = setTimeout(
      () => finishPartial("Codex usage request timed out."),
      timeoutMs,
    )

    try {
      proc = spawn(codexBin, ["app-server"], { stdio: ["pipe", "pipe", "ignore"], env })
    } catch (err) {
      finish({ windows: [], error: `Failed to start codex: ${err instanceof Error ? err.message : String(err)}` })
      return
    }

    proc.on("error", (err) => {
      const message =
        err && err.code === "ENOENT"
          ? "codex CLI not found on PATH. Install Codex (https://github.com/openai/codex) and sign in."
          : `Failed to start codex: ${err instanceof Error ? err.message : String(err)}`
      finishPartial(message)
    })

    if (!proc.stdout || !proc.stdin) {
      // spawn() reports failures such as ENOENT via the 'error' event above,
      // which owns the actionable message. Return without resolving; the
      // timeout backstops the case where no event ever arrives.
      return
    }

    const rl = readline.createInterface({ input: proc.stdout })
    const send = (message) => {
      try {
        proc.stdin.write(`${JSON.stringify(message)}\n`)
      } catch {}
    }
    // Pipe errors are asynchronous, so write()'s try/catch is not sufficient.
    proc.stdin.on("error", () => finishPartial("Codex closed the usage request pipe."))

    rl.on("line", (line) => {
      if (settled) return
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (msg.id === 0) {
        if (msg.error) {
          const code = msg.error?.code ?? "unknown"
          const detail = msg.error?.message ? `: ${msg.error.message}` : ""
          finish({ windows: [], error: `codex rejected the app-server handshake (${code})${detail}.` })
          return
        }
        send({ method: "initialized", params: {} })
        send({ method: "account/rateLimits/read", id: 1 })
        send({ method: "account/usage/read", id: 3 })
        return
      }
      if (msg.id === 2 && !accountDone) {
        const planType = msg.result?.account?.planType
        if (typeof planType === "string" && planType) limits.planType = planType
        accountDone = true
        clearTimeout(accountTimer)
        maybeFinish()
        return
      }
      if (msg.id === 1 && !limitsDone) {
        limitsDone = true
        if (msg.error) {
          const code = msg.error?.code ?? "unknown"
          const detail = msg.error?.message ? `: ${msg.error.message}` : ""
          rateLimitsError = `Codex rejected the usage request (${code})${detail}. Check \`codex login status\` and the reported error.`
          maybeFinish()
          return
        }
        const parsed = parseRateLimits(msg.result)
        if (parsed.error) {
          rateLimitsError = `Could not read Codex rate limits: ${parsed.error}.`
          maybeFinish()
          return
        }
        limits = parsed
        if (!parsed.planType || parsed.planType === "unknown") {
          // Enterprise snapshots can omit the plan. Metadata is optional:
          // errors, exits, or a stalled lookup must not discard valid usage.
          accountDone = false
          accountTimer = setTimeout(() => {
            accountDone = true
            maybeFinish()
          }, ACCOUNT_METADATA_TIMEOUT_MS)
          send({ method: "account/read", id: 2, params: { refreshToken: false } })
          return
        }
        maybeFinish()
        return
      }
      if (msg.id === 3 && !tokensDone) {
        tokensDone = true
        if (msg.error) {
          const code = msg.error?.code ?? "unknown"
          const detail = msg.error?.message ? `: ${msg.error.message}` : ""
          tokenUsageError = `Codex rejected the token usage request (${code})${detail}.`
        } else {
          const parsed = parseTokenUsage(msg.result)
          if (parsed.error) tokenUsageError = parsed.error
          else tokenUsage = parsed
        }
        maybeFinish()
      }
    })

    proc.on("close", (code) => {
      if (!settled) {
        finishPartial(`codex exited before returning usage (code ${code ?? "unknown"}). Check your Codex version and configuration.`)
      }
    })

    send({
      method: "initialize",
      id: 0,
      params: { clientInfo: CLIENT_INFO },
    })
  })
}
