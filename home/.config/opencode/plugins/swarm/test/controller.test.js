import assert from "node:assert/strict";
import test from "node:test";
import { SwarmController } from "../lib/controller.js";
import { requiredReviewers, reviewers, reviewRounds, roundReviewers, uiReviewer } from "../lib/protocol.js";

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
  let planContent = "Implement the feature, preserve compatibility, and add regression tests.";
  const ctx = {
    storage: {
      get: async key => structuredClone(data.get(key)),
      set: async (key, value) => { data.set(key, structuredClone(value)); },
    },
    agent: { get: async ({ agentID }) => ({ id: agentID, description: `Reviews ${agentID} concerns.` }) },
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
    readPlan: async (directory, reference, authorize) => {
      await authorize("/repo/PLAN.md");
      return { path: "/repo/PLAN.md", content: planContent, sha256: planContent };
    },
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
  const controller = () => {
    const instance = new SwarmController(ctx, "/repo", dependencies);
    const reconcile = instance.reconcile.bind(instance);
    instance.reconcile = async () => {
      await reconcile();
      if (options.autoSelect !== false && state()?.phase === "SELECTING") {
        await instance.tool("select", selectionInput({ state }), "ses_root");
      }
    };
    return instance;
  };
  let gate = controller();
  const state = () => structuredClone(data.get(gate.key));
  const approvePlan = async () => {
    if (state()?.phase === "PLAN_REVIEW" && options.autoPlan !== false) {
      await gate.tool("plan", planInput({ state }), "ses_root");
    }
  };
  const tool = async (name, input, role = "orchestrator") => {
    const result = await gate.tool(name, input,
      role === "orchestrator" ? "ses_root" : state().sessions[role]);
    if (name === "start") await approvePlan();
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
    ctx, data, sessions, deliveries, messages, writtenReports, openedReports, state, tool, finish, approvePlan,
    get gate() { return gate; },
    change: () => { digest = "contents-b"; },
    changePlan: () => { planContent = "Revised plan: validate all inputs and add regression tests."; },
    advance: duration => { clock += duration; },
    restart: () => { gate = controller(); return gate; },
    start: async () => {
      await gate.start("ses_root", "Implement the feature", {}, "PLAN.md");
      await approvePlan();
      return state();
    },
  };
}

export const candidateInput = responses => ({
  summary: "Implemented the task", evidence: "node --test: passed", responses: responses ?? [],
  ui: { changes: "none", evidence: "Only parser behavior changed; no UI surfaces." },
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
  executiveSummary: {
    rounds: reviewRounds(f.state()).map(round => ({
      candidate: round.candidate.id,
      summary: "The candidate was independently reviewed. Its outcome is recorded in the ledger.",
      reviewers: roundReviewers(round).map(reviewer => ({
        reviewer, summary: "Review evidence is recorded.",
        findings: ["The reviewer's finding decisions are retained."],
      })),
    })),
    findings: "See the authoritative finding counts and owner decisions.",
    verification: "Recorded test commands and reviewer evidence support this candidate.",
    actions: "No further action within scope; deployment readiness is not assessed.",
  },
  limitations: "Finite testing does not prove the absence of defects.",
});
export const planInput = (f, overrides = {}) => ({
  request: f.state().planReview.request, decision: "ready",
  summary: "Read the complete plan: scope, acceptance criteria and verification are clear.",
  questions: [], answers: [], ...overrides,
});
export const selectionInput = (f, overrides = {}) => ({
  request: f.state().selectionRequest.id, candidate: f.state().candidate.id,
  decisions: Object.entries(f.state().workflow.reviewers).filter(([, entry]) => !entry.required)
    .map(([reviewer]) => ({
      reviewer,
      action: f.state().selectedReviewers.includes(reviewer) ||
        f.state().candidate.ui.changes !== "none" ? "invoke" : "skip",
      reason: f.state().candidate.ui.changes === "none"
        ? "The parser-only changes do not need the described UI expertise."
        : "The changed settings screen needs the described design and usability review.",
    })),
  ...overrides,
});

