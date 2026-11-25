import assert from "node:assert/strict";
import test from "node:test";
import { SwarmController } from "../lib/controller.js";
import { reviewers } from "../lib/protocol.js";

export function fixture(options = {}) {
  const data = new Map();
  const sessions = new Map([["ses_root", {
    id: "ses_root", agent: "orchestrator", location: { directory: "/repo" }, time: {},
    permissions: [{ action: "shell", resource: "git push*", effect: "deny" }],
  }]]);
  const deliveries = new Map();
  const writtenReports = [];
  const openedReports = [];
  const messages = new Map([["ses_root", [
    { type: "user", id: "msg_original", text: "Original requirement: keep compatibility",
      files: options.files ?? [], skills: options.skills ?? [] },
    { type: "assistant", content: [{ text: "A biased builder summary" }] },
  ]]]);
  let clock = 1000;
  let digest = "contents-a";
  const ctx = {
    storage: {
      get: async key => structuredClone(data.get(key)),
      set: async (key, value) => { data.set(key, structuredClone(value)); },
    },
    agent: { get: async ({ agentID }) => ({ id: agentID }) },
    permission: { assert: async () => {} },
    session: {
      get: async ({ sessionID }) => {
        assert(sessions.has(sessionID), `Missing session ${sessionID}`);
        return structuredClone(sessions.get(sessionID));
      },
      context: async ({ sessionID }) => structuredClone(messages.get(sessionID) ?? []),
      create: async input => {
        if (!sessions.has(input.id)) sessions.set(input.id, {
          ...input, location: { directory: "/repo" }, time: {},
        });
        return structuredClone(sessions.get(input.id));
      },
      prompt: async input => {
        if (!deliveries.has(input.id)) {
          deliveries.set(input.id, structuredClone(input));
          if (!messages.has(input.sessionID)) messages.set(input.sessionID, []);
          messages.get(input.sessionID).push({ ...input, type: "user" });
          sessions.get(input.sessionID).time.busy = ++clock;
        }
        return input;
      },
      interrupt: async ({ sessionID }) => {
        const session = sessions.get(sessionID);
        if (session) {
          session.outcome = "interrupted";
          session.time.idle = ++clock;
          messages.get(sessionID)?.push({
            type: "idle", id: `msg_idle_${clock}`, outcome: "interrupted", time: { created: clock },
          });
        }
      },
    },
  };
  const dependencies = {
    snapshot: async () => ({ digest, files: ["code.js", "untracked.test.js"] }),
    writeReport: async (run, narrative) => {
      writtenReports.push({ run, narrative });
      return {
        path: `/repo/.swarms/${run.id}-${run.reportRequest.id}.html`,
        candidate: run.candidate.id, sha256: "report-digest", bytes: 100,
        created: run.reportRequest.created,
      };
    },
    openReport: async file => { openedReports.push(file); },
    now: () => ++clock, ...options,
  };
  let gate = new SwarmController(ctx, "/repo", dependencies);
  const state = () => structuredClone(data.get(gate.key));
  const tool = async (name, input, role = "orchestrator") => {
    const result = await gate.tool(name, input,
      role === "orchestrator" ? "ses_root" : state().sessions[role]);
    if (name === "report" && options.autoFinish !== false &&
      !["BLOCKED", "CANCELLED"].includes(state().phase)) await finish(role);
    return result;
  };
  const finish = async role => {
    const session = sessions.get(role === "orchestrator" ? "ses_root" : state().sessions[role]);
    session.outcome = "succeeded";
    session.time.idle = ++clock;
    messages.get(session.id).push({
      type: "idle", id: `msg_idle_${clock}`, outcome: "succeeded", time: { created: clock },
    });
    await gate.reconcile();
    if (state().phase === "REPORTING" && options.autoReport !== false) {
      await tool("report_html", htmlInput({ state }));
    }
  };
  return {
    ctx, data, sessions, deliveries, messages, writtenReports, openedReports, state, tool, finish,
    get gate() { return gate; },
    change: () => { digest = "contents-b"; },
    advance: duration => { clock += duration; },
    restart: () => { gate = new SwarmController(ctx, "/repo", dependencies); return gate; },
    start: () => gate.start("ses_root", "Implement the feature"),
  };
}

export const candidateInput = responses => ({
  summary: "Implemented the task", evidence: "node --test: passed", responses: responses ?? [],
});
export const reportInput = (f, overrides = {}) => ({
  candidate: f.state().candidate.id, verdict: "approve", summary: "No findings",
  evidence: "Reviewed code and requirements; checks passed", findings: [], decisions: [],
  ...overrides,
});
export const triageInput = (f, decisions, summary = "Address the review feedback") => ({
  request: f.state().triageRequest.id, candidate: f.state().candidate.id, summary,
  decisions: decisions ?? f.state().findings.filter(finding => finding.status === "open")
    .map(finding => ({ findingID: finding.id, action: "fix", reason: "Verified against requirements" })),
});
export const htmlInput = f => ({
  request: f.state().reportRequest.id, candidate: f.state().candidate.id,
  title: "Completed task review",
  summary: "Implemented and independently reviewed the requested task.",
  limitations: "Finite testing does not prove the absence of defects.",
});
const finding = {
  id: "empty-input", severity: "major", kind: "defect", location: "code.js:12",
  description: "Empty input crashes", expected: "Return an empty result",
  actual: "Throws", reproduction: "Call parse('')", recommendation: "Handle empty input",
};

export async function reviewReady(f) {
  await f.start();
  await f.tool("candidate", candidateInput(), "builder");
  assert.equal(f.state().phase, "HANDOFF");
  assert.equal([...f.deliveries.values()].filter(d => d.sessionID !== "ses_root").length, 1);
  await f.finish("builder");
  assert.equal(f.state().phase, "REVIEWING");
}

