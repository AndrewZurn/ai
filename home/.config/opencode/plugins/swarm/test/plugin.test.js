import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setup } from "../lib/plugin.js";
import { reviewers } from "../lib/protocol.js";

test("plugin package, entrypoint, and directory use the swarm identity", async () => {
  const manifest = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.name, "opencode-swarm");
  assert.equal(manifest.exports["."], "./index.ts");
  const entrypoint = await fs.readFile(new URL("../index.ts", import.meta.url), "utf8");
  assert.match(entrypoint, /id: "swarm"/);
  await assert.rejects(fs.access(new URL("../../review-gate", import.meta.url)), { code: "ENOENT" });
});

test("registers V2 commands, tools, hooks, Build derivation, and a complete scripted run", async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "swarm-plugin-test-")));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: directory });
  await fs.writeFile(path.join(directory, "code.js"), "candidate\n");
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
      synthetic: async () => {},
      interrupt: async () => {},
    },
  };
  const configure = () => setup(ctx, { openReport: async file => { openedReports.push(file); } });
  const cleanup = await configure();
  t.after(cleanup);
  assert.equal(tools.size, 6);
  assert.deepEqual([...commands.keys()], ["swarm", "swarm-status", "swarm-resume", "swarm-cancel"]);
  assert.equal(agents.get("builder").system, undefined);
  assert.equal(agents.get("builder").model, "profile-specific");
  assert.equal(agents.get("builder").instructions, "Build instructions");
  assert.deepEqual(agents.get("builder").permissions.at(-1),
    { action: "subagent", resource: "*", effect: "deny" });

  await commands.get("swarm").execute({
    sessionID: "ses_root", prompt: { text: "Implement the task", files: [], skills: [] },
  });
  const active = () => [...state.entries()].find(([key]) => key.endsWith("/active"))[1];
  const invoke = async (name, input, sessionID) => JSON.parse((await tools.get(`swarm_${name}`)
    .execute(input, { sessionID })).content);
  const run = active();
  const builder = run.sessions.builder;
  assert.equal(prompts.length, 1);
  assert.equal(sessions.get("ses_root").agent, "orchestrator");
  const denied = { sessionID: builder, action: "edit", effect: "allow" };
  await hooks.get("permission:evaluate")(denied);
  assert.equal(denied.effect, "allow");
  await invoke("candidate", { summary: "Complete", evidence: "Checks passed", responses: [] }, builder);
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
  const finalCleanup = await configure();
  t.after(finalCleanup);
  assert.equal(active().phase, "TRIAGING");
  const triageJob = active().jobs.at(-1);
  assert.equal(triageJob.role, "orchestrator");
  assert.equal(triageJob.kind, "triage");
  await hooks.get("permission:evaluate")(denied);
  assert.equal(denied.effect, "deny", "builder cannot edit before orchestrator triage");
  const rootContext = { sessionID: "ses_root", agent: "orchestrator", system: [], tools: {} };
  await hooks.get("session:context")(rootContext);
  assert(rootContext.system.some(part => part.text.includes("swarm_triage")));
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
  const approvedCleanup = await configure();
  t.after(approvedCleanup);
  assert.equal((await invoke("status", {}, "ses_root")).phase, "REPORTING");
  assert.equal(openedReports.length, 0);
  const reportInput = {
    request: active().reportRequest.id, candidate: active().candidate.id,
    title: "Guard implementation review",
    summary: "The orchestrator triaged the guard defect, the builder fixed it, and all owners approved.",
    limitations: "Scripted test fixture, not a live model evaluation.",
  };
  await assert.rejects(invoke("report_html", reportInput, builder), /cannot perform/);
  const result = await invoke("report_html", reportInput, "ses_root");
  assert.equal(result.phase, "APPROVED");
  assert.equal(path.dirname(result.htmlReport.path), path.join(directory, ".swarms"));
  assert.match(await fs.readFile(result.htmlReport.path, "utf8"), /Guard implementation review/);
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
});