test("specialist selection requires the owner, a current token and complete reasoned decisions", async () => {
  const f = fixture({ autoSelect: false });
  await f.start();
  await f.tool("candidate", candidateInput(), "builder");
  await f.finish("builder");
  assert.equal(f.state().phase, "SELECTING");
  assert.equal(f.sessions.size, 2, "no reviewer starts before selection");
  const valid = selectionInput(f);
  await assert.rejects(f.tool("select", valid, "builder"), /cannot perform/);
  const before = f.state();
  for (const invalid of [
    { ...valid, request: "stale" },
    { ...valid, candidate: "stale" },
    { ...valid, decisions: [] },
    { ...valid, decisions: [...valid.decisions, ...valid.decisions] },
    { ...valid, decisions: [{ reviewer: reviewers[0], action: "skip", reason: "Skip mandatory" }] },
    { ...valid, decisions: [{ reviewer: "unknown", action: "invoke", reason: "Unknown" }] },
    { ...valid, decisions: [{ ...valid.decisions[0], reason: " " }] },
    { ...valid, decisions: [{ ...valid.decisions[0], action: "maybe" }] },
  ]) {
    await assert.rejects(f.tool("select", invalid), /Stale|every specialist|cannot be empty|invalid choice/);
    assert.deepEqual(f.state(), before);
  }
  const prompt = [...f.deliveries.values()].at(-1).text;
  assert.match(prompt, /Review web interface usability, visual design, and interaction quality in a browser/);
  assert.match(prompt, /actual candidate changes/);
  await f.tool("select", valid);
  assert.equal(f.state().phase, "REVIEWING");
  assert.deepEqual(requiredReviewers(f.state()), reviewers);
  assert.deepEqual(f.state().candidate.selection, valid.decisions);
  await assert.rejects(f.tool("select", valid), /not accepting/);
});

test("custom specialists are selected by description, run in parallel and retain approval ownership", async () => {
  const role = "security-reviewer";
  const workflow = {
    version: 1, reviewers: {
      ...Object.fromEntries(reviewers.map(reviewer => [reviewer, {
        required: true, description: `Review ${reviewer}.`,
      }])),
      [role]: {
        required: false,
        description: "Review authentication, authorization and credential handling changes.",
      },
    },
  };
  const f = fixture({ workflow, autoSelect: false });
  f.ctx.agent.get = async ({ agentID }) => ({
    id: agentID, description: agentID === role
      ? "Review authentication, authorization and credential handling changes." : `Review ${agentID}.`,
  });
  await f.start();
  await f.tool("candidate", candidateInput(), "builder");
  await f.finish("builder");
  assert.match([...f.deliveries.values()].at(-1).text, /authentication, authorization/);
  const invoke = () => ({
    request: f.state().selectionRequest.id, candidate: f.state().candidate.id,
    decisions: [{ reviewer: role, action: "invoke", reason: "The parser handles authorization tokens." }],
  });
  const first = invoke();
  await f.tool("select", first);
  const specialist = f.state().sessions[role];
  assert.deepEqual(requiredReviewers(f.state()), [...reviewers, role]);
  assert(f.sessions.has(specialist));
  assert(f.state().jobs.filter(job => reviewers.includes(job.role)).every(job => !job.finished));
  for (const reviewer of reviewers) await f.tool("report", reportInput(f), reviewer);
  assert.equal(f.state().phase, "REVIEWING", "mandatory approvals do not replace a selected specialist");
  await f.tool("report", reportInput(f, { verdict: "changes_requested", findings: [finding] }), role);
  const findingID = `${role}:${finding.id}`;
  assert.equal(f.state().findings[0].id, findingID);
  await f.tool("triage", triageInput(f));
  await f.tool("candidate", candidateInput([{ findingID, action: "fixed", reason: "Added token validation." }]), "builder");
  await f.finish("builder");
  await assert.rejects(f.tool("select", first), /Stale/);
  const before = f.state();
  await assert.rejects(f.tool("select", {
    ...invoke(), decisions: [{ reviewer: role, action: "skip", reason: "Latest repair seems small." }],
  }), /remain required/);
  assert.deepEqual(f.state(), before);
  await f.tool("select", invoke());
  assert.equal(f.state().sessions[role], specialist, "reuse the finding owner's session");
  for (const reviewer of reviewers) await f.tool("report", reportInput(f), reviewer);
  await f.tool("report", reportInput(f, {
    decisions: [{ findingID, outcome: "resolved", reason: "Original reproduction and token checks pass." }],
  }), role);
  assert.equal(f.state().phase, "APPROVED");
  assert.deepEqual(roundReviewers(reviewRounds(f.state())[0]), [...reviewers, role]);
  assert(f.writtenReports[0].narrative.executiveSummary.rounds.every(round =>
    round.reviewers.at(-1).reviewer === role));
});