test("builder completes before parallel review dispatch; all three approvals are required", async () => {
  const f = fixture();
  await reviewReady(f);
  assert.equal(f.deliveries.size, 4);
  const builder = f.sessions.get(f.state().sessions.builder);
  assert.deepEqual(builder.permissions, f.sessions.get("ses_root").permissions);
  const prompt = [...f.deliveries.values()][0].text;
  assert.match(prompt, /Original requirement/);
  assert.doesNotMatch(prompt, /biased builder summary/);
  await f.tool("report", reportInput(f), reviewers[0]);
  await f.tool("report", reportInput(f), reviewers[1]);
  assert.equal(f.state().phase, "REVIEWING");
  await f.tool("report", reportInput(f), reviewers[2]);
  assert.equal(f.state().phase, "APPROVED");
});

test("an unregistered session or builder cannot forge reviewer approval", async () => {
  const f = fixture();
  await reviewReady(f);
  await assert.rejects(f.gate.tool("report", reportInput(f), "ses_forged"), /cannot perform/);
  await assert.rejects(f.tool("report", reportInput(f), "builder"), /cannot perform/);
  f.sessions.get(f.state().sessions[reviewers[0]]).agent = "builder";
  await assert.rejects(f.tool("report", reportInput(f), reviewers[0]), /agent has changed/);
});

test("fixes and dismissal proposals remain open until their owner verifies them", async () => {
  const f = fixture();
  await reviewReady(f);
  await f.tool("report", reportInput(f, {
    verdict: "changes_requested", findings: [finding],
  }), reviewers[0]);
  await f.tool("report", reportInput(f), reviewers[1]);
  await f.tool("report", reportInput(f), reviewers[2]);
  assert.equal(f.state().phase, "TRIAGING");
  const findingID = f.state().findings[0].id;
  await assert.rejects(f.tool("candidate", candidateInput(), "builder"), /only be submitted while BUILDING/);
  await f.tool("triage", triageInput(f, [{
    findingID, action: "dismiss", reason: "The public contract rejects empty input",
  }]));
  await assert.rejects(f.tool("candidate", candidateInput(), "builder"), /every open finding/);
  await f.tool("candidate", candidateInput([{
    findingID, action: "dismiss", reason: "The public contract rejects empty input",
  }]), "builder");
  assert.equal(f.state().findings[0].status, "open");
  await f.finish("builder");
  await assert.rejects(f.tool("report", reportInput(f, {
    decisions: [{ findingID, outcome: "dismissed", reason: "Agreed" }],
  }), reviewers[1]), /owned by this reviewer/);
  await assert.rejects(f.tool("report", reportInput(f), reviewers[0]), /open findings/);
  assert.equal(f.state().reports[reviewers[0]], undefined);
  await f.tool("report", reportInput(f, {
    decisions: [{ findingID, outcome: "dismissed", reason: "Verified the documented contract" }],
  }), reviewers[0]);
  await f.tool("report", reportInput(f), reviewers[1]);
  await f.tool("report", reportInput(f), reviewers[2]);
  assert.equal(f.state().phase, "APPROVED");
  assert.equal(f.state().findings[0].status, "dismissed");
  assert.equal(f.state().findings[0].decisions[0].proposal.reason,
    "The public contract rejects empty input");
});

test("rejected dismissals return to the orchestrator; a later verified fix can close them", async () => {
  const f = fixture();
  await reviewReady(f);
  await f.tool("report", reportInput(f, {
    verdict: "changes_requested", findings: [finding],
  }), reviewers[0]);
  for (const role of reviewers.slice(1)) await f.tool("report", reportInput(f), role);
  const findingID = f.state().findings[0].id;
  await f.tool("triage", triageInput(f, [{
    findingID, action: "dismiss", reason: "Orchestrator initially considers this unnecessary",
  }]));
  await f.tool("candidate", candidateInput([{
    findingID, action: "dismiss", reason: "Unnecessary",
  }]), "builder");
  await f.finish("builder");
  await f.tool("report", reportInput(f, {
    verdict: "changes_requested",
    decisions: [{ findingID, outcome: "rejected", reason: "Public API permits empty input" }],
  }), reviewers[0]);
  for (const role of reviewers.slice(1)) await f.tool("report", reportInput(f), role);
  assert.equal(f.state().phase, "TRIAGING");
  await f.tool("triage", triageInput(f));
  await f.tool("candidate", candidateInput([{
    findingID, action: "fixed", reason: "Added guard and regression test",
  }]), "builder");
  await f.finish("builder");
  await assert.rejects(f.tool("report", reportInput(f, {
    decisions: [{ findingID, outcome: "dismissed", reason: "Wrong decision type" }],
  }), reviewers[0]), /does not match/);
  await f.tool("report", reportInput(f, {
    decisions: [{ findingID, outcome: "resolved", reason: "Reproduction and regression test passed" }],
  }), reviewers[0]);
  for (const role of reviewers.slice(1)) await f.tool("report", reportInput(f), role);
  assert.equal(f.state().phase, "APPROVED");
  assert.equal(f.state().findings[0].decisions.length, 2);
});

test("stale, duplicate, and malformed reports cannot corrupt the ledger", async () => {
  const f = fixture();
  await reviewReady(f);
  await assert.rejects(f.tool("report", reportInput(f, { candidate: "stale" }), reviewers[0]), /Stale/);
  await assert.rejects(f.tool("report", { verdict: "approve" }, reviewers[0]), /missing/);
  await assert.rejects(f.tool("report", reportInput(f, {
    reviewer: reviewers[1],
  }), reviewers[0]), /unexpected field/);
  const valid = reportInput(f);
  await f.tool("report", valid, reviewers[0]);
  await f.tool("report", valid, reviewers[0]);
  await assert.rejects(f.tool("report", { ...valid, summary: "Changed" }, reviewers[0]), /already/);
  assert.equal(Object.keys(f.state().reports).length, 1);
});

