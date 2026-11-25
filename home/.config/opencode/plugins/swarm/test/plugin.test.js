import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setup } from "../lib/plugin.js";
import { packet, reviewers, reviewRounds, roundReviewers, uiReviewer } from "../lib/protocol.js";
import { orchestratorInstructions } from "../lib/instructions.js";

test("plugin package, entrypoint, and directory use the swarm identity", async () => {
  const manifest = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.name, "opencode-swarm");
  assert.equal(manifest.exports["."], "./index.ts");
  const entrypoint = await fs.readFile(new URL("../index.ts", import.meta.url), "utf8");
  assert.match(entrypoint, /id: "swarm"/);
  await assert.rejects(fs.access(new URL("../../review-gate", import.meta.url)), { code: "ENOENT" });
});

test("standard instructions include reusable workflow policy without seeded-evaluation rules", () => {
  for (const requirement of [
    /Do not launch agents manually, waive required reviews, reset budgets automatically/,
    /submit another participant's candidate or report/,
    /All three baseline reviewers must explicitly approve the same final candidate/,
    /UI work also requires ui-design-reviewer/,
    /A clean first review can pass without a repair cycle/,
    /only the owning reviewer may verify a fix or accept\/reject dismissal/,
    /swarm_report_html.*reportRequest\.id.*candidate\.id/,
    /orchestrator must author a decision-focused executive summary/,
    /400–550 words \(2–3 minutes\)/,
    /must not exceed 600 words/,
    /cover every unique candidate in chronological order, including the final candidate/,
    /overlapping reviewer reports are not necessarily distinct defects/,
    /Review approval is not deployment readiness/,
    /<repository-root>\/\.swarms\/.*opens it in the web browser/,
    /Completion requires the controller's APPROVED state with htmlReport\.path/,
    /final response must link htmlReport\.path.*candidate ID, review rounds, test evidence.*limitations/,
    /Do not claim checks that were not run/,
    /use \/swarm-status rather than a conversational status question/,
    /After implementation starts, new ordinary messages.*invalidate current approvals.*block the workflow/,
    /\/swarm-resume after clarification/,
    /Wait for plugin notifications rather than polling/,
  ]) assert.match(orchestratorInstructions, requirement);
  assert.doesNotMatch(orchestratorInstructions,
    /unchanged seed|seeded baseline|at least one genuine|evaluation failure/i);
});

test("reporting handoff asks the orchestrator for the structured summary and complete history", async () => {
  const prompt = packet({
    id: "run_test", phase: "REPORTING", directory: "/repo", candidate: { id: "1:candidate" },
    reports: {}, findings: [], context: [], history: [],
  }, "orchestrator");
  for (const text of [
    "executiveSummary.rounds", "exact ID", "two short storytelling sentences",
    "nonempty array", "executiveSummary.findings", "executiveSummary.verification",
    "limitations", "executiveSummary.actions", "full recorded history",
    "distinguishing builder claims from independent reviewer execution",
    "Replace general round bullets with a reviewers array",
    "one concise line", "each reviewer's own findings", "no report recorded",
  ]) assert(prompt.includes(text), text);
  const agent = await fs.readFile(new URL("../../../agents/orchestrator.md", import.meta.url), "utf8");
  assert.match(agent, /executiveSummary\.rounds/);
  assert.match(agent, /600-word prose limit/);
});

for (const uiChanges of ["none", "web"]) {
  test(`registers V2 APIs, permissions, and a complete scripted run (${uiChanges} UI)`,
    t => scriptedRun(t, uiChanges));
}

