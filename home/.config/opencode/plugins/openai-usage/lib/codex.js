// Spawns the local `codex app-server` and reads `account/rateLimits/read`
// over its stdio JSON-RPC transport. Uses the existing Codex sign-in, so no
// API key or token is read or stored here.
//
// Returns a Promise that resolves to either:
//   { windows: Window[], planType?, reachedType?, resetCredits? } on success
//   { windows: [], error: string } on failure
// It never rejects.

import { spawn } from "node:child_process"
import readline from "node:readline"
import { parseRateLimits } from "./usage-core.js"

const CLIENT_INFO = {
  name: "opencode-openai-usage",
  title: "OpenCode OpenAI Usage",
  version: "0.1.0",
}

export function queryRateLimits({ codexBin = "codex", timeoutMs = 15_000, env = process.env } = {}) {
  return new Promise((resolve) => {
    let proc
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      try {
        proc?.stdin?.end()
      } catch {}
      try {
        proc?.kill()
      } catch {}
      resolve(result)
    }

    const timer = setTimeout(() => finish({ windows: [], error: "Codex usage request timed out." }), timeoutMs)

    try {
      proc = spawn(codexBin, ["app-server"], { stdio: ["pipe", "pipe", "ignore"], env })
    } catch (err) {
      clearTimeout(timer)
      finish({ windows: [], error: `Failed to start codex: ${err instanceof Error ? err.message : String(err)}` })
      return
    }

    proc.on("error", (err) => {
      clearTimeout(timer)
      const message =
        err && err.code === "ENOENT"
          ? "codex CLI not found on PATH. Install Codex (https://github.com/openai/codex) and sign in."
          : `Failed to start codex: ${err instanceof Error ? err.message : String(err)}`
      finish({ windows: [], error: message })
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

    rl.on("line", (line) => {
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (msg.id === 0) {
        if (msg.error) {
          clearTimeout(timer)
          const code = msg.error?.code ?? "unknown"
          const detail = msg.error?.message ? `: ${msg.error.message}` : ""
          finish({ windows: [], error: `codex rejected the app-server handshake (${code})${detail}.` })
          return
        }
        send({ method: "initialized", params: {} })
        send({ method: "account/rateLimits/read", id: 1 })
        return
      }
      if (msg.id === 1) {
        clearTimeout(timer)
        if (msg.error) {
          const code = msg.error?.code ?? "unknown"
          const detail = msg.error?.message ? `: ${msg.error.message}` : ""
          finish({
            windows: [],
            error: `Codex rejected the usage request (${code})${detail}. Make sure Codex is signed in (\`codex login\`).`,
          })
          return
        }
        const parsed = parseRateLimits(msg.result)
        if (parsed.error) {
          finish({
            windows: [],
            error: "Could not read Codex rate limits — ensure Codex is signed in (`codex login`).",
          })
          return
        }
        finish(parsed)
      }
    })

    proc.on("close", (code) => {
      clearTimeout(timer)
      if (!settled) {
        finish({
          windows: [],
          error: `codex exited before returning usage (code ${code ?? "unknown"}). Is Codex signed in? Run \`codex login\`.`,
        })
      }
    })

    send({
      method: "initialize",
      id: 0,
      params: { clientInfo: CLIENT_INFO },
    })
  })
}