test("content changes revoke pending and already issued approvals", async () => {
  for (const approved of [false, true]) {
    const f = fixture();
    await reviewReady(f);
    for (const role of approved ? reviewers : reviewers.slice(0, 1)) {
      await f.tool("report", reportInput(f), role);
    }
    f.change();
    const result = await f.tool("status", {});
    assert.equal(result.phase, "BLOCKED");
    assert.match(result.reason, /contents changed/);
    await assert.rejects(f.tool("report", reportInput(f), reviewers[1]), /not accepting/);
  }
});

test("restart recovers handoff and never duplicates review dispatch", async () => {
  const f = fixture();
  await f.start();
  await f.tool("candidate", candidateInput(), "builder");
  const builder = f.sessions.get(f.state().sessions.builder);
  builder.outcome = "succeeded";
  builder.time.idle = 100_000;
  f.messages.get(builder.id).push({
    type: "idle", id: "msg_idle_restart", outcome: "succeeded", time: { created: 100_000 },
  });
  await f.restart().reconcile();
  assert.equal(f.state().phase, "REVIEWING");
  await f.gate.reconcile();
  assert.equal(f.deliveries.size, 4);
  await Promise.all(reviewers.map(role => f.tool("report", reportInput(f), role)));
  assert.equal(f.state().phase, "APPROVED");
});

test("retry after prompt succeeded but durable sent flag failed uses the same prompt ID", async () => {
  const f = fixture();
  const original = f.ctx.storage.set;
  let fail = true;
  f.ctx.storage.set = async (key, value) => {
    if (fail && value.jobs?.some(job => job.sent)) {
      fail = false;
      throw new Error("simulated save failure");
    }
    await original(key, value);
  };
  await assert.rejects(f.start(), /save failure/);
  assert.equal(f.deliveries.size, 1);
  assert.equal(f.state().jobs[0].sent, false);
  await f.restart().reconcile();
  assert.equal(f.deliveries.size, 1);
  assert.equal(f.state().jobs[0].sent, true);
});

test("dispatch failures, missing submissions, interruption, and deadlines fail closed", async () => {
  const f = fixture();
  f.ctx.session.prompt = async () => { throw new Error("provider unavailable"); };
  await f.start();
  assert.equal(f.state().phase, "BLOCKED");
  for (const failure of ["missing", "interrupted", "deadline"]) {
    const g = fixture();
    await g.start();
    if (failure === "deadline") {
      g.advance(31 * 60 * 1000);
      await g.gate.reconcile();
    } else if (failure === "missing") {
      await g.finish("builder");
    } else {
      const child = g.sessions.get(g.state().sessions.builder);
      child.outcome = "interrupted";
      child.time.idle = 100_000;
      g.messages.get(child.id).push({
        type: "idle", id: "msg_idle_interrupt", outcome: "interrupted", time: { created: 100_000 },
      });
      await g.gate.reconcile();
    }
    assert.equal(g.state().phase, "BLOCKED", failure);
  }
});

test("a blocked reviewer and the round limit cannot become implicit approval", async () => {
  const f = fixture();
  await reviewReady(f);
  await f.tool("report", reportInput(f, {
    verdict: "blocked", summary: "Required database unavailable",
  }), reviewers[1]);
  assert.equal(f.state().phase, "BLOCKED");
  assert.equal(f.state().reports[reviewers[1]].verdict, "blocked");
  const g = fixture({ maxRounds: 1 });
  await reviewReady(g);
  await g.tool("report", reportInput(g, {
    verdict: "changes_requested", findings: [finding],
  }), reviewers[0]);
  for (const role of reviewers.slice(1)) await g.tool("report", reportInput(g), role);
  assert.equal(g.state().phase, "BLOCKED");
  await assert.rejects(g.gate.control("ses_root", "resume"), /Round limit/);
});

test("new user requirements revoke approvals, deduplicate retries, and survive resume", async () => {
  const f = fixture();
  await reviewReady(f);
  await f.gate.externalPrompt("ses_root", "msg_clarify", { text: "Also support empty inputs" });
  await f.gate.externalPrompt("ses_root", "msg_clarify", { text: "Also support empty inputs" });
  assert.equal(f.state().phase, "BLOCKED");
  assert.equal(f.state().requirements.match(/Also support empty inputs/g).length, 1);
  await f.gate.control("ses_root", "resume");
  assert.equal(f.state().phase, "BUILDING");
  assert.match([...f.deliveries.values()].at(-1).text, /Also support empty inputs/);
  await f.gate.control("ses_root", "cancel");
  assert.equal(f.state().phase, "CANCELLED");
});

test("only one active run can own a checkout; moved sessions cannot submit", async () => {
  const f = fixture();
  await f.start();
  await assert.rejects(f.start(), /already has an active run/);
  f.sessions.get(f.state().sessions.builder).location.directory = "/elsewhere";
  await assert.rejects(f.tool("candidate", candidateInput(), "builder"), /moved/);
  f.sessions.get("ses_root").agent = "build";
  await f.gate.reconcile();
  assert.equal(f.state().phase, "BLOCKED");
});

test("permission denial prevents any builder dispatch", async () => {
  const f = fixture();
  f.ctx.permission.assert = async () => { throw new Error("Policy denies reviewer"); };
  await assert.rejects(f.start(), /Policy denies/);
  assert.equal(f.deliveries.size, 0);
});

