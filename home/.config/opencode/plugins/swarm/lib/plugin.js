import { SwarmController } from "./controller.js"
import { inputs } from "./protocol.js"
import { repository } from "./snapshot.js"

function readOnlyGit(command) {
  if (!/^[A-Za-z0-9_./:@^~+= -]+$/.test(command)) return false
  const [git, operation, ...args] = command.split(/ +/)
  if (git !== "git" || !["diff", "status", "log"].includes(operation)) return false
  const flags = {
    diff: /^(--(?:no-ext-diff|no-textconv|cached|staged|stat|name-only|name-status|numstat|shortstat|check|binary|no-color)|-U[0-9]+|--unified=[0-9]+)$/,
    status: /^(--(?:short|porcelain|branch|untracked-files|ignored)|-[sb])$/,
    log: /^(--(?:oneline|stat|name-only|name-status|no-color)|--max-count=[0-9]+|-[0-9]+)$/,
  }
  // Do not execute repository-configured diff helpers during a read-only review.
  const options = args.slice(0, args.includes("--") ? args.indexOf("--") : args.length)
  if (operation === "diff" &&
    !(options.includes("--no-ext-diff") && options.includes("--no-textconv"))) return false
  let paths = false
  return args.every(arg => {
    if (arg === "--") { paths = true; return true }
    return paths || !arg.startsWith("-") || flags[operation].test(arg)
  })
}

function view(run) {
  const { jobs, sessions, files, skills, permissions, context, ...status } = run
  return JSON.stringify(status, null, 2)
}