test("selection recovery freezes configuration and descriptions and does not duplicate dispatch", async () => {
  const workflow = { version: 1, reviewers: {
    baseline: { required: true, description: "Review baseline concerns." },
    specialist: { required: false, description: "Reviews specialist concerns." },
  } };
  const f = fixture({ workflow, autoSelect: false });
  await f.start();
  await f.tool("candidate", candidateInput(), "builder");
  await f.finish("builder");
  const before = f.state();
  const deliveries = f.deliveries.size;
  workflow.reviewers = { replacement: { required: true } };
  f.ctx.agent.get = async ({ agentID }) => ({ id: agentID, description: "Changed live description." });
  await f.restart().reconcile();
  assert.deepEqual(f.state(), before);
  assert.equal(f.deliveries.size, deliveries);
  assert.equal(f.state().workflow.reviewers.specialist.description, "Reviews specialist concerns.");
  await f.tool("select", {
    request: before.selectionRequest.id, candidate: before.candidate.id,
    decisions: [{ reviewer: "specialist", action: "invoke", reason: "The full task needs this expertise." }],
  });
  await f.restart().reconcile();
  assert.deepEqual(requiredReviewers(f.state()), ["baseline", "specialist"]);
  assert.equal(f.state().jobs.filter(job => job.role === "specialist").length, 1);
  assert.equal(f.state().sessions.replacement, undefined);
});

test("invalid new workflow edits do not prevent saved selection, repairs or status", async () => {
  const workflow = { version: 1, reviewers: {
    baseline: { required: true, description: "Review baseline concerns." },
    specialist: { required: false, description: "Reviews specialist concerns." },
  } };
  const f = fixture({ workflow, autoSelect: false });
  await f.start();
  await f.tool("candidate", candidateInput(), "builder");
  await f.finish("builder");
  const selection = {
    request: f.state().selectionRequest.id, candidate: f.state().candidate.id,
    decisions: [{ reviewer: "specialist", action: "invoke", reason: "The task needs its described expertise." }],
  };
  workflow.version = 999;
  await f.restart().reconcile();
  assert.equal(f.state().phase, "SELECTING");
  assert.equal((await f.tool("status", {})).workflow.version, 1);
  await f.tool("select", selection);
  await f.tool("report", reportInput(f, { verdict: "changes_requested", findings: [finding] }), "specialist");
  await f.tool("report", reportInput(f), "baseline");
  await f.restart().reconcile();
  assert.equal(f.state().phase, "TRIAGING");
  await f.tool("triage", triageInput(f));
  const findingID = `specialist:${finding.id}`;
  await f.tool("candidate", candidateInput([{ findingID, action: "fixed", reason: "Fixed and checked." }]), "builder");
  await f.finish("builder");
  await f.tool("select", { ...selection, request: f.state().selectionRequest.id, candidate: f.state().candidate.id });
  await f.tool("report", reportInput(f), "baseline");
  await f.tool("report", reportInput(f, {
    decisions: [{ findingID, outcome: "resolved", reason: "Verified the repair." }],
  }), "specialist");
  assert.equal(f.state().phase, "APPROVED");
  await assert.rejects(f.start(), /Invalid swarm workflow/);
  assert.equal(f.state().phase, "APPROVED", "invalid new enrollment cannot replace the saved run");
});

test("new scope can add a previously skipped specialist in a later round", async () => {
  const f = fixture({ autoSelect: false });
  await f.start();
  await f.tool("candidate", candidateInput(), "builder");
  await f.finish("builder");
  await f.tool("select", selectionInput(f));
  for (const role of reviewers) {
    await f.tool("report", reportInput(f, role === reviewers[0] ? {
      verdict: "changes_requested", summary: "The requirements also affect the visible error state.",
    } : {}), role);
  }
  await f.tool("triage", triageInput(f));
  await f.tool("candidate", {
    ...candidateInput(), ui: { changes: "web", evidence: "The error state changed on /settings." },
  }, "builder");
  await f.finish("builder");
  await f.tool("select", selectionInput(f));
  assert.deepEqual(requiredReviewers(f.state()), [...reviewers, uiReviewer]);
  const rounds = reviewRounds(f.state());
  assert.deepEqual(roundReviewers(rounds[0]), reviewers);
  assert.deepEqual(roundReviewers(rounds[1]), [...reviewers, uiReviewer]);
});

test("selection deadlines and candidate changes cannot be used to bypass review", async () => {
  for (const late of [false, true]) {
    const f = fixture({ autoSelect: false });
    await f.start();
    await f.tool("candidate", candidateInput(), "builder");
    await f.finish("builder");
    const input = selectionInput(f);
    if (late) {
      f.advance(31 * 60 * 1000);
      await f.tool("select", input);
    } else {
      f.change();
      await assert.rejects(f.tool("select", input), /not accepting/);
    }
    assert.equal(f.state().phase, "BLOCKED");
    assert.equal(f.sessions.size, 2);
    assert.equal(f.writtenReports.length, 0);
  }
});