test("an orchestrator child owns its own builder and reviewers, not the outer parent", async () => {
  const f = fixture();
  f.sessions.get("ses_root").parentID = "ses_outer";
  await reviewReady(f);
  for (const role of reviewers) {
    assert.equal(f.sessions.get(f.state().sessions[role]).parentID, "ses_root");
    await f.tool("report", reportInput(f), role);
  }
  assert.equal(f.state().phase, "APPROVED");
  await assert.rejects(f.gate.tool("status", {}, "ses_outer"), /cannot perform/);
});

test("tool enrollment forwards stored attachments and skills natively without mention offsets", async () => {
  const f = fixture({
    files: [{ data: "c2NyZWVuc2hvdA==", mime: "image/png", source: { type: "data" },
      name: "spec.png", mention: { start: 4, end: 8 } }],
    skills: [{ id: "test-skill", name: "Test skill", mention: { start: 1, end: 3 } }],
  });
  await f.tool("start", { task: "Implement the attached screenshot" });
  const builderPrompt = [...f.deliveries.values()][0];
  assert.deepEqual(builderPrompt.files, [{
    uri: "data:image/png;base64,c2NyZWVuc2hvdA==", name: "spec.png",
  }]);
  assert.deepEqual(builderPrompt.skills, [{ id: "test-skill" }]);
  assert.doesNotMatch(builderPrompt.text, /c2NyZWVuc2hvdA==/);
  await f.tool("candidate", candidateInput(), "builder");
  await f.finish("builder");
  for (const role of reviewers) {
    const prompt = [...f.deliveries.values()].find(item => item.sessionID === f.state().sessions[role]);
    assert.deepEqual(prompt.files, builderPrompt.files);
    assert.deepEqual(prompt.skills, builderPrompt.skills);
  }
});

test("command attachments combine with older conversation attachments without stale mentions", async () => {
  const f = fixture({ files: [{
    data: "b2xk", mime: "application/pdf", name: "old.pdf", source: { type: "data" },
  }] });
  await f.gate.start("ses_root", "Implement both documents", {
    files: [{ uri: "data:image/png;base64,bmV3", mention: { start: 0, end: 3 } }],
    skills: [{ id: "extra-skill", mention: { start: 0, end: 3 } }],
  });
  const prompt = [...f.deliveries.values()][0];
  assert.equal(prompt.files.length, 2);
  assert(prompt.files.every(file => !Object.hasOwn(file, "mention")));
  assert.deepEqual(prompt.skills, [{ id: "extra-skill" }]);
});

test("reviewer turn completion is awaited before a fast follow-up round", async () => {
  const f = fixture({ autoFinish: false });
  await reviewReady(f);
  for (const role of reviewers) {
    await f.tool("report", reportInput(f, {
      verdict: "changes_requested", summary: "Improve the check",
    }), role);
  }
  assert.equal(f.state().phase, "REVIEW_HANDOFF");
  assert.equal(f.state().jobs.filter(job => job.role === "builder").length, 1);
  await f.finish(reviewers[0]);
  await f.finish(reviewers[1]);
  assert.equal(f.state().phase, "REVIEW_HANDOFF");
  await f.finish(reviewers[2]);
  assert.equal(f.state().phase, "TRIAGING");
  await f.tool("triage", triageInput(f));
  assert.equal(f.state().phase, "BUILDING");
  // Merely being idle from the old turn, even with a misleading timestamp,
  // must not be mistaken for the newly dispatched prompt finishing.
  f.sessions.get(f.state().sessions.builder).time.idle = 1_000_000;
  await f.gate.reconcile();
  assert.equal(f.state().phase, "BUILDING");
  await f.tool("candidate", candidateInput(), "builder");
  await f.finish("builder");
  for (const role of reviewers) await f.tool("report", reportInput(f), role);
  assert.equal(f.state().phase, "REVIEW_HANDOFF");
  for (const role of reviewers) await f.finish(role);
  assert.equal(f.state().phase, "APPROVED");
});

test("submissions cannot bypass deadlines between recovery sweeps", async () => {
  const f = fixture();
  await reviewReady(f);
  await f.tool("report", reportInput(f), reviewers[0]);
  await f.tool("report", reportInput(f), reviewers[1]);
  f.advance(31 * 60 * 1000);
  const result = await f.tool("report", reportInput(f), reviewers[2]);
  assert.equal(result.phase, "BLOCKED");
  assert.match(result.reason, /after its deadline/);
  const g = fixture();
  await g.start();
  g.advance(31 * 60 * 1000);
  await g.tool("candidate", candidateInput(), "builder");
  assert.equal(g.state().phase, "BLOCKED");
  assert.equal(g.state().candidate, null);
});

test("delayed recovery accepts a submitted turn that finished before its deadline", async () => {
  const f = fixture({ autoFinish: false });
  await f.start();
  await f.tool("candidate", candidateInput(), "builder");
  const builder = f.sessions.get(f.state().sessions.builder);
  builder.time.idle = 2000;
  f.messages.get(builder.id).push({
    type: "idle", id: "msg_ontime", outcome: "succeeded", time: { created: 2000 },
  });
  f.advance(31 * 60 * 1000);
  await f.restart().reconcile();
  assert.equal(f.state().phase, "REVIEWING");
});

test("compaction may remove the dispatch prompt without losing turn completion", async () => {
  const f = fixture();
  await f.start();
  await f.tool("candidate", candidateInput(), "builder");
  const builder = f.sessions.get(f.state().sessions.builder);
  builder.time.idle = 2000;
  f.messages.set(builder.id, [{
    type: "idle", id: "msg_after_compaction", outcome: "succeeded", time: { created: 2000 },
  }]);
  await f.gate.reconcile();
  assert.equal(f.state().phase, "REVIEWING");
});