export async function setup(ctx, dependencies = {}) {
    // Global plugins also load outside repositories. Do not change those sessions.
    let directory
    try {
      directory = await repository(ctx.location.directory)
    } catch {
      return
    }
    const gate = new SwarmController(ctx, directory, {
      maxRounds: ctx.options.maxRounds,
      timeout: ctx.options.timeoutMinutes === undefined ? undefined : ctx.options.timeoutMinutes * 60_000,
      ...dependencies,
    })

    // Markdown creates the builder ID; derive its base prompt and permissions
    // from the resolved Build definition, without assigning a shared model.
    await ctx.agent.transform(editor => {
      const build = editor.get("build")
      if (!build || !editor.get("builder")) return
      editor.update("builder", agent => {
        agent.system = build.system
        agent.instructions = build.instructions
        agent.permissions = [
          ...build.permissions,
          { action: "subagent", resource: "*", effect: "deny" },
        ]
      })
    })

    await ctx.tool.transform(editor => {
      for (const [name, input] of Object.entries(inputs)) {
        editor.add({
          name: `swarm_${name}`,
          description: {
            start: "Start the mandatory builder and three-reviewer workflow in an orchestrator session.",
            status: "Read authoritative swarm state and recheck candidate contents.",
            triage: "Orchestrator only: classify every open finding as fix or propose dismissal, with reasons.",
            candidate: "Builder only: submit a candidate and a response to every open finding, then stop.",
            report: "Registered reviewer only: submit findings, resolution decisions, and a verdict.",
            report_html: "Orchestrator only: turn the approved ledger into an HTML summary in .swarms and open it in the browser.",
          }[name],
          input,
          options: { codemode: false },
          execute: async (input, context) => ({
            content: view(await gate.tool(name, input, context.sessionID,
              name === "report_html" ? context.signal : undefined)),
          }),
        })
      }
    })

    await ctx.command.transform(editor => {
      editor.add({
        name: "swarm",
        description: "Build a task and require approval from all three reviewers",
        execute: async ({ sessionID, prompt }) => {
          if (!prompt.text.trim()) throw new Error("Usage: /swarm <task and acceptance criteria>")
          await ctx.session.switchAgent({ sessionID, agent: "orchestrator" })
          await gate.start(sessionID, prompt.text, prompt)
        },
      })
      for (const command of ["status", "resume", "cancel"]) {
        editor.add({
          name: `swarm-${command}`,
          description: `${command} the current swarm run`,
          execute: async ({ sessionID }) => {
            const run = command === "status"
              ? await gate.tool("status", {}, sessionID)
              : await gate.control(sessionID, command)
            await ctx.session.synthetic({ sessionID, text: view(run) })
          },
        })
      }
    })

    await ctx.session.hook("prompt", async event => {
      await gate.externalPrompt(event.sessionID, event.messageID, event.prompt, event.metadata)
    })
    await ctx.session.hook("context", async event => {
      const state = await gate.inspect(event.sessionID)
      if (event.agent === "orchestrator") {
        event.system.push({
          type: "text",
          text: "Coordinate through swarm_start, swarm_status, swarm_triage, and swarm_report_html. The plugin launches the builder and reviewers. During TRIAGING, classify every finding with a reason; only its owner can accept dismissal. During REPORTING, read the authoritative ledger and call swarm_report_html with reportRequest.id, candidate.id, a title, accurate summary, and limitations. The plugin writes repository-root/.swarms and opens the HTML in the browser. Do not edit or open files yourself. An idle turn or three review verdicts alone are not task completion: wait for APPROVED with htmlReport.path, link that file, and mention any browser error. Otherwise report waiting, triage, reporting, or blocked. New task input blocks the run; use /swarm-resume after clarification.",
        })
      }
      if (!state.role) return
      event.system.push({
        type: "text",
        text: `Mandatory review gate: role=${state.role}, phase=${state.phase}. Use swarm_status for the complete ledger. Orchestrator: own triage through swarm_triage; never close findings or override reviewers. Builder: implement only during BUILDING and follow orchestrator fix/dismiss decisions; submit swarm_candidate then stop. Reviewer: submit swarm_report then stop; only you may resolve or accept dismissal of your findings. All participants: never launch subagents. The normal optional adversarial-review prompt does not apply to this enrolled workflow.`,
      })
      // Limit tools as guidance, not as the authentication boundary. Executors
      // and the permission hook below recheck state at execution time.
      if (state.role !== "orchestrator" && (state.submitted ||
        ["BLOCKED", "CANCELLED", "APPROVED", "HANDOFF", "REVIEW_HANDOFF", "TRIAGING", "REPORTING"].includes(state.phase))) {
        for (const name of Object.keys(event.tools)) {
          if (name !== "swarm_status") delete event.tools[name]
        }
      }
    })
    await ctx.permission.hook("evaluate", async event => {
      const state = await gate.inspect(event.sessionID)
      if (!state.role) return
      if (["edit", "shell"].includes(event.action)) {
        const build = state.role === "builder" && state.phase === "BUILDING" && !state.submitted
        const test = state.role === "test-engineer" && state.phase === "REVIEWING" && !state.submitted
        const readOnlyReview = ["adversarial-reviewer", "specification-reviewer"].includes(state.role) &&
          state.phase === "REVIEWING" && !state.submitted && event.action === "shell" &&
          event.resources.length > 0 && event.resources.every(readOnlyGit)
        if (!(build || readOnlyReview || (test && event.action === "shell"))) {
          event.effect = "deny"
          event.message = "Swarm: only the active builder may edit; reviewers may only run permitted checks during review."
        } else if (test && event.action === "shell") {
          event.effect = "ask"
          event.message = "Approve this exploratory check. Use an isolated temporary directory; do not change candidate files."
        }
      }
    })
    await ctx.tool.hook("execute.before", async event => {
      if (event.tool !== "subagent") return
      const state = await gate.inspect(event.sessionID)
      if (state.role) throw new Error("The swarm controller owns all agent dispatch.")
    })

    const abort = new AbortController()
    const recover = () => gate.reconcile().catch(error => gate.fail(error))
      .catch(error => console.error("swarm recovery failed", error))
    const stream = (async () => {
      for await (const event of ctx.event.subscribe({
        types: ["session.execution.succeeded", "session.execution.failed",
          "session.execution.interrupted", "session.agent.selected", "session.moved", "filesystem.changed"],
        signal: abort.signal,
      })) {
        if (event.location?.directory !== ctx.location.directory) continue
        // Do not await session operations in the event consumer: dispatch and
        // interruption can themselves publish events on this stream.
        void recover()
      }
    })().catch(error => {
      if (!abort.signal.aborted) return gate.fail(error)
    })
    const timer = setInterval(() => void recover(), 30_000)
    timer.unref?.()
    await recover()
    return async () => {
      clearInterval(timer)
      abort.abort()
      await stream
    }
}