test("slow selection permissions cannot dispatch after a deadline or changed candidate", async () => {
  for (const late of [false, true]) {
    const f = fixture({ autoSelect: false });
    await f.start();
    await f.tool("candidate", candidateInput(), "builder");
    await f.finish("builder");
    f.ctx.permission.assert = async ({ action }) => {
      if (action === "subagent") {
        if (late) f.advance(31 * 60 * 1000);
        else f.change();
      }
    };
    const input = selectionInput(f, { decisions: [{
      reviewer: uiReviewer, action: "invoke", reason: "The complete task needs design checks.",
    }] });
    if (late) await f.tool("select", input);
    else await assert.rejects(f.tool("select", input), /not accepting/);
    assert.equal(f.state().phase, "BLOCKED");
    assert.equal(f.state().sessions[uiReviewer], undefined);
    assert.equal(f.sessions.size, 2);
  }
});

test("a workflow with only mandatory reviewers dispatches without a selection turn", async () => {
  const f = fixture({ workflow: { version: 1, reviewers: {
    safety: { required: true, description: "Review safety concerns." },
  } } });
  await reviewReady(f);
  assert.equal(f.state().selectionRequest, null);
  assert.deepEqual(requiredReviewers(f.state()), ["safety"]);
  await f.tool("report", reportInput(f), "safety");
  assert.equal(f.state().phase, "APPROVED");
});

test("legacy enrolled runs retain their baseline and UI membership without specialist selection", async () => {
  const f = fixture();
  await f.start();
  const legacy = f.state();
  delete legacy.workflow;
  delete legacy.selectedReviewers;
  delete legacy.selectionRequest;
  legacy.version = 1;
  f.data.set(f.gate.key, legacy);
  await f.tool("candidate", {
    ...candidateInput(), ui: { changes: "web", evidence: "Legacy settings page work." },
  }, "builder");
  await f.finish("builder");
  assert.equal(f.state().phase, "REVIEWING");
  assert.deepEqual(requiredReviewers(f.state()), [...reviewers, uiReviewer]);
  assert(!f.state().jobs.some(job => job.kind === "selection"));
  for (const role of [...reviewers, uiReviewer]) await f.tool("report", reportInput(f), role);
  assert.equal(f.state().phase, "APPROVED");
});

test("workflow descriptions allow enrollment when the agent API omits description metadata", async () => {
  const f = fixture();
  f.ctx.agent.get = async ({ agentID }) => ({ id: agentID });
  await f.start();
  assert.equal(f.state().workflow.reviewers["adversarial-reviewer"].description,
    "Find defects, regressions, security risks, and unnecessary complexity in the implementation.");
});

test("a required plan is reviewed before any builder exists and only the orchestrator may release it", async () => {
  const f = fixture({ autoPlan: false });
  await assert.rejects(f.gate.tool("start", { task: "No plan" }, "ses_root"), /missing plan/);
  assert.equal(f.state(), undefined);
  await f.start();
  assert.equal(f.state().phase, "PLAN_REVIEW");
  assert.equal(f.state().round, 0);
  assert.equal(f.sessions.size, 1);
  assert.equal(f.deliveries.size, 1);
  assert.equal([...f.deliveries.values()][0].sessionID, "ses_root");
  assert.match([...f.deliveries.values()][0].text, /preserve compatibility/);
  assert.match([...f.deliveries.values()][0].text, /specific questions/);
  await assert.rejects(f.gate.tool("plan", planInput(f), "ses_stranger"), /cannot perform/);
  const builder = f.state().sessions.builder;
  f.sessions.set(builder, {
    agent: "builder", parentID: "ses_root", location: { directory: "/repo" }, time: {},
  });
  await assert.rejects(f.tool("plan", planInput(f), "builder"), /cannot perform/);
  await assert.rejects(f.tool("candidate", candidateInput(), "builder"), /Stale dispatch/);
  await assert.rejects(f.tool("plan", planInput(f, { request: "stale" })), /Stale plan/);
  await f.tool("plan", planInput(f));
  assert.equal(f.state().phase, "BUILDING");
  assert.equal(f.state().jobs.filter(job => job.role === "builder").length, 1);
  await assert.rejects(f.tool("plan", planInput(f)), /not accepting/);
});