test("failed reporting notifications are not retried into ordinary Build", async () => {
  const f = fixture();
  await reviewReady(f);
  const original = f.ctx.session.prompt;
  f.ctx.session.prompt = async input => {
    if (input.sessionID === "ses_root") throw new Error("temporary notification failure");
    return original(input);
  };
  for (const role of reviewers) await f.tool("report", reportInput(f), role);
  assert.equal(f.state().phase, "BLOCKED");
  assert(f.state().jobs.some(job => job.role === "orchestrator" && !job.sent));
  f.sessions.get("ses_root").agent = "build";
  f.ctx.session.prompt = original;
  await f.restart().reconcile();
  assert(![...f.deliveries.values()].some(prompt => prompt.sessionID === "ses_root"));
  assert(f.state().jobs.findLast(job => job.role === "orchestrator").cancelled);
});

test("failed follow-up enqueue leaves no sibling mutations outside the controller lock", async () => {
  const f = fixture();
  await reviewReady(f);
  for (const role of reviewers) {
    await f.tool("report", reportInput(f, {
      verdict: "changes_requested", summary: "Improve the checks",
    }), role);
  }
  await f.tool("triage", triageInput(f));
  await f.tool("candidate", candidateInput(), "builder");
  const original = f.ctx.session.context;
  let peerCalls = 0;
  const delayed = [];
  f.ctx.session.context = async input => {
    if (input.sessionID === f.state().sessions[reviewers[0]]) {
      throw new Error("reviewer context unavailable");
    }
    if (reviewers.slice(1).some(role => input.sessionID === f.state().sessions[role])) {
      peerCalls += 1;
      return new Promise(resolve => delayed.push(() => resolve(original(input))));
    }
    return original(input);
  };
  await assert.rejects(f.finish("builder"), /reviewer context unavailable/);
  await f.gate.fail(new Error("reviewer context unavailable"));
  delayed.forEach(resolve => resolve());
  await Promise.resolve();
  assert.equal(peerCalls, 0, "a failed enqueue must not leave peer context reads in flight");
  assert.equal(f.state().phase, "BLOCKED");
  assert.equal(f.state().jobs.filter(job => reviewers.includes(job.role)).length, 3);
  assert(!f.state().jobs.some(job => reviewers.includes(job.role) && !job.cancelled));
});

async function triageReady(f, extraFinding = false) {
  await reviewReady(f);
  await f.tool("report", reportInput(f, {
    verdict: "changes_requested", findings: [finding],
  }), reviewers[0]);
  await f.tool("report", reportInput(f, extraFinding ? {
    verdict: "changes_requested", findings: [{ ...finding, id: "boundary-case" }],
  } : {}), reviewers[1]);
  await f.tool("report", reportInput(f), reviewers[2]);
  assert.equal(f.state().phase, "TRIAGING");
}

test("only the orchestrator can triage; incomplete, duplicate, stale and forged decisions are atomic", async () => {
  const f = fixture();
  await triageReady(f, true);
  const valid = triageInput(f);
  for (const role of ["builder", ...reviewers]) {
    await assert.rejects(f.tool("triage", valid, role), /cannot perform/);
  }
  await assert.rejects(f.gate.tool("triage", valid, "ses_forged"), /cannot perform/);
  const before = f.state();
  for (const [input, expected] of [
    [{ ...valid, request: "stale-request" }, /Stale/],
    [{ ...valid, candidate: "stale-candidate" }, /Stale/],
    [{ ...valid, decisions: valid.decisions.slice(0, 1) }, /exactly once/],
    [{ ...valid, decisions: [valid.decisions[0], valid.decisions[0]] }, /exactly once/],
    [{ ...valid, decisions: [...valid.decisions, {
      findingID: "invented", action: "fix", reason: "No such finding",
    }] }, /exactly once/],
    [{ ...valid, decisions: [{ ...valid.decisions[0], reason: " " }] }, /cannot be empty/],
    [{ ...valid, decisions: [{ ...valid.decisions[0], action: "resolved" }] }, /invalid choice/],
    [{ ...valid, verdict: "approve" }, /unexpected field/],
    [{ ...valid, summary: "" }, /cannot be empty/],
  ]) {
    await assert.rejects(f.tool("triage", input), expected);
    assert.deepEqual(f.state(), before, "rejected triage must not partially change the ledger");
  }
  assert.equal([...f.deliveries.values()].filter(prompt =>
    prompt.sessionID === f.state().sessions.builder).length, 1);
  const notification = [...f.deliveries.values()].find(prompt => prompt.sessionID === "ses_root");
  assert.match(notification.text, /Triage every open finding/);
  assert.match(notification.text, /empty-input/);
  assert.match(notification.text, new RegExp(f.state().triageRequest.id));
});