async function scriptedRun(t, uiChanges) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "swarm-plugin-test-")));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: directory });
  await fs.writeFile(path.join(directory, "code.js"), "candidate\n");
  await fs.writeFile(path.join(directory, "PLAN.md"), "Implement the task and add guard regression tests.\n");
  const state = new Map();
  const tools = new Map();
  const commands = new Map();
  const hooks = new Map();
  const sessions = new Map([["ses_root", {
    id: "ses_root", agent: "build", location: { directory }, time: {},
    permissions: [{ action: "shell", resource: "*", effect: "allow" }],
  }]]);
  const messages = new Map([["ses_root", [{
    type: "user", text: "Original acceptance criteria", id: "msg_original",
  }]]]);
  const agents = new Map([
    ["build", { system: undefined, instructions: "Build instructions", permissions: [
      { action: "edit", resource: "*", effect: "ask" },
    ] }],
    ["builder", { system: "placeholder", model: "profile-specific" }],
  ]);
  const prompts = [];
  const synthetics = [];
  const openedReports = [];
  const hook = domain => async (name, callback) => { hooks.set(`${domain}:${name}`, callback); };
  let subscriber;
  const ctx = {
    location: { directory }, options: {},
    storage: {
      get: async key => structuredClone(state.get(key)),
      set: async (key, value) => { state.set(key, structuredClone(value)); },
    },
    agent: {
      get: async ({ agentID }) => ({ id: agentID }),
      transform: async callback => callback({
        get: id => agents.get(id), update: (id, update) => update(agents.get(id)),
      }),
    },
    permission: { assert: async () => {}, hook: hook("permission") },
    tool: {
      transform: async callback => callback({ add: tool => tools.set(tool.name, tool) }),
      hook: hook("tool"),
    },
    command: { transform: async callback => callback({ add: command => commands.set(command.name, command) }) },
    event: {
      subscribe: ({ signal }) => {
        subscriber = { signal };
        return (async function* () {
          await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
        })();
      },
    },
    session: {
      hook: hook("session"),
      get: async ({ sessionID }) => structuredClone(sessions.get(sessionID)),
      context: async ({ sessionID }) => structuredClone(messages.get(sessionID) ?? []),
      create: async input => {
        if (!sessions.has(input.id)) sessions.set(input.id, {
          ...input, location: { directory }, time: {},
        });
        return sessions.get(input.id);
      },
      switchAgent: async ({ sessionID, agent }) => { sessions.get(sessionID).agent = agent; },
      prompt: async input => {
        // In real V2 the prompt hook runs during admission, inside dispatch.
        // This also proves that the internal-prompt bypass cannot deadlock.
        await hooks.get("session:prompt")({
          sessionID: input.sessionID, messageID: input.id, prompt: { text: input.text },
          metadata: input.metadata,
        });
        prompts.push(input);
        if (!messages.has(input.sessionID)) messages.set(input.sessionID, []);
        messages.get(input.sessionID).push({ ...input, type: "user" });
      },
      synthetic: async input => {
        synthetics.push(structuredClone(input));
        if (!messages.has(input.sessionID)) messages.set(input.sessionID, []);
        messages.get(input.sessionID).push({ ...structuredClone(input), type: "synthetic" });
      },
      interrupt: async () => {},
    },
  };
  const configure = () => setup(ctx, { openReport: async file => { openedReports.push(file); } });
  const cleanup = await configure();
  t.after(cleanup);
  assert.equal(tools.size, 7);
  assert.deepEqual([...commands.keys()], ["swarm", "swarm-status", "swarm-resume", "swarm-cancel"]);
  assert.equal(agents.get("builder").system, undefined);
  assert.equal(agents.get("builder").model, "profile-specific");
  assert.equal(agents.get("builder").instructions, "Build instructions");
  assert.deepEqual(agents.get("builder").permissions.at(-1),
    { action: "subagent", resource: "*", effect: "deny" });

  await assert.rejects(commands.get("swarm").execute({
    sessionID: "ses_root", prompt: { text: " " },
  }), /Usage:/);
  assert.equal(sessions.get("ses_root").agent, "build");
  assert.equal(synthetics.length, 0);
  await assert.rejects(commands.get("swarm").execute({
    sessionID: "ses_root", prompt: { text: "--plan missing.md" },
  }), { code: "ENOENT" });
  assert.equal(sessions.get("ses_root").agent, "build", "a missing plan must restore the previous agent");
  assert.equal(state.size, 0);
  assert.equal(prompts.length, 0);
  const authorize = ctx.permission.assert;
  ctx.permission.assert = async () => { throw new Error("read denied"); };
  await assert.rejects(commands.get("swarm").execute({
    sessionID: "ses_root", prompt: { text: "--plan PLAN.md" },
  }), /read denied/);
  ctx.permission.assert = authorize;
  assert.equal(sessions.get("ses_root").agent, "build", "read denial must restore the previous agent");
  assert.equal(state.size, 0);
  assert.equal(synthetics.length, 0);
  await commands.get("swarm").execute({
    sessionID: "ses_root", prompt: { text: "--plan PLAN.md Implement the task", files: [], skills: [] },
  });
  const active = () => [...state.entries()].find(([key]) => key.endsWith("/active"))[1];
  const invoke = async (name, input, sessionID) => JSON.parse((await tools.get(`swarm_${name}`)
    .execute(input, { sessionID })).content);
  const finishUI = async cleanup => {
    if (uiChanges === "none") {
      assert.equal(active().sessions[uiReviewer], undefined);
      return cleanup;
    }
    assert.equal(active().phase, "REVIEWING");
    const sessionID = active().sessions[uiReviewer];
    assert.equal(active().jobs.at(-1).role, uiReviewer);
    assert(active().jobs.filter(job => reviewers.includes(job.role)).every(job => job.finished));
    for (const [action, resources, expected] of [
      ["edit", ["code.js"], "deny"],
      ["shell", ["touch candidate"], "deny"],
      ["shell", ["git diff --no-ext-diff --no-textconv -- code.js"], "allow"],
    ]) {
      const event = { sessionID, action, resources, effect: "allow" };
      await hooks.get("permission:evaluate")(event);
      assert.equal(event.effect, expected);
    }
    await invoke("report", {
      candidate: active().candidate.id, verdict: "approve", summary: "UI verified",
      evidence: "Scripted Playwright MCP review evidence", findings: [], decisions: [],
    }, sessionID);
    assert.equal(active().phase, "REVIEW_HANDOFF");
    messages.get(sessionID).push({
      type: "idle", id: `msg_ui_${active().round}`, outcome: "succeeded",
      time: { created: Date.now() },
    });
    await cleanup();
    const nextCleanup = await configure();
    t.after(nextCleanup);
    return nextCleanup;
  };
  const run = active();
  assert.equal(run.requirements, "Implement the task", "policy must not alter task requirements");
  assert.equal(run.phase, "PLAN_REVIEW", "builder must wait for plan review");
  assert.equal(synthetics.length, 1);
  assert.equal(synthetics[0].sessionID, "ses_root");
  assert.match(synthetics[0].text, /\/swarm-status checks progress/);
  assert.match(synthetics[0].text, /ordinary messages pause the workflow/);
  assert.match(synthetics[0].text, /\/swarm-resume.*\/swarm-cancel/);
  assert(!synthetics[0].text.includes(orchestratorInstructions),
    "persistent startup help must not retain the agent-only workflow policy");
  const initialContext = { sessionID: "ses_root", agent: "orchestrator", system: [], tools: {} };
  await hooks.get("session:context")(initialContext);
  assert(initialContext.system.some(part => part.text === orchestratorInstructions),
    "the command-selected orchestrator receives the full workflow instructions");
  await assert.rejects(commands.get("swarm").execute({
    sessionID: "ses_root", prompt: { text: "--plan PLAN.md Attempt duplicate enrollment" },
  }), /already has an active run/);
  assert.equal(synthetics.length, 1, "failed enrollment does not emit another startup message");
  assert.equal(active().requirements, run.requirements);
  assert.equal(prompts.length, 1, "only the orchestrator receives the plan at enrollment");
  assert.equal(prompts[0].sessionID, "ses_root");
  assert.match(prompts[0].text, /Implement the task and add guard regression tests/);
  await invoke("plan", {
    request: active().planReview.request, decision: "ready",
    summary: "The provided plan defines the implementation and regression checks.",
    questions: [], answers: [],
  }, "ses_root");
  assert.equal(await fs.readFile(path.join(directory, "PLAN.md"), "utf8"),
    "Implement the task and add guard regression tests.\n", "plan review leaves the supplied file unchanged");
  const builder = run.sessions.builder;
  assert.equal(prompts.length, 2);
  assert.equal(sessions.get("ses_root").agent, "orchestrator");
  const denied = { sessionID: builder, action: "edit", effect: "allow" };
  await hooks.get("permission:evaluate")(denied);
  assert.equal(denied.effect, "allow");
  await invoke("candidate", {
    summary: "Complete", evidence: "Checks passed", responses: [],
    ui: { changes: uiChanges, evidence: uiChanges === "none"
      ? "No user interface changes" : "Changed /settings. URL: http://localhost:3000/settings" },
  }, builder);
  await hooks.get("permission:evaluate")(denied);
  assert.equal(denied.effect, "deny");
  await assert.rejects(hooks.get("tool:execute.before")({
    tool: "subagent", sessionID: builder,
  }), /owns all agent dispatch/);
  const context = { sessionID: builder, agent: "builder", system: [], tools: { edit: {}, swarm_status: {} } };
  await hooks.get("session:context")(context);
  assert.deepEqual(Object.keys(context.tools), ["swarm_status"]);
  sessions.get(builder).outcome = "succeeded";
  sessions.get(builder).time.idle = Date.now() + 1000;
  messages.get(builder).push({
    type: "idle", id: "msg_builder_idle", outcome: "succeeded", time: { created: Date.now() },
  });
  // Recovery in a freshly loaded adapter is the same path used by the event consumer.
  await cleanup();
  const reloadedCleanup = await configure();
  t.after(reloadedCleanup);
  assert(subscriber.signal);
  assert.equal(active().phase, "REVIEWING");
  const testShell = {
    sessionID: run.sessions["test-engineer"], action: "shell", effect: "allow",
  };
  await hooks.get("permission:evaluate")(testShell);
  assert.equal(testShell.effect, "ask");
  for (const role of ["adversarial-reviewer", "specification-reviewer"]) {
    for (const command of [
      "touch candidate", "git diff; touch candidate", "git diff --output=code.js",
      "git diff --ext-diff", "git status > code.js", "git log --output=code.js",
      "git diff -- --no-ext-diff --no-textconv",
    ]) {
      const event = { sessionID: run.sessions[role], action: "shell",
        resources: [command], effect: "allow" };
      await hooks.get("permission:evaluate")(event);
      assert.equal(event.effect, "deny", `${role}: ${command}`);
    }
    for (const command of ["git status --short", "git log --oneline -5",
      "git diff --no-ext-diff --no-textconv --cached -- code.js"]) {
      const event = { sessionID: run.sessions[role], action: "shell",
        resources: [command], effect: "allow" };
      await hooks.get("permission:evaluate")(event);
      assert.equal(event.effect, "allow", command);
    }
  }
  for (const role of reviewers) {
    await invoke("report", {
      candidate: active().candidate.id,
      verdict: role === reviewers[0] ? "changes_requested" : "approve",
      summary: role === reviewers[0] ? "Missing guard" : "No findings",
      evidence: "Scripted review evidence",
      findings: role === reviewers[0] ? [{
        id: "missing-guard", severity: "major", kind: "defect", location: "code.js:1",
        description: "Missing guard", expected: "Handle empty input", actual: "Throws",
        reproduction: "Pass empty input", recommendation: "Add guard and regression test",
      }] : [],
      decisions: [],
    }, run.sessions[role]);
    sessions.get(run.sessions[role]).time.idle = Date.now() + 2000;
    messages.get(run.sessions[role]).push({
      type: "idle", id: `msg_${role}_idle`, outcome: "succeeded",
      time: { created: Date.now() },
    });
  }
  // Deterministic restart reconciliation also waits for the three final turns.
  await reloadedCleanup();
  let finalCleanup = await configure();
  t.after(finalCleanup);
  finalCleanup = await finishUI(finalCleanup);
  assert.equal(active().phase, "TRIAGING");
  const triageJob = active().jobs.at(-1);
  assert.equal(triageJob.role, "orchestrator");
  assert.equal(triageJob.kind, "triage");
  await hooks.get("permission:evaluate")(denied);
  assert.equal(denied.effect, "deny", "builder cannot edit before orchestrator triage");
  const rootContext = { sessionID: "ses_root", agent: "orchestrator", system: [], tools: {} };
  await hooks.get("session:context")(rootContext);
  assert(rootContext.system.some(part => part.text.includes("swarm_triage")));
  assert(rootContext.system.some(part => part.text === orchestratorInstructions),
    "instructions remain present after plugin reload and state transitions");
  const findingID = active().findings[0].id;
  const decision = {
    request: active().triageRequest.id, candidate: active().candidate.id,
    summary: "The failure is valid; add the required guard",
    decisions: [{ findingID, action: "fix", reason: "Requirement explicitly covers empty input" }],
  };
  await assert.rejects(invoke("triage", decision, builder), /cannot perform/);
  await invoke("triage", decision, "ses_root");
  const builderEdit = { sessionID: builder, action: "edit", resources: ["code.js"], effect: "allow" };
  await hooks.get("permission:evaluate")(builderEdit);
  assert.equal(builderEdit.effect, "allow");
  await fs.writeFile(path.join(directory, "code.js"), "fixed candidate\n");
  await invoke("candidate", {
    summary: "Added guard", evidence: "Regression check passed",
    ui: { changes: uiChanges, evidence: uiChanges === "none"
      ? "No user interface changes" : "Fixed /settings. URL: http://localhost:3000/settings" },
    responses: [{ findingID, action: "fixed", reason: "Implemented and verified the guard" }],
  }, builder);
  messages.get(builder).push({
    type: "idle", id: "msg_builder_fixed", outcome: "succeeded", time: { created: Date.now() },
  });
  await finalCleanup();
  const verificationCleanup = await configure();
  t.after(verificationCleanup);
  assert.equal(active().phase, "REVIEWING");
  for (const role of reviewers) {
    await invoke("report", {
      candidate: active().candidate.id, verdict: "approve", summary: "Verified",
      evidence: "Scripted regression verification", findings: [],
      decisions: role === reviewers[0] ? [{
        findingID, outcome: "resolved", reason: "Original reproduction is fixed",
      }] : [],
    }, run.sessions[role]);
    messages.get(run.sessions[role]).push({
      type: "idle", id: `msg_${role}_verified`, outcome: "succeeded", time: { created: Date.now() },
    });
  }
  await verificationCleanup();
  let approvedCleanup = await configure();
  t.after(approvedCleanup);
  approvedCleanup = await finishUI(approvedCleanup);
  assert.equal((await invoke("status", {}, "ses_root")).phase, "REPORTING");
  assert.equal(openedReports.length, 0);
  const reportInput = {
    request: active().reportRequest.id, candidate: active().candidate.id,
    title: "Guard implementation review",
    summary: "The orchestrator triaged the guard defect, the builder fixed it, and all owners approved.",
    executiveSummary: {
      rounds: reviewRounds(active()).map(round => ({
        candidate: round.candidate.id, summary: "The candidate was reviewed. The ledger records the outcome.",
        reviewers: roundReviewers(round).map(reviewer => ({
          reviewer, summary: "The reviewer checked the candidate.",
          findings: ["The regression and owner decisions were checked."],
        })),
      })),
      findings: "One guard defect was resolved without dismissal.",
      verification: "Scripted regression verification passed.",
      actions: "No follow-up within fixture scope; not a deployment approval.",
    },
    limitations: "Scripted test fixture, not a live model evaluation.",
  };
  await assert.rejects(invoke("report_html", reportInput, builder), /cannot perform/);
  const result = await invoke("report_html", reportInput, "ses_root");
  assert.equal(result.phase, "APPROVED");
  assert.deepEqual(result.requiredReviewers, uiChanges === "none" ? reviewers : [...reviewers, uiReviewer]);
  assert.equal(path.dirname(result.htmlReport.path), path.join(directory, ".swarms"));
  const html = await fs.readFile(result.htmlReport.path, "utf8");
  assert.match(html, /Guard implementation review/);
  assert.match(html, /<h2>Executive summary<\/h2>/);
  assert.match(html, /<h4>Round 1<\/h4>/);
  assert.match(html, /<h4>Round 2<\/h4>/);
  assert.deepEqual(openedReports, [result.htmlReport.path]);
  await invoke("report_html", reportInput, "ses_root");
  assert.equal(openedReports.length, 1, "report retries must not open duplicate tabs");
  assert.equal((await invoke("status", {}, "ses_root")).phase, "APPROVED");
  assert([...state.keys()].some(key => key.endsWith("/active/artifacts")),
    "artifact provenance is stored outside the individual run");
  await approvedCleanup();
  const reportReloadCleanup = await configure();
  t.after(reportReloadCleanup);
  assert.equal((await invoke("status", {}, "ses_root")).phase, "APPROVED",
    "restart retains artifact provenance and the candidate fingerprint");
  assert.equal(openedReports.length, 1, "restart does not open another browser tab");
  sessions.get("ses_root").agent = "build";
  const buildContext = {
    sessionID: "ses_root", agent: "build", system: [], tools: {},
    messages: await ctx.session.context({ sessionID: "ses_root" }),
  };
  await hooks.get("session:context")(buildContext);
  assert.equal(buildContext.system.length, 0, "ordinary Build gets no swarm instructions");
  assert(buildContext.messages.some(message => message.type === "synthetic"),
    "isolation check must include the retained synthetic startup message");
  assert(!JSON.stringify(buildContext.messages).includes("Swarm workflow instructions."),
    "ordinary Build history must not contain the full agent-only workflow policy");
  const ordinaryEdit = {
    sessionID: "ses_root", action: "edit", resources: ["code.js"], effect: "allow",
  };
  await hooks.get("permission:evaluate")(ordinaryEdit);
  assert.equal(ordinaryEdit.effect, "allow");
  const notifications = prompts.length;
  await hooks.get("session:prompt")({
    sessionID: "ses_root", messageID: "msg_unrelated_build",
    prompt: { text: "An ordinary Build task" },
  });
  assert.equal(active().phase, "APPROVED");
  assert.equal(prompts.length, notifications);
  sessions.get("ses_root").agent = "orchestrator";
  await fs.writeFile(path.join(directory, "untracked.test.js"), "new content");
  assert.equal((await invoke("status", {}, "ses_root")).phase, "BLOCKED");
  await commands.get("swarm-cancel").execute({ sessionID: "ses_root" });
  sessions.get("ses_root").agent = "build";
  for (const action of ["edit", "shell"]) {
    const event = { sessionID: "ses_root", action, resources: ["anything"], effect: "allow" };
    await hooks.get("permission:evaluate")(event);
    assert.equal(event.effect, "allow", `ordinary Build ${action}`);
  }
  await hooks.get("tool:execute.before")({ tool: "subagent", sessionID: "ses_root" });
  assert.equal((await invoke("status", {}, "ses_root")).phase, "CANCELLED");
}