test("targeted plan questions wait across restart and require all real answers before building", async () => {
  const f = fixture({ autoPlan: false });
  await f.start();
  const first = planInput(f, {
    decision: "clarify", questions: ["What is the maximum input size?", "Which error code is required?"],
    summary: "Two acceptance criteria are missing.",
  });
  await f.tool("plan", first);
  assert.equal(f.state().phase, "CLARIFYING");
  assert.equal(f.sessions.size, 1);
  await assert.rejects(f.tool("plan", first), /Stale plan/);
  f.advance(24 * 60 * 60 * 1000);
  await f.restart().reconcile();
  assert.equal(f.state().phase, "CLARIFYING", "human answers have no dispatch deadline");
  const answers = [
    { question: first.questions[0], answer: "One MiB." },
    { question: first.questions[1], answer: "INVALID_INPUT." },
  ];
  const before = f.state();
  for (const invalid of [[], answers.slice(0, 1), [answers[0], answers[0]],
    [{ question: "Unasked question", answer: "Invented" }, answers[1]]]) {
    await assert.rejects(f.tool("plan", planInput(f, { answers: invalid })), /every pending/);
    assert.deepEqual(f.state(), before);
  }
  await f.tool("plan", planInput(f, { answers }));
  assert.equal(f.state().phase, "BUILDING");
  assert.deepEqual(f.state().planReview.answers, answers);
  assert.match([...f.deliveries.values()].at(-1).text, /INVALID_INPUT/);
  assert.equal(f.state().round, 0);
});

test("ordinary clarification replies refresh plan review without blocking or requiring resume", async () => {
  const f = fixture({ autoPlan: false });
  await f.start();
  await f.tool("plan", planInput(f, {
    decision: "clarify", questions: ["How should empty input behave?"],
  }));
  const old = planInput(f);
  const deliveries = f.deliveries.size;
  await f.gate.externalPrompt("ses_root", "msg_plan_answer", { text: "Return an empty result." });
  await f.gate.externalPrompt("ses_root", "msg_plan_answer", { text: "Return an empty result." });
  assert.equal(f.state().phase, "PLAN_REVIEW");
  assert.equal(f.deliveries.size, deliveries, "user admission must not dispatch another root prompt");
  assert.equal(f.state().requirements.match(/Return an empty result/g).length, 1);
  await assert.rejects(f.tool("plan", old), /Stale plan/);
  await f.tool("plan", planInput(f, {
    answers: [{ question: "How should empty input behave?", answer: "Return an empty result." }],
  }));
  assert.equal(f.state().phase, "BUILDING");
});

test("further plan clarification rounds retain prior answers and rotate the request", async () => {
  const f = fixture({ autoPlan: false });
  await f.start();
  await f.tool("plan", planInput(f, { decision: "clarify", questions: ["What is the input limit?"] }));
  const previous = planInput(f, {
    decision: "clarify", questions: ["Which error code applies above that limit?"],
    answers: [{ question: "What is the input limit?", answer: "One MiB." }],
  });
  await f.tool("plan", previous);
  await assert.rejects(f.tool("plan", previous), /Stale plan/);
  assert.equal(f.sessions.size, 1);
  await f.tool("plan", planInput(f, {
    answers: [{ question: previous.questions[0], answer: "INVALID_INPUT." }],
  }));
  assert.equal(f.state().planReview.answers.length, 2);
  assert.equal(f.state().history.filter(entry => entry.phase === "PLAN_REVIEWED").length, 3);
  assert.equal(f.state().jobs.filter(job => job.role === "builder").length, 1);
});

test("changed plans revoke preflight requests and later approvals, including external plan contents", async () => {
  const f = fixture({ autoPlan: false });
  await f.start();
  const old = planInput(f);
  f.changePlan();
  await f.tool("status", {});
  assert.equal(f.state().phase, "PLAN_REVIEW");
  assert.notEqual(f.state().planReview.request, old.request);
  await assert.rejects(f.tool("plan", old), /Stale plan/);
  await f.tool("plan", planInput(f));
  const g = fixture();
  await reviewReady(g);
  for (const role of reviewers) await g.tool("report", reportInput(g), role);
  assert.equal(g.state().phase, "APPROVED");
  g.changePlan();
  await g.tool("status", {});
  assert.equal(g.state().phase, "BLOCKED");
  assert.match(g.state().reason, /plan changed/);
  await g.gate.control("ses_root", "resume");
  assert.equal(g.state().phase, "PLAN_REVIEW");
});