test("mixed triage controls builder actions but cannot resolve findings or replace any approval", async () => {
  const f = fixture();
  await triageReady(f, true);
  const [fixID, dismissID] = f.state().findings.map(finding => finding.id);
  const input = triageInput(f, [
    { findingID: fixID, action: "fix", reason: "Reproduction confirms an implementation defect" },
    { findingID: dismissID, action: "dismiss", reason: "The stated boundary is outside the contract" },
  ]);
  await f.tool("triage", input);
  assert.equal(f.state().phase, "BUILDING");
  assert(f.state().findings.every(finding => finding.status === "open" && !finding.proposal));
  assert.deepEqual(f.state().triage, input);
  const builderPrompt = [...f.deliveries.values()].at(-1);
  assert.match(builderPrompt.text, /Reproduction confirms/);
  assert.match(builderPrompt.text, /outside the contract/);
  const responses = [
    { findingID: fixID, action: "fixed", reason: "Added guard and regression coverage" },
    { findingID: dismissID, action: "dismiss", reason: "Evidence confirms the orchestrator rationale" },
  ];
  await assert.rejects(f.tool("candidate", candidateInput([
    responses[0], { ...responses[1], action: "fixed" },
  ]), "builder"), /must follow orchestrator triage/);
  assert(f.state().findings.every(finding => !finding.proposal));
  await assert.rejects(f.tool("candidate", candidateInput([
    { ...responses[0], action: "dismiss" }, responses[1],
  ]), "builder"), /must follow orchestrator triage/);
  await f.tool("candidate", candidateInput(responses), "builder");
  await f.finish("builder");
  await f.tool("report", reportInput(f, {
    decisions: [{ findingID: fixID, outcome: "resolved", reason: "Verified original reproduction" }],
  }), reviewers[0]);
  await f.tool("report", reportInput(f, {
    decisions: [{ findingID: dismissID, outcome: "dismissed", reason: "Independently agree with scope" }],
  }), reviewers[1]);
  assert.equal(f.state().phase, "REVIEWING");
  await f.tool("report", reportInput(f), reviewers[2]);
  assert.equal(f.state().phase, "APPROVED");
  assert.equal(f.state().findings[1].decisions[0].triage.reason, input.decisions[1].reason);
  assert.deepEqual(f.state().history.find(entry => entry.phase === "TRIAGED").decisions, input.decisions);
});

test("triage survives restart without duplicate notifications or builder dispatch", async () => {
  const f = fixture();
  await triageReady(f);
  const input = triageInput(f);
  const deliveries = f.deliveries.size;
  await f.restart().reconcile();
  assert.equal(f.state().phase, "TRIAGING");
  assert.equal(f.deliveries.size, deliveries);
  // Idle orchestration turns do not mean the whole workflow is complete.
  await f.finish("orchestrator");
  assert.equal(f.state().phase, "TRIAGING");
  const original = f.ctx.storage.set;
  let fail = true;
  f.ctx.storage.set = async (key, value) => {
    if (fail && value.phase === "BUILDING" &&
      value.jobs.filter(job => job.role === "builder" && job.sent).length === 2) {
      fail = false;
      throw new Error("simulated triage dispatch save failure");
    }
    await original(key, value);
  };
  await assert.rejects(f.tool("triage", input), /save failure/);
  assert.equal(f.state().phase, "BUILDING");
  await f.restart().reconcile();
  assert.equal(f.deliveries.size, deliveries + 1);
  assert.equal(f.state().history.filter(entry => entry.phase === "TRIAGED").length, 1);
  await assert.rejects(f.tool("triage", input), /not accepting triage/);
  assert.equal(f.deliveries.size, deliveries + 1);
});

test("triage is re-requested on resume with a new token and a current content baseline", async () => {
  const f = fixture();
  await triageReady(f);
  const stale = triageInput(f);
  await f.gate.externalPrompt("ses_root", "msg_triage_clarification", { text: "Preserve the legacy boundary" });
  f.change();
  await f.gate.control("ses_root", "resume");
  assert.equal(f.state().phase, "TRIAGING");
  assert.notEqual(f.state().triageRequest.id, stale.request);
  assert.equal(f.state().triageRequest.digest, "contents-b");
  await assert.rejects(f.tool("triage", stale), /Stale/);
  await assert.rejects(f.tool("candidate", candidateInput(), "builder"), /only be submitted while BUILDING/);
  const current = triageInput(f);
  await f.tool("triage", current);
  const findingID = f.state().findings[0].id;
  await f.tool("candidate", candidateInput([{
    findingID, action: "fixed", reason: "Implemented the clarified boundary behavior",
  }]), "builder");
  assert.match(f.state().candidate.id, /contents-b$/);
});

test("content changes during triage invalidate its decisions before builder dispatch", async () => {
  const f = fixture();
  await triageReady(f);
  const input = triageInput(f);
  f.change();
  await assert.rejects(f.tool("triage", input), /not accepting triage/);
  assert.equal(f.state().phase, "BLOCKED");
  assert.match(f.state().reason, /contents changed/);
  assert.equal(f.state().triage, null);
  assert.equal(f.state().jobs.filter(job => job.role === "builder").length, 1);
});

test("missing or late orchestrator triage blocks instead of silently resuming the builder", async () => {
  for (const submit of [false, true]) {
    const f = fixture();
    await triageReady(f);
    const input = triageInput(f);
    f.advance(31 * 60 * 1000);
    if (submit) await f.tool("triage", input);
    else await f.gate.reconcile();
    assert.equal(f.state().phase, "BLOCKED");
    assert.match(f.state().reason, /deadline/);
    assert.equal(f.state().jobs.filter(job => job.role === "builder").length, 1);
  }
});

test("general changes-requested feedback still requires triage even without open findings", async () => {
  const f = fixture();
  await reviewReady(f);
  await f.tool("report", reportInput(f, {
    verdict: "changes_requested", summary: "Explain the verification limitations",
  }), reviewers[0]);
  for (const role of reviewers.slice(1)) await f.tool("report", reportInput(f), role);
  assert.equal(f.state().phase, "TRIAGING");
  await f.gate.externalPrompt("ses_root", "msg_general_clarification", { text: "Keep the same behavior" });
  await f.gate.control("ses_root", "resume");
  assert.equal(f.state().phase, "TRIAGING", "resume must not bypass general-feedback triage");
  await f.tool("triage", triageInput(f, [], "Document the verification limits; do not change behavior"));
  assert.equal(f.state().phase, "BUILDING");
  assert.match([...f.deliveries.values()].at(-1).text, /Document the verification limits/);
});

