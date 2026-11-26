import { SwarmController } from "./controller.js"
import { inputs, requiredReviewers, uiReviewer } from "./protocol.js"
import { repository } from "./snapshot.js"
import { orchestratorInstructions } from "./instructions.js"
import { planCommand } from "./plan.js"
import { registerOperator } from "./operator.js"

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
  return JSON.stringify({ ...status, requiredReviewers: requiredReviewers(run) }, null, 2)
}

export async function setup(ctx, dependencies = {}) {
    let gate
    // The globally available orchestrator must fail closed even outside Git,
    // where controller tools and repository-specific hooks are not installed.
    await ctx.tool.hook("execute.before", async event => {
      if (event.tool !== "subagent") return
      const session = await ctx.session.get({ sessionID: event.sessionID })
      if (session.agent === "orchestrator" || (gate && (await gate.inspect(event.sessionID)).role)) {
        throw new Error("The swarm controller owns all agent dispatch.")
      }
    })

    // Other sessions outside repositories retain their normal behavior.
    let directory
    try {
      directory = await repository(ctx.location.directory)
    } catch {
      return
    }
    gate = new SwarmController(ctx, directory, {
      maxRounds: ctx.options.maxRounds,
      timeout: ctx.options.timeoutMinutes === undefined ? undefined : ctx.options.timeoutMinutes * 60_000,
      operationTimeout: ctx.options.operationTimeoutSeconds === undefined
        ? undefined : ctx.options.operationTimeoutSeconds * 1000,
      ...dependencies,
    })
    const dispatchTargets = new Set([
      "builder", ...Object.keys(gate.workflow?.reviewers ?? {}),
    ])
    if (dependencies.operatorRpc) await registerOperator(ctx, gate, dependencies.operatorRpc)

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
            start: "Enroll a required plan file for orchestrator review before any builder dispatch.",
            plan: "Orchestrator only: record plan review, targeted questions and user answers; release the builder only when the plan is clear.",
            select: "Orchestrator only: select specialists by description for this candidate; mandatory and selected reviewers run in parallel.",
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
              context.signal)),
          }),
        })
      }
    })

    await ctx.command.transform(editor => {
      editor.add({
        name: "swarm",
        description: "Build a task with mandatory reviewers and description-selected specialists in parallel",
        execute: async ({ sessionID, prompt }) => {
          const input = planCommand(prompt.text)
          const previous = await ctx.session.get({ sessionID })
          const priorRun = await ctx.storage.get(gate.key)
          try {
            await ctx.session.switchAgent({ sessionID, agent: "orchestrator" })
            await gate.start(sessionID, input.task, prompt, input.plan)
          } catch (error) {
            // Do not strand a rejected enrollment on the read-only agent, but
            // keep orchestration if a new run was durably created before I/O failed.
            const current = await ctx.storage.get(gate.key)
            const session = await ctx.session.get({ sessionID })
            if (current?.id === priorRun?.id && session.agent === "orchestrator" &&
              session.location.directory === previous.location.directory) {
              await ctx.session.switchAgent({ sessionID, agent: previous.agent })
            }
            throw error
          }
          await ctx.session.synthetic({
            sessionID,
            text: "Swarm plan enrolled for orchestrator review; implementation has not started. Answer any targeted clarification questions; the builder starts when the plan is clear. /swarm-status checks progress. After implementation starts, ordinary messages pause the workflow as requirement changes and /swarm-resume continues after clarification. /swarm-cancel stops the run. Successful completion saves the HTML summary in <repository-root>/.swarms/ and attempts to open it in the browser.",
          })
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
          text: orchestratorInstructions,
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
        ["BLOCKED", "CANCELLED", "APPROVED", "HANDOFF", "SELECTING", "REVIEW_HANDOFF", "TRIAGING", "REPORTING"].includes(state.phase))) {
        for (const name of Object.keys(event.tools)) {
          if (name !== "swarm_status") delete event.tools[name]
        }
      }
    })
    await ctx.permission.hook("evaluate", async event => {
      const state = await gate.inspect(event.sessionID)
      if (event.action === "subagent") {
        const session = await ctx.session.get({ sessionID: event.sessionID })
        if (session.agent === "orchestrator" &&
          (!event.resources.length || event.resources.some(resource =>
            !dispatchTargets.has(resource) && !state.dispatchTargets?.includes(resource)))) {
          event.effect = "deny"
          event.message = "Swarm: dispatch is limited to the builder and configured/enrolled reviewers."
          return
        }
        // This is a deny-only boundary. Never relax user deny/ask rules, including
        // blanket rules, by rewriting the resolved agent permissions or effects.
      }
      if (!state.role) return
      if ((state.role === "ui-design-reviewer" && event.action.startsWith("playwright_")) ||
        (state.role !== "ui-design-reviewer" && event.action.startsWith("ui_browser_"))) {
        event.effect = "deny"
        event.message = "Swarm: use your assigned browser server; parallel reviewers must not share browser state."
        return
      }
      if (["edit", "shell"].includes(event.action)) {
        const build = state.role === "builder" && state.phase === "BUILDING" && !state.submitted
        const test = state.role === "test-engineer" && state.phase === "REVIEWING" && !state.submitted
        const readOnlyReview = !["builder", "orchestrator"].includes(state.role) && !test &&
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
    const abort = new AbortController()
    let recovery
    let dirty = false
    let started = false
    const recover = () => {
      if (abort.signal.aborted) return
      dirty = true
      if (!started || recovery) return recovery
      recovery = (async () => {
        while (dirty && !abort.signal.aborted) {
          dirty = false
          try {
            await gate.reconcile()
          } catch (error) {
            if (abort.signal.aborted) break
            try { await gate.fail(error) }
            catch (failure) { console.error("swarm recovery failed", failure) }
          }
        }
      })().finally(() => {
        recovery = undefined
        dependencies.onRecovery?.()
      })
      return recovery
    }
    let listening = false
    const listen = () => {
      if (listening || abort.signal.aborted) return
      listening = true
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({
            types: ["session.execution.succeeded", "session.execution.failed",
              "session.execution.interrupted", "session.agent.selected", "session.moved", "filesystem.changed"],
            signal: abort.signal,
          })) {
            if (event.location?.directory !== ctx.location.directory) continue
            // Session operations can themselves publish events on this stream.
            void recover()
          }
        } catch (error) {
          if (!abort.signal.aborted) console.error("swarm event stream failed; recovery sweep will reconnect", error)
        } finally {
          listening = false
        }
      })()
    }
    listen()
    const timer = setInterval(() => { listen(); void recover() }, 30_000)
    timer.unref?.()
    // Prompt admission waits for location plugins to be ready. Recovery may
    // dispatch prompts, so it must never be awaited by plugin setup itself.
    const startup = setTimeout(() => { started = true; void recover() }, 0)
    return async () => {
      clearTimeout(startup)
      clearInterval(timer)
      abort.abort()
      gate.close()
      // Do not let a broken event source or an uncooperative SDK operation hold
      // location shutdown. Detached work already has rejection handlers.
    }
}