test("missing and unreadable plans fail closed; a preflight deadline can resume without code rounds", async () => {
  const missing = fixture({ readPlan: async () => { throw new Error("plan missing"); } });
  await assert.rejects(missing.start(), /plan missing/);
  assert.equal(missing.deliveries.size, 0);
  const f = fixture({ autoPlan: false, maxRounds: 1 });
  await f.start();
  const old = planInput(f);
  f.advance(31 * 60 * 1000);
  await f.tool("plan", old);
  assert.equal(f.state().phase, "BLOCKED");
  assert.equal(f.state().round, 0);
  await f.gate.control("ses_root", "resume");
  assert.equal(f.state().phase, "PLAN_REVIEW");
  await assert.rejects(f.tool("plan", old), /Stale plan/);
  await f.tool("plan", planInput(f));
  assert.equal(f.state().phase, "BUILDING");
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
  assert.equal(f.deliveries.size, 6);
  const builder = f.sessions.get(f.state().sessions.builder);
  assert.deepEqual(builder.permissions, f.sessions.get("ses_root").permissions);
  const prompt = [...f.deliveries.values()].find(item => item.sessionID === builder.id).text;
  assert.match(prompt, /Original requirement/);
  assert.doesNotMatch(prompt, /biased builder summary/);
  await f.tool("report", reportInput(f), reviewers[0]);
  await f.tool("report", reportInput(f), reviewers[1]);
  assert.equal(f.state().phase, "REVIEWING");
  await f.tool("report", reportInput(f), reviewers[2]);
  assert.equal(f.state().phase, "APPROVED");
  assert.deepEqual(requiredReviewers(f.state()), reviewers);
  assert.equal(f.state().sessions[uiReviewer], undefined);
  assert(!f.state().jobs.some(job => job.role === uiReviewer));
});

test("UI scope and evidence are required, including an explicit no-UI reason", async () => {
  const f = fixture();
  await f.start();
  for (const ui of [undefined, { changes: "web" }, { changes: "maybe", evidence: "Unknown" },
    { changes: "none", evidence: " " }]) {
    const input = candidateInput();
    if (ui === undefined) delete input.ui;
    else input.ui = ui;
    await assert.rejects(f.tool("candidate", input, "builder"), /missing|invalid choice|cannot be empty/);
    assert.equal(f.state().phase, "BUILDING");
    assert.equal(f.state().round, 0);
  }
});

for (const changes of ["web", "non-web"]) {
  test(`${changes} UI specialist runs in parallel and requires a fourth approval`, async () => {
    const f = fixture({ autoFinish: false });
    await f.start();
    const ui = { changes, evidence: "Changed settings screen. Test URL: http://localhost:3000/settings" };
    await f.tool("candidate", { ...candidateInput(), ui }, "builder");
    assert.deepEqual(f.state().candidate.ui, ui);
    await f.finish("builder");
    assert.deepEqual(requiredReviewers(f.state()), [...reviewers, uiReviewer]);
    assert.equal(f.deliveries.size, 7);
    assert(f.sessions.has(f.state().sessions[uiReviewer]), "UI reviewer launched with baseline reviewers");
    assert(f.state().jobs.filter(job => reviewers.includes(job.role)).every(job => !job.finished));
    for (const role of reviewers) await f.tool("report", reportInput(f), role);
    assert.equal(f.state().phase, "REVIEWING", "three approvals cannot complete UI review");
    for (const role of reviewers.filter(role => role !== "test-engineer")) await f.finish(role);
    assert(f.state().jobs.some(job => job.role === uiReviewer), "UI review does not wait for the test engineer");
    await f.finish("test-engineer");
    assert.equal(f.state().jobs.at(-1).role, uiReviewer);
    assert.equal(f.state().phase, "REVIEWING");
    assert(f.state().jobs.filter(job => reviewers.includes(job.role)).every(job => job.finished));
    const prompt = [...f.deliveries.values()].at(-1).text;
    assert.match(prompt, /http:\/\/localhost:3000\/settings/);
    assert.match(prompt, /Playwright MCP/);
    await f.restart().reconcile();
    assert.equal(f.state().jobs.filter(job => job.role === uiReviewer).length, 1,
      "recovery does not duplicate the UI dispatch");
    await f.tool("report", reportInput(f, { evidence: "Independent rendered UI review passed" }), uiReviewer);
    assert.equal(f.state().phase, "REVIEW_HANDOFF");
    await f.finish(uiReviewer);
    assert.equal(f.state().phase, "APPROVED");
    assert.equal(f.writtenReports[0].run.reports[uiReviewer].evidence,
      "Independent rendered UI review passed");
  });
}