test("failed interruption keeps the old builder blocked until resume confirms it stopped", async () => {
  const f = fixture();
  await f.start();
  const interrupt = f.ctx.session.interrupt;
  f.ctx.session.interrupt = async () => { throw new Error("interruption unavailable"); };
  await f.gate.externalPrompt("ses_root", "msg_stop_failure", { text: "Use the clarified behavior" });
  assert.equal(f.state().phase, "BLOCKED");
  assert.equal(f.state().stopFailures.length, 1);
  await assert.rejects(f.gate.control("ses_root", "resume"), /could not be confirmed stopped/);
  await assert.rejects(f.start(), /prior child turns could not be confirmed stopped/);
  assert.equal(f.state().phase, "BLOCKED");
  await assert.rejects(f.tool("candidate", candidateInput(), "builder"), /only be submitted while BUILDING/);
  assert.equal(f.state().candidate, null);
  assert.equal(f.state().jobs.filter(job => job.role === "builder").length, 1);
  f.ctx.session.interrupt = interrupt;
  await f.gate.control("ses_root", "resume");
  assert.equal(f.state().phase, "BUILDING");
  assert.deepEqual(f.state().stopFailures, []);
  assert.match([...f.deliveries.values()].at(-1).text, /Use the clarified behavior/);
});

test("resume refuses an interrupt response that leaves a child running", async () => {
  const f = fixture();
  await f.start();
  f.ctx.session.interrupt = async () => ({ interrupted: true });
  await f.gate.externalPrompt("ses_root", "msg_still_running", { text: "New requirement" });
  await assert.rejects(f.gate.control("ses_root", "resume"), /could not be confirmed stopped/);
  assert.equal(f.state().phase, "BLOCKED");
  assert.match(f.state().stopFailures[0].reason, /still running/);
});

test("an old candidate call queued behind resume cannot submit into the new dispatch", async () => {
  const f = fixture();
  await f.start();
  const interrupt = f.ctx.session.interrupt;
  f.ctx.session.interrupt = async () => { throw new Error("temporary interrupt failure"); };
  await f.gate.externalPrompt("ses_root", "msg_resume_epoch", { text: "Clarified acceptance criteria" });
  let release;
  let entered;
  const stopping = new Promise(resolve => { entered = resolve; });
  f.ctx.session.interrupt = async input => {
    entered();
    await new Promise(resolve => { release = resolve; });
    return interrupt(input);
  };
  const resuming = f.gate.control("ses_root", "resume");
  await stopping;
  const stale = f.tool("candidate", candidateInput(), "builder");
  // The synchronous storage read in the fixture captures the old dispatch.
  release();
  await resuming;
  await assert.rejects(stale, /Stale dispatch/);
  assert.equal(f.state().phase, "BUILDING");
  assert.equal(f.state().candidate, null);
  assert.equal(f.state().jobs.filter(job => job.role === "builder").length, 2);
});

async function reportingReady(f) {
  await reviewReady(f);
  for (const role of reviewers) await f.tool("report", reportInput(f), role);
  assert.equal(f.state().phase, "REPORTING");
}

test("completion requires an orchestrator HTML report after all reviewers finish", async () => {
  const f = fixture({ autoReport: false });
  await reportingReady(f);
  assert.equal(f.writtenReports.length, 0);
  assert.equal(f.openedReports.length, 0);
  const input = htmlInput(f);
  for (const role of ["builder", ...reviewers]) {
    await assert.rejects(f.tool("report_html", input, role), /cannot perform/);
  }
  await assert.rejects(f.gate.tool("report_html", input, "ses_forged"), /cannot perform/);
  await assert.rejects(f.tool("report_html", { ...input, request: "stale" }), /Stale HTML/);
  await assert.rejects(f.tool("report_html", { ...input, candidate: "stale" }), /Stale HTML/);
  await f.finish("orchestrator");
  assert.equal(f.state().phase, "REPORTING", "idle is not completion");
  await f.tool("report_html", input);
  assert.equal(f.state().phase, "APPROVED");
  assert.equal(f.writtenReports.length, 1);
  assert.equal(f.writtenReports[0].narrative.summary, input.summary);
  assert.equal(f.openedReports[0], f.state().htmlReport.path);
  assert.equal(f.state().htmlReport.browser.state, "opened");
  await f.tool("report_html", input);
  assert.equal(f.writtenReports.length, 1);
  assert.equal(f.openedReports.length, 1);
  await assert.rejects(f.tool("report_html", { ...input, summary: "Replacement" }), /already recorded/);
});

test("reporting cannot start early and cannot survive a changed candidate", async () => {
  const f = fixture({ autoReport: false });
  await f.start();
  await assert.rejects(f.tool("report_html", {
    request: "html_not_ready", candidate: "none", title: "Premature",
    summary: "Not approved", limitations: "No reviews yet",
  }), /not accepting/);
  const g = fixture({ autoReport: false });
  await reportingReady(g);
  const input = htmlInput(g);
  g.change();
  await assert.rejects(g.tool("report_html", input), /not accepting/);
  assert.equal(g.state().phase, "BLOCKED");
  assert.equal(g.writtenReports.length, 0);
  assert.equal(g.openedReports.length, 0);
});