for (const changes of ["web", "non-web"]) {
  test(`${changes} UI scope and owner verification remain required across repair rounds`,
    () => verifyUIRepair(changes));
}

async function verifyUIRepair(changes) {
  const f = fixture();
  await f.start();
  await f.tool("candidate", {
    ...candidateInput(), ui: { changes, evidence: "Changed the settings page" },
  }, "builder");
  await f.finish("builder");
  for (const role of reviewers) await f.tool("report", reportInput(f), role);
  await f.tool("report", reportInput(f, {
    verdict: "changes_requested", findings: [{ ...finding, id: "clipped-label",
      description: "Label is clipped on mobile", location: "/settings at 375px" }],
  }), uiReviewer);
  assert.equal(f.state().phase, "TRIAGING");
  const findingID = f.state().findings[0].id;
  assert.equal(findingID, `${uiReviewer}:clipped-label`);
  await f.tool("triage", triageInput(f));
  const repair = candidateInput([{
    findingID, action: "fixed", reason: "Fixed label wrapping; checked mobile viewport",
  }]);
  await f.restart().reconcile();
  const before = f.state();
  for (const downgrade of changes === "web" ? ["none", "non-web"] : ["none"]) {
    await assert.rejects(f.tool("candidate", {
      ...repair, ui: { changes: downgrade, evidence: "Only the latest repair considered" },
    }, "builder"), /UI scope cannot be downgraded/);
    assert.deepEqual(f.state(), before, "rejected scope must not change proposals, candidate, or round");
  }
  await f.tool("candidate", {
    ...repair, ui: { changes, evidence: "Settings page still changed; verified the label repair" },
  }, "builder");
  assert(f.state().uiReviewRequired);
  assert.equal(f.state().candidate.ui.changes, changes);
  await f.finish("builder");
  await assert.rejects(f.tool("report", reportInput(f, {
    decisions: [{ findingID, outcome: "resolved", reason: "Not the owner" }],
  }), "test-engineer"), /owned by this reviewer/);
  for (const role of reviewers) await f.tool("report", reportInput(f), role);
  assert.equal(f.state().jobs.filter(job => job.role === uiReviewer).length, 2);
  await assert.rejects(f.tool("report", reportInput(f), uiReviewer), /open findings/);
  await f.tool("report", reportInput(f, {
    decisions: [{ findingID, outcome: "resolved", reason: "Verified mobile label in browser" }],
  }), uiReviewer);
  assert.equal(f.state().phase, "APPROVED");
}

test("every configured reviewer must be available at enrollment", async () => {
  const f = fixture();
  const checked = [];
  f.ctx.agent.get = async ({ agentID }) => {
    checked.push(agentID);
    if (agentID === uiReviewer) throw new Error("UI reviewer unavailable");
    return { id: agentID };
  };
  await assert.rejects(f.start(), /UI reviewer unavailable/);
  assert(checked.includes(uiReviewer));
  assert.equal(f.state(), undefined);
  assert.equal(f.deliveries.size, 0);
});

test("denied UI reviewer dispatch and blocked UI browser checks cannot approve", async () => {
  const f = fixture({ autoSelect: false });
  await f.start();
  f.ctx.permission.assert = async ({ resources }) => {
    if (resources.includes(uiReviewer)) throw new Error("UI review permission denied");
  };
  const input = { ...candidateInput(), ui: { changes: "web", evidence: "Changed a form" } };
  await f.tool("candidate", input, "builder");
  await f.finish("builder");
  const before = f.state();
  await assert.rejects(f.tool("select", selectionInput(f)), /permission denied/);
  assert.deepEqual(f.state(), before);
  f.ctx.permission.assert = async () => {};
  await f.tool("select", selectionInput(f));
  for (const role of reviewers) await f.tool("report", reportInput(f), role);
  await f.tool("report", reportInput(f, {
    verdict: "blocked", summary: "Playwright MCP cannot reach the test app",
  }), uiReviewer);
  assert.equal(f.state().phase, "BLOCKED");
  assert.equal(f.writtenReports.length, 0);
  assert.equal(f.openedReports.length, 0);
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
    await assert.rejects(f.tool("report", reportInput(f), reviewers[1]), /Stale dispatch/);
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
  assert.equal(f.deliveries.size, 6);
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
  await f.approvePlan();
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
  await f.tool("start", { task: "Implement the attached screenshot", plan: "PLAN.md" });
  const builderPrompt = [...f.deliveries.values()].find(item => item.sessionID === f.state().sessions.builder);
  const planPrompt = [...f.deliveries.values()].find(item => item.sessionID === "ses_root");
  assert.deepEqual(builderPrompt.files, [{
    uri: "data:image/png;base64,c2NyZWVuc2hvdA==", name: "spec.png",
  }]);
  assert.deepEqual(builderPrompt.skills, [{ id: "test-skill" }]);
  assert.deepEqual(planPrompt.files, builderPrompt.files, "the orchestrator receives the plan's supporting attachments");
  assert.deepEqual(planPrompt.skills, builderPrompt.skills);
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
  }, "PLAN.md");
  await f.approvePlan();
  const prompt = [...f.deliveries.values()].find(item => item.sessionID === f.state().sessions.builder);
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
  assert.equal([...f.deliveries.values()].filter(prompt => prompt.sessionID === "ses_root").length, 2);
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
  const notification = [...f.deliveries.values()].findLast(prompt => prompt.sessionID === "ses_root");
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
  await f.approvePlan();
  assert.equal(f.state().phase, "TRIAGING");
  assert.notEqual(f.state().triageRequest.id, stale.request);
  assert.equal(f.state().triageRequest.digest, "contents-b");
  await assert.rejects(f.tool("triage", stale), /Stale/);
  await assert.rejects(f.tool("candidate", candidateInput(), "builder"), /Stale dispatch/);
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
  await f.approvePlan();
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
  await assert.rejects(f.tool("candidate", candidateInput(), "builder"), /Stale dispatch/);
  assert.equal(f.state().candidate, null);
  assert.equal(f.state().jobs.filter(job => job.role === "builder").length, 1);
  f.ctx.session.interrupt = interrupt;
  await f.gate.control("ses_root", "resume");
  await f.approvePlan();
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
  await f.approvePlan();
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
  assert.deepEqual(f.writtenReports[0].narrative.executiveSummary, input.executiveSummary);
  assert.equal(f.openedReports[0], f.state().htmlReport.path);
  assert.equal(f.state().htmlReport.browser.state, "opened");
  await f.tool("report_html", input);
  assert.equal(f.writtenReports.length, 1);
  assert.equal(f.openedReports.length, 1);
  await assert.rejects(f.tool("report_html", { ...input, summary: "Replacement" }), /already recorded/);
});

test("invalid executive summaries can be corrected before freezing a draft or publishing", async () => {
  const f = fixture({ autoReport: false });
  await reportingReady(f);
  const input = htmlInput(f);
  for (const mutate of [
    copy => { delete copy.executiveSummary; },
    copy => { copy.executiveSummary.rounds = []; },
    copy => { copy.executiveSummary.rounds[0].candidate = "stale"; },
    copy => { copy.executiveSummary.rounds[0].reviewers = []; },
    copy => { copy.executiveSummary.rounds[0].reviewers[0].findings = []; },
    copy => { copy.executiveSummary.findings = "word ".repeat(601); },
  ]) {
    const invalid = structuredClone(input);
    mutate(invalid);
    await assert.rejects(f.tool("report_html", invalid), /executive|review round/i);
    assert.equal(f.state().phase, "REPORTING");
    assert.equal(f.state().reportDraft, null);
    assert.equal(f.writtenReports.length, 0);
    assert.equal(f.openedReports.length, 0);
  }
  await f.tool("report_html", input);
  assert.equal(f.state().phase, "APPROVED");
});

test("reporting cannot start early and cannot survive a changed candidate", async () => {
  const f = fixture({ autoReport: false });
  await f.start();
  await assert.rejects(f.tool("report_html", {
    request: "html_not_ready", candidate: "none", title: "Premature",
    summary: "Not approved", limitations: "No reviews yet",
    executiveSummary: { rounds: [], findings: "None", verification: "None", actions: "Wait for reviews" },
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
  const previous = f.state().candidate.id;
  const reports = f.state().reports;
  await f.gate.externalPrompt("ses_root", "msg_report_clarification", { text: "Also implement validation" });
  await f.gate.control("ses_root", "resume");
  await f.approvePlan();
  assert.equal(f.state().phase, "BUILDING");
  assert.deepEqual(f.state().reports, {});
  assert.equal(f.writtenReports.length, 0);
  await f.tool("candidate", candidateInput(), "builder");
  const rounds = reviewRounds(f.state());
  assert.equal(rounds.length, 2);
  assert.equal(rounds[0].candidate.id, previous);
  assert.deepEqual(rounds[0].reports, reports,
    "cleared current approvals must not erase the earlier round's historical evidence");
  assert.deepEqual(f.state().reports, {}, "historical verdicts are not current approvals");
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