test("write failures retain reporting state and frozen narrative for an explicit retry", async () => {
  let attempts = 0;
  const f = fixture({
    autoReport: false,
    writeReport: async run => {
      attempts += 1;
      if (attempts === 1) throw new Error("disk full");
      return { path: "/repo/.swarms/report.html", candidate: run.candidate.id };
    },
  });
  await reportingReady(f);
  const input = htmlInput(f);
  await assert.rejects(f.tool("report_html", input), /disk full/);
  assert.equal(f.state().phase, "REPORTING");
  assert.equal(f.state().reportError, "disk full");
  assert.equal(f.openedReports.length, 0);
  await f.restart().reconcile();
  await assert.rejects(f.tool("report_html", { ...input, summary: "Different text" }), /already recorded/);
  await f.tool("report_html", input);
  assert.equal(f.state().phase, "APPROVED");
  assert.equal(f.state().reportError, null);
  assert.equal(attempts, 2);
  assert.equal(f.openedReports.length, 1);
});

test("candidate changes during report I/O prevent completion and browser launch", async () => {
  let change;
  const f = fixture({
    autoReport: false,
    writeReport: async () => {
      change();
      return { path: "/repo/.swarms/report.html" };
    },
  });
  change = f.change;
  await reportingReady(f);
  await f.tool("report_html", htmlInput(f));
  assert.equal(f.state().phase, "BLOCKED");
  assert.equal(f.state().htmlReport, null);
  assert.equal(f.openedReports.length, 0);
});

test("HTML file I/O that finishes after its deadline cannot approve or launch a browser", async () => {
  let advance;
  const f = fixture({
    autoReport: false,
    writeReport: async () => {
      advance(31 * 60 * 1000);
      return { path: "/repo/.swarms/report.html" };
    },
  });
  advance = f.advance;
  await reportingReady(f);
  await f.tool("report_html", htmlInput(f));
  assert.equal(f.state().phase, "BLOCKED");
  assert.match(f.state().reason, /finished after its deadline/);
  assert.equal(f.state().htmlReport, null);
  assert.equal(f.openedReports.length, 0);
});

test("browser launch failures preserve the saved report and expose a manual-open warning", async () => {
  let launches = 0;
  const f = fixture({
    autoReport: false,
    openReport: async () => { launches += 1; throw new Error("No graphical display"); },
  });
  await reportingReady(f);
  const input = htmlInput(f);
  await f.tool("report_html", input);
  assert.equal(f.state().phase, "APPROVED");
  assert.equal(f.state().htmlReport.browser.state, "failed");
  assert.match(f.state().htmlReport.browser.error, /No graphical display/);
  await f.tool("report_html", input);
  assert.equal(launches, 1);
});

test("interrupted browser-attempt persistence does not open duplicate tabs on recovery", async () => {
  const f = fixture({ autoReport: false });
  await reportingReady(f);
  const input = htmlInput(f);
  const save = f.ctx.storage.set;
  let fail = true;
  f.ctx.storage.set = async (key, value) => {
    await save(key, value);
    if (fail && value.phase === "APPROVED") {
      fail = false;
      throw new Error("crash after approval persistence");
    }
  };
  await assert.rejects(f.tool("report_html", input), /crash after/);
  assert.equal(f.state().phase, "APPROVED");
  assert.equal(f.openedReports.length, 0);
  await f.restart().reconcile();
  assert.equal(f.state().htmlReport.browser.state, "unknown");
  assert.match(f.state().htmlReport.browser.error, /manually/);
  await f.tool("report_html", input);
  assert.equal(f.openedReports.length, 0);
  assert.equal(f.writtenReports.length, 1);
});

test("missing report deadline can resume reporting without spending another code-review round", async () => {
  const f = fixture({ autoReport: false, maxRounds: 1 });
  await reportingReady(f);
  const old = htmlInput(f);
  f.advance(31 * 60 * 1000);
  await f.gate.reconcile();
  assert.equal(f.state().phase, "BLOCKED");
  assert.match(f.state().reason, /reporting exceeded/);
  await f.gate.control("ses_root", "resume");
  assert.equal(f.state().phase, "REPORTING");
  assert.equal(f.state().round, 1);
  assert.notEqual(f.state().reportRequest.id, old.request);
  await assert.rejects(f.tool("report_html", old), /Stale HTML/);
  await f.tool("report_html", htmlInput(f));
  assert.equal(f.state().phase, "APPROVED");
  assert.equal(f.state().jobs.filter(job => job.role === "builder").length, 1);
});

test("new requirements during reporting cannot reuse the previous review approvals", async () => {
  const f = fixture({ autoReport: false });
  await reportingReady(f);
  await f.gate.externalPrompt("ses_root", "msg_report_clarification", { text: "Also implement validation" });
  await f.gate.control("ses_root", "resume");
  assert.equal(f.state().phase, "BUILDING");
  assert.deepEqual(f.state().reports, {});
  assert.equal(f.writtenReports.length, 0);
});

test("an interrupted HTML tool does not publish completion or launch a browser", async () => {
  const f = fixture({ autoReport: false });
  await reportingReady(f);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(f.gate.tool("report_html", htmlInput(f), "ses_root", abort.signal),
    { name: "AbortError" });
  assert.equal(f.state().phase, "REPORTING");
  assert.equal(f.writtenReports.length, 0);
  assert.equal(f.openedReports.length, 0);
});

test("interruption during HTML file I/O prevents automatic browser opening", async () => {
  const abort = new AbortController();
  const f = fixture({
    autoReport: false,
    writeReport: async () => {
      abort.abort();
      return { path: "/repo/.swarms/report.html" };
    },
  });
  await reportingReady(f);
  await assert.rejects(f.gate.tool("report_html", htmlInput(f), "ses_root", abort.signal),
    { name: "AbortError" });
  assert.equal(f.state().phase, "REPORTING");
  assert.equal(f.state().htmlReport, null);
  assert.equal(f.openedReports.length, 0);
});
