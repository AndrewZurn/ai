import { createHash, randomUUID } from "node:crypto";
import {
  candidate, inputs, packet, report, requireThat, requiredReviewers,
  terminal, triage, uiReviewer, validate, validateExecutiveSummary,
} from "./protocol.js";
import { snapshot, trackedFiles } from "./snapshot.js";
import { files, skills, uniqueFiles, uniqueSkills } from "./attachments.js";
import { recoverReportTemps, writeReport } from "./html-report.js";
import { openReport } from "./browser.js";
import { readPlan } from "./plan.js";
import { readWorkflow, validateWorkflow } from "./workflow.js";

// A location can reload its plugin while old callbacks are finishing. Share the
// queue in this module, but always reload durable state inside the lock.
const queues = new Map();
const id = prefix => `${prefix}_${randomUUID().replaceAll("-", "")}`;

export class SwarmController {
  constructor(ctx, directory, options = {}) {
    this.ctx = ctx;
    this.directory = directory;
    this.key = `runs/${createHash("sha256").update(directory).digest("hex")}/active`;
    this.snapshot = options.snapshot ?? snapshot;
    this.now = options.now ?? Date.now;
    this.maxRounds = options.maxRounds ?? 5;
    this.timeout = options.timeout ?? 30 * 60 * 1000;
    this.writeReport = options.writeReport ?? writeReport;
    this.openReport = options.openReport ?? openReport;
    this.readPlan = options.readPlan ?? readPlan;
    // Invalid edits must reject new enrollment, not disable recovery/status for
    // an existing run whose workflow is already saved in durable storage.
    try {
      this.workflow = validateWorkflow(options.workflow ?? (options.readWorkflow ?? readWorkflow)());
    } catch (error) {
      this.workflowError = error;
    }
    requireThat(Number.isInteger(this.maxRounds) && this.maxRounds > 0 &&
      Number.isFinite(this.timeout) && this.timeout > 0, "Invalid swarm limits.");
  }

  async locked(action) {
    const previous = queues.get(this.key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const stored = await this.ctx.storage.get(this.key);
      this.run = stored ? structuredClone(stored) : null;
      return action();
    });
    queues.set(this.key, next);
    try {
      return await next;
    } finally {
      if (queues.get(this.key) === next) queues.delete(this.key);
    }
  }

  async save() {
    await this.ctx.storage.set(this.key, this.run);
  }

  async fingerprint(directory) {
    const artifacts = await this.artifacts();
    if (artifacts.some(entry => entry.kind === "temporary")) {
      await recoverReportTemps(directory, {
        artifacts, tracked: await trackedFiles(directory),
        record: entry => this.recordArtifact(entry),
      });
    }
    return this.snapshot(directory, await this.artifacts());
  }

  async artifacts() {
    return await this.ctx.storage.get(`${this.key}/artifacts`) ?? [];
  }

  async recordArtifact(entry) {
    const artifacts = (await this.artifacts()).filter(record => record.file !== entry.file);
    if (!entry.remove) artifacts.push(entry);
    await this.ctx.storage.set(`${this.key}/artifacts`, artifacts);
  }

  role(sessionID) {
    if (!this.run) return null;
    if (sessionID === this.run.root) return "orchestrator";
    return Object.keys(this.run.sessions).find(role => this.run.sessions[role] === sessionID) ?? null;
  }

  async authorize(sessionID, expected, historical = false) {
    const role = this.role(sessionID);
    requireThat(role && expected.includes(role), "This session cannot perform this transition.");
    const session = await this.ctx.session.get({ sessionID });
    requireThat((historical && role === "orchestrator") || session.agent === role,
      "The registered session's agent has changed.");
    requireThat(session.location?.directory === this.run.location,
      "A managed session moved to another location.");
    requireThat(role === "orchestrator" || session.parentID === this.run.root,
      "Reviewer/builder session does not belong to this orchestrator.");
    return role;
  }

  job(role) {
    return this.run.jobs.findLast(job => job.role === role);
  }

  async messages(sessionID, type) {
    return [...await this.ctx.session.context({ sessionID })].reverse()
      .filter(message => !type || message.type === type);
  }

  async outcome(job) {
    const session = await this.ctx.session.get({ sessionID: job.sessionID });
    if (session.time.busy > (session.time.idle ?? 0)) return;
    // Record the previous idle ID before admitting each prompt. Sessions are
    // never reused while still running, so a different durable idle marker
    // belongs to this turn even if compaction removed the original prompt.
    const idle = (await this.messages(job.sessionID, "idle"))[0];
    if (job.sent && idle?.id !== job.priorIdleID) return idle;
  }

  async enqueue(role, kind = role === "orchestrator" ? "notification" : "work") {
    const sessionID = role === "orchestrator" ? this.run.root : this.run.sessions[role];
    const previous = this.job(role);
    const priorIdleID = previous
      ? (await this.messages(sessionID, "idle"))[0]?.id ?? previous.completionID ?? null
      : null;
    this.run.jobs.push({
      role, kind, sessionID, round: this.run.round, id: id("msg"), text: role === "orchestrator" &&
        !["triage", "html_report", "plan_review", "selection"].includes(kind)
        ? `Swarm: ${this.run.phase}. Call swarm_status and report the authoritative outcome. ${this.run.reason ?? ""}`
        : packet(this.run, role),
      sent: false, done: false, priorIdleID,
      created: this.now(), deadline: this.now() + this.timeout,
    });
  }

  async requestTriage() {
    const fingerprint = await this.fingerprint(this.directory);
    this.run.phase = "TRIAGING";
    this.run.triage = null;
    this.run.triageRequest = {
      id: id("triage"), candidate: this.run.candidate.id, digest: fingerprint.digest,
    };
    this.run.history.push({
      at: this.now(), phase: "TRIAGING", request: this.run.triageRequest,
    });
    await this.enqueue("orchestrator", "triage");
  }

  async dispatchReviews() {
    this.run.phase = "REVIEWING";
    for (const reviewer of requiredReviewers(this.run)) await this.enqueue(reviewer);
  }

  async authorizeReviewers(roles) {
    for (const role of roles) {
      await this.ctx.agent.get({ agentID: role });
      await this.ctx.permission.assert({
        sessionID: this.run.root, agent: "orchestrator", action: "subagent", resources: [role],
      });
    }
  }

  async requestSelection() {
    const specialists = Object.values(this.run.workflow?.reviewers ?? {}).some(entry => !entry.required);
    if (!specialists) {
      await this.authorizeReviewers(requiredReviewers(this.run));
      await this.checkPlan();
      await this.checkCandidate();
      if (this.run.phase === "HANDOFF") await this.dispatchReviews();
      return;
    }
    this.run.phase = "SELECTING";
    this.run.selectionRequest = {
      id: id("select"), candidate: this.run.candidate.id, requirements: this.requirementsDigest(),
    };
    await this.enqueue("orchestrator", "selection");
  }

  async selectReviewers(input) {
    requireThat(this.run.phase === "SELECTING", "The run is not accepting reviewer selection.");
    requireThat(input.request === this.run.selectionRequest.id &&
      input.candidate === this.run.candidate.id &&
      this.run.selectionRequest.requirements === this.requirementsDigest(), "Stale reviewer selection.");
    const specialists = Object.entries(this.run.workflow.reviewers)
      .filter(([, entry]) => !entry.required).map(([role]) => role);
    const roles = input.decisions.map(decision => decision.reviewer);
    requireThat(new Set(roles).size === roles.length && roles.length === specialists.length &&
      specialists.every(role => roles.includes(role)),
    "Select invoke/skip exactly once for every specialist, and no mandatory or unknown reviewers.");
    for (const decision of input.decisions) {
      requireThat(decision.action === "invoke" || !this.run.selectedReviewers.includes(decision.reviewer),
        "Previously selected specialists remain required for all repair rounds.");
    }
    await this.authorizeReviewers([...new Set([
      ...requiredReviewers(this.run),
      ...input.decisions.filter(decision => decision.action === "invoke").map(decision => decision.reviewer),
    ])]);
    // A permission prompt can outlive the candidate or this turn's deadline.
    await this.checkPlan();
    await this.checkCandidate();
    requireThat(this.run.phase === "SELECTING", "The run is not accepting reviewer selection.");
    if (this.now() >= this.job("orchestrator").deadline) {
      await this.block("Orchestrator reviewer selection finished after its deadline.");
      return;
    }
    // Validate and authorize the complete selection before changing durable state.
    for (const { reviewer, action } of input.decisions) {
      if (action === "invoke" && !this.run.selectedReviewers.includes(reviewer)) {
        this.run.selectedReviewers.push(reviewer);
        this.run.sessions[reviewer] = id("ses");
      }
    }
    this.run.candidate.reviewers = requiredReviewers(this.run);
    this.run.candidate.selection = input.decisions;
    this.run.history.push({ at: this.now(), phase: "REVIEWERS_SELECTED", ...input });
    this.job("orchestrator").done = true;
    this.job("orchestrator").finished = true;
    await this.dispatchReviews();
  }

  requirementsDigest() {
    return createHash("sha256").update(JSON.stringify({
      requirements: this.run.requirements, context: this.run.context,
      files: this.run.files, skills: this.run.skills,
      plan: this.run.plan,
    })).digest("hex");
  }

  async loadPlan(reference) {
    return this.readPlan(this.directory, reference, file => this.ctx.permission.assert({
      sessionID: this.run.root, agent: "orchestrator",
      action: "read", resources: [file],
    }));
  }

  async requestPlan(dispatch = true) {
    for (const job of this.run.jobs.filter(job => job.role === "orchestrator" && !job.done)) {
      job.done = true;
      job.cancelled = true;
    }
    this.run.phase = "PLAN_REVIEW";
    this.run.planReview = {
      request: id("plan"), requirements: this.requirementsDigest(),
      questions: this.run.planReview?.questions ?? [],
      answers: this.run.planReview?.answers ?? [],
    };
    await this.enqueue("orchestrator", "plan_review");
    // An admitted clarification already starts a root turn. Do not queue a
    // second prompt from inside its admission hook.
    if (!dispatch) this.job("orchestrator").sent = true;
  }

  async checkPlan() {
    if (!this.run?.plan || ["BLOCKED", "CANCELLED"].includes(this.run.phase)) return;
    let current;
    try {
      current = await this.loadPlan(this.run.plan.reference ?? this.run.plan.path);
    } catch (error) {
      await this.block(`Plan cannot be read: ${error.message}`);
      return;
    }
    if (current.sha256 === this.run.plan.sha256 && current.path === this.run.plan.path) return;
    this.run.plan = current;
    if (["PLAN_REVIEW", "CLARIFYING"].includes(this.run.phase)) {
      await this.requestPlan();
      await this.save();
    } else {
      await this.block("The plan changed. Resume to review the plan and obtain fresh approvals.");
    }
  }

  async acceptPlan(input) {
    requireThat(["PLAN_REVIEW", "CLARIFYING"].includes(this.run.phase), "The run is not accepting plan review.");
    requireThat(input.request === this.run.planReview.request &&
      this.run.planReview.requirements === this.requirementsDigest(), "Stale plan review request.");
    const pending = this.run.planReview.questions;
    const answered = input.answers.map(answer => answer.question);
    requireThat(new Set(answered).size === answered.length && answered.length === pending.length &&
      pending.every(question => answered.includes(question)), "Answer every pending plan question exactly once.");
    requireThat(new Set(input.questions).size === input.questions.length &&
      (input.decision === "ready" ? input.questions.length === 0 : input.questions.length > 0),
    "Ready requires no new questions; clarify requires specific unique questions.");
    this.run.planReview.answers.push(...input.answers);
    if (input.answers.length) {
      this.run.requirements += `\n\nPlan clarification answers:\n${JSON.stringify(input.answers)}`;
    }
    this.run.planReview.questions = input.questions;
    this.run.planReview.requirements = this.requirementsDigest();
    this.run.history.push({ at: this.now(), phase: "PLAN_REVIEWED", ...input });
    this.job("orchestrator").done = true;
    this.job("orchestrator").finished = true;
    if (input.decision === "clarify") {
      this.run.phase = "CLARIFYING";
      this.run.planReview.request = id("plan");
    } else {
      this.run.planReview.approved = this.requirementsDigest();
      if (this.run.findings.some(finding => finding.status === "open") ||
        Object.values(this.run.reports).some(report => report.verdict === "changes_requested")) {
        await this.requestTriage();
      } else {
        this.run.phase = "BUILDING";
        this.run.reports = {};
        await this.enqueue("builder");
      }
    }
  }

  approvedReviews() {
    return this.run.candidate && requiredReviewers(this.run).every(role =>
      this.run.reports[role]?.verdict === "approve" &&
      this.run.reports[role].candidate === this.run.candidate.id) &&
      !this.run.findings.some(finding => finding.status === "open");
  }

  async requestReport() {
    requireThat(this.approvedReviews(), "HTML reporting requires all required matching reviewer approvals.");
    this.run.phase = "REPORTING";
    this.run.reportRequest = {
      id: id("html"), candidate: this.run.candidate.id,
      requirements: this.requirementsDigest(), created: this.now(),
    };
    this.run.reportDraft = null;
    this.run.reportError = null;
    this.run.htmlReport = null;
    this.run.history.push({
      at: this.now(), phase: "REPORTING", candidate: this.run.candidate.id,
      request: this.run.reportRequest.id,
    });
    await this.enqueue("orchestrator", "html_report");
  }

  async renderReport(input, signal) {
    signal?.throwIfAborted();
    requireThat(["REPORTING", "APPROVED"].includes(this.run.phase),
      "The run is not accepting an HTML report.");
    requireThat(input.request === this.run.reportRequest?.id &&
      input.candidate === this.run.candidate.id &&
      this.run.reportRequest.requirements === this.requirementsDigest(),
    "Stale HTML report request or candidate.");
    requireThat(this.approvedReviews(), "HTML reporting requires all required matching reviewer approvals.");
    validateExecutiveSummary(this.run, input);
    if (this.run.reportDraft) {
      requireThat(JSON.stringify(this.run.reportDraft) === JSON.stringify(input),
        "The report narrative is already recorded; retry with the same content.");
    }
    if (this.run.phase === "APPROVED" && this.run.htmlReport?.request === input.request) return;
    this.run.reportDraft = input;
    await this.save(); // Freeze the narrative and generation time before file I/O.
    let artifact;
    try {
      signal?.throwIfAborted();
      artifact = await this.writeReport(structuredClone(this.run), input, {
        artifacts: await this.artifacts(), record: entry => this.recordArtifact(entry),
      });
      signal?.throwIfAborted();
    } catch (error) {
      this.run.reportError = error.message;
      await this.save();
      throw error;
    }
    await this.checkPlan();
    await this.checkCandidate();
    if (this.run.phase !== "REPORTING") return;
    if (this.now() >= this.job("orchestrator").deadline) {
      await this.block("Orchestrator HTML reporting finished after its deadline.");
      return;
    }
    this.run.htmlReport = { ...artifact, request: input.request, browser: { state: "requested" } };
    this.run.reportError = null;
    this.run.phase = "APPROVED";
    this.job("orchestrator").done = true;
    this.job("orchestrator").finished = true;
    this.run.history.push({
      at: this.now(), phase: "APPROVED", candidate: this.run.candidate.id, report: artifact.path,
    });
    // At-most-once launch attempt: a retry must not open duplicate browser tabs.
    await this.save();
    try {
      await this.openReport(artifact.path, signal);
      this.run.htmlReport.browser = { state: "opened" };
    } catch (error) {
      this.run.htmlReport.browser = { state: "failed", error: error.message };
    }
    await this.save();
  }

  async stopParticipants() {
    const participants = [...new Set(this.run.jobs
      .filter(job => job.role !== "orchestrator").map(job => job.sessionID))];
    const results = await Promise.allSettled(participants.map(async sessionID => {
      try {
        await this.ctx.session.get({ sessionID });
      } catch (error) {
        if (error?._tag === "SessionNotFoundError") return;
        throw error;
      }
      await this.ctx.session.interrupt({ sessionID, resume: false });
      const stopped = await this.ctx.session.get({ sessionID });
      requireThat(!(stopped.time.busy > (stopped.time.idle ?? 0)),
        `Session ${sessionID} is still running.`);
    }));
    return results.flatMap((result, index) => result.status === "rejected"
      ? [{ sessionID: participants[index], reason: result.reason?.message ?? String(result.reason) }]
      : []);
  }

  async block(reason, phase = "BLOCKED") {
    this.run.phase = phase;
    this.run.reason = reason;
    this.run.history.push({
      at: this.now(), phase, reason, candidate: this.run.candidate, reports: this.run.reports,
    });
    // Persist the failure before cancellation: late reports can never approve.
    for (const job of this.run.jobs) {
      job.done = true;
      job.cancelled = true;
    }
    const root = await this.ctx.session.get({ sessionID: this.run.root }).catch(() => null);
    if (root?.agent === "orchestrator" && root.location.directory === this.run.location) {
      await this.enqueue("orchestrator");
    }
    await this.save();
    this.run.stopFailures = await this.stopParticipants();
    await this.save();
  }

  async checkCandidate() {
    if (!this.run?.candidate ||
      !["HANDOFF", "SELECTING", "REVIEWING", "REVIEW_HANDOFF", "TRIAGING", "REPORTING", "APPROVED"].includes(this.run.phase)) return;
    try {
      const current = await this.fingerprint(this.directory);
      const digest = this.run.phase === "TRIAGING"
        ? this.run.triageRequest.digest : this.run.candidate.digest;
      if (current.digest !== digest) {
        await this.block("Candidate contents changed. Resume to build and obtain new approvals from all required reviewers.");
      }
    } catch (error) {
      await this.block(`Candidate cannot be verified: ${error.message}`);
    }
  }

  async flush() {
    // Session IDs and prompt IDs are saved before dispatch. Both create and
    // prompt are idempotent in V2, including after a crash between send/save.
    const pending = this.run.jobs.filter(job => !job.sent && !job.done);
    const results = await Promise.allSettled(pending.map(async job => {
      if (job.role !== "orchestrator") {
        await this.ctx.session.create({
          id: job.sessionID, parentID: this.run.root, agent: job.role,
          title: `${job.role}: ${this.run.id}`,
          // Preserve user session restrictions. The orchestrator's agent-only
          // read-only rules are not copied; child rules and gate hooks apply.
          permissions: this.run.permissions,
          metadata: { reviewGate: this.run.id, role: job.role },
        });
      } else {
        const root = await this.ctx.session.get({ sessionID: job.sessionID }).catch(() => null);
        if (root?.agent !== "orchestrator" || root.location.directory !== this.run.location) {
          job.done = true;
          job.cancelled = true;
          return;
        }
      }
      await this.ctx.session.prompt({
        sessionID: job.sessionID, id: job.id, text: job.text,
          ...(job.role === "orchestrator" && job.kind !== "plan_review" ? {} : {
          files: this.run.files, skills: this.run.skills,
        }),
        metadata: { reviewGateInternal: true, run: this.run.id },
        delivery: "queue",
      });
      job.sent = true;
    }));
    await this.save();
    const failure = results.find(result => result.status === "rejected");
    if (failure && !terminal(this.run.phase)) {
      await this.block(`Dispatch failed: ${failure.reason.message}`);
      // Leave the notification in the outbox for status/recovery to retry.
    }
  }

  async start(sessionID, task, attachments = {}, plan) {
    return this.locked(async () => {
      validate(inputs.start, { task, plan });
      const root = await this.ctx.session.get({ sessionID });
      requireThat(root.agent === "orchestrator",
        "Start from an orchestrator session or use /swarm.");
      requireThat(root.location.directory === this.directory,
        "Start the swarm from the canonical repository root, not a nested directory.");
      requireThat(!this.run || terminal(this.run.phase),
        "This checkout already has an active run. Cancel it before starting another.");
      if (this.workflowError) throw this.workflowError;
      const document = await this.readPlan(this.directory, plan, file => this.ctx.permission.assert({
        sessionID, agent: "orchestrator", action: "read", resources: [file],
      }));
      const workflow = structuredClone(this.workflow);
      for (const [role, entry] of Object.entries(workflow.reviewers)) {
        const agent = await this.ctx.agent.get({ agentID: role });
        requireThat(typeof agent.description === "string" && agent.description.trim().length > 0,
          `Reviewer ${role} needs a nonempty description for selection.`);
        entry.description = agent.description;
      }
      const mandatory = Object.entries(workflow.reviewers)
        .filter(([, entry]) => entry.required).map(([role]) => role);
      // Fail before dispatch if one of the required agents is unavailable or denied.
      for (const agent of ["builder", ...mandatory]) {
        await this.ctx.agent.get({ agentID: agent });
        await this.ctx.permission.assert({
          sessionID, agent: "orchestrator", action: "subagent", resources: [agent],
        });
      }
      await this.fingerprint(this.directory); // Require a supported Git checkout.
      const users = (await this.messages(sessionID, "user")).reverse()
        .filter(message => !message.metadata?.reviewGateInternal);
      const context = users.map(message => ({
        text: message.text,
        files: (message.files ?? []).map(({ name, description, source }) => ({
          name: name ?? "attachment", ...(description ? { description } : {}),
          ...(source ? { source } : {}),
        })),
        skills: skills(message.skills),
      }));
      if (this.run) {
        this.run.stopFailures = await this.stopParticipants();
        await this.save();
        requireThat(this.run.stopFailures.length === 0,
          "Cannot start a new run: prior child turns could not be confirmed stopped.");
        await this.ctx.storage.set(`${this.key}/${this.run.id}`, this.run);
      }
      this.run = {
        version: 2, id: id("run"), root: sessionID, directory: this.directory,
        location: root.location.directory,
        requirements: task, context, plan: document,
        files: uniqueFiles([...users.flatMap(user => files(user.files)), ...files(attachments.files)]),
        skills: uniqueSkills([...users.flatMap(user => skills(user.skills)), ...skills(attachments.skills)]),
        permissions: root.permissions ?? [],
        phase: "PLAN_REVIEW", round: 0, maxRounds: this.maxRounds,
        workflow, selectedReviewers: [], selectionRequest: null,
        sessions: Object.fromEntries(["builder", ...mandatory].map(role => [role, id("ses")])),
        jobs: [], findings: [], reports: {}, history: [], candidate: null,
        triageRequest: null, triage: null, reportRequest: null, htmlReport: null,
      };
      await this.requestPlan();
      await this.save();
      await this.flush();
      return this.run;
    });
  }

  async tool(name, input, sessionID, signal) {
    validate(inputs[name], input);
    if (name === "start") return this.start(sessionID, input.task, {}, input.plan);
    // Tool calls can already be queued behind a resume transaction when their
    // old execution is interrupted. Bind them before acquiring the lock.
    const admitted = ["candidate", "report"].includes(name)
      ? (await this.ctx.storage.get(this.key))?.jobs.findLast(job => job.sessionID === sessionID)?.id
      : null;
    return this.locked(async () => {
      requireThat(this.run, "No swarm run exists in this checkout.");
      const role = await this.authorize(sessionID, name === "candidate" ? ["builder"]
        : name === "report" ? requiredReviewers(this.run) : ["triage", "report_html", "plan", "select"].includes(name) ? ["orchestrator"]
        : ["orchestrator", "builder", ...requiredReviewers(this.run)], name === "status");
      await this.checkPlan();
      await this.checkCandidate();
      if (["candidate", "report"].includes(name)) {
        requireThat(admitted && admitted === this.job(role)?.id && !this.job(role).cancelled,
          "Stale dispatch: this call belongs to a previous or undispatched turn.");
      }
      if (name === "select") {
        requireThat(this.run.phase === "SELECTING", "The run is not accepting reviewer selection.");
      } else if (name === "plan") {
        requireThat(["PLAN_REVIEW", "CLARIFYING"].includes(this.run.phase), "The run is not accepting plan review.");
      } else if (name === "report_html") {
        requireThat(["REPORTING", "APPROVED"].includes(this.run.phase),
          "The run is not accepting an HTML report.");
      } else if (name === "triage") {
        requireThat(this.run.phase === "TRIAGING", "The run is not accepting triage.");
      }
      const job = this.job(role);
      if (name === "report") {
        requireThat(job.round === undefined || job.round === this.run.round,
          "This reviewer has not been dispatched for the current round.");
      }
      if (name !== "status" && job && !job.finished && !job.cancelled &&
        this.now() >= job.deadline) {
        await this.block(`${role} submitted after its deadline.`);
        await this.flush();
        return this.run;
      }
      if (name === "select") {
        await this.selectReviewers(input);
      } else if (name === "plan") {
        await this.acceptPlan(input);
      } else if (name === "report_html") {
        await this.renderReport(input, signal);
      } else if (name === "triage") {
        const next = structuredClone(this.run);
        triage(next, input);
        this.run = next;
        this.job("orchestrator").done = true;
        this.job("orchestrator").finished = true;
        this.run.history.push({ at: this.now(), phase: "TRIAGED", ...input });
        await this.enqueue("builder");
      } else if (name === "candidate") {
        // Mutate a copy: a rejected response must not partially change the ledger.
        const next = structuredClone(this.run);
        next.history.push({
          at: this.now(), candidate: next.candidate, reports: next.reports,
        });
        candidate(next, input, await this.fingerprint(this.directory));
        if (!next.workflow && requiredReviewers(next).includes(uiReviewer) && !next.sessions[uiReviewer]) {
          await this.ctx.agent.get({ agentID: uiReviewer });
          await this.ctx.permission.assert({
            sessionID: this.run.root, agent: "orchestrator", action: "subagent", resources: [uiReviewer],
          });
          next.sessions[uiReviewer] = id("ses");
        }
        this.run = next;
        this.job("builder").done = true;
        this.run.history.push({ at: this.now(), phase: "HANDOFF", candidate: next.candidate.id });
      } else if (name === "report") {
        const next = structuredClone(this.run);
        report(next, role, input);
        this.run = next;
        this.job(role).done = true;
        if (input.verdict === "blocked") {
          await this.block(`${role} blocked the candidate: ${input.summary}`);
        } else if (requiredReviewers(this.run).every(reviewer => this.run.reports[reviewer])) {
          // Do not reuse any child session until its submitted turn ends.
          // A fast dismissal round could otherwise overtake a prior reviewer.
          this.run.phase = "REVIEW_HANDOFF";
        }
      }
      await this.save();
      await this.flush();
      return this.run;
    });
  }

  async control(sessionID, command) {
    return this.locked(async () => {
      requireThat(this.run, "No swarm run exists in this checkout.");
      await this.authorize(sessionID, ["orchestrator"], command === "cancel");
      if (command === "cancel") {
        await this.block("Cancelled by the user. No approval was issued.", "CANCELLED");
      } else if (command === "resume") {
        requireThat(this.run.phase === "BLOCKED", "Only a blocked run can resume.");
        requireThat(this.run.plan, "This legacy run has no plan. Start a new /swarm --plan <path> run.");
        this.run.plan = await this.loadPlan(this.run.plan.reference ?? this.run.plan.path);
        const reportResume = this.run.reportRequest && this.approvedReviews() &&
          this.run.reportRequest.candidate === this.run.candidate.id &&
          this.run.reportRequest.requirements === this.requirementsDigest() &&
          (await this.fingerprint(this.directory)).digest === this.run.candidate.digest;
        requireThat(reportResume || this.run.round < this.run.maxRounds,
          "Round limit reached. Start a new run explicitly.");
        this.run.stopFailures = await this.stopParticipants();
        await this.save();
        requireThat(this.run.stopFailures.length === 0,
          "Cannot resume: prior child turns could not be confirmed stopped. Retry after resolving stopFailures.");
        this.run.reason = null;
        if (this.run.plan && this.run.planReview?.approved !== this.requirementsDigest()) {
          await this.requestPlan();
        } else if (reportResume) {
          await this.requestReport();
        } else if (this.run.findings.some(finding => finding.status === "open") ||
          Object.values(this.run.reports).some(report => report.verdict === "changes_requested")) {
          await this.requestTriage();
        } else {
          this.run.phase = "BUILDING";
          this.run.reports = {};
          await this.enqueue("builder");
        }
      }
      await this.checkCandidate();
      await this.save();
      await this.flush();
      return this.run;
    });
  }

  async externalPrompt(sessionID, messageID, prompt, metadata) {
    if (metadata?.reviewGateInternal) return;
    return this.locked(async () => {
      if (!this.run || this.run.root !== sessionID || this.run.phase === "CANCELLED") return;
      const root = await this.ctx.session.get({ sessionID });
      if (root.agent !== "orchestrator" || root.location.directory !== this.run.location) {
        if (!terminal(this.run.phase)) await this.block("The primary session left the workflow.");
        return;
      }
      if (this.run.history.some(entry => entry.messageID === messageID)) return;
      this.run.requirements += `\n\nUser clarification:\n${prompt.text}`;
      this.run.files = uniqueFiles([...this.run.files, ...files(prompt.files)]);
      this.run.skills = uniqueSkills([...this.run.skills, ...skills(prompt.skills)]);
      this.run.history.push({ at: this.now(), messageID, clarification: prompt.text });
      if (["PLAN_REVIEW", "CLARIFYING"].includes(this.run.phase)) {
        this.job("orchestrator").done = true;
        this.job("orchestrator").finished = true;
        await this.requestPlan(false);
        await this.save();
        return;
      }
      await this.block("New user input invalidated the candidate. Use /swarm-resume after clarifying requirements.");
      await this.flush();
    });
  }

  async reconcile() {
    return this.locked(async () => {
      if (!this.run) return;
      const root = await this.ctx.session.get({ sessionID: this.run.root });
      if (!terminal(this.run.phase) && (root.agent !== "orchestrator" ||
        root.location.directory !== this.run.location)) {
        await this.block("The orchestrator changed agent or location.");
      }
      await this.checkPlan();
      await this.checkCandidate();
      await this.flush();
      if (this.run.phase === "APPROVED" && this.run.htmlReport?.browser?.state === "requested") {
        this.run.htmlReport.browser = {
          state: "unknown", error: "Browser launch was interrupted; open the report file manually.",
        };
        await this.save();
      }
      if (terminal(this.run.phase)) return;
      const triageJob = this.job("orchestrator");
      if (["PLAN_REVIEW", "SELECTING", "TRIAGING", "REPORTING"].includes(this.run.phase) &&
        ["plan_review", "selection", "triage", "html_report"].includes(triageJob?.kind) &&
        !triageJob.done && this.now() >= triageJob.deadline) {
        await this.block(`Orchestrator ${this.run.phase.toLowerCase()} exceeded its deadline.`);
      }
      for (const job of this.run.jobs.filter(job =>
        job.role !== "orchestrator" && !job.finished && !job.cancelled)) {
        const completion = await this.outcome(job);
        if (completion && (!Number.isFinite(completion.time?.created) ||
          completion.time.created >= job.deadline)) {
          await this.block(`${job.role} completed after its deadline or has unverifiable timing.`);
          break;
        }
        if (!completion && this.now() >= job.deadline) {
          await this.block(`${job.role} exceeded its deadline.`);
          break;
        }
        const outcome = completion?.outcome;
        if (outcome === "failed" || outcome === "interrupted") {
          await this.block(`${job.role} ${outcome}.`);
          break;
        }
        if (outcome === "succeeded") {
          job.finished = true;
          job.completionID = completion.id;
          if (!job.done) {
            await this.block(`${job.role} stopped without the required structured submission.`);
            break;
          }
        }
      }
      if (this.run.phase === "HANDOFF" && this.job("builder").finished) {
        await this.requestSelection();
      }
      // Recover older runs without changing their enrolled reviewer membership.
      if (!this.run.workflow && this.run.phase === "REVIEWING" &&
        requiredReviewers(this.run).includes(uiReviewer) &&
        this.job(uiReviewer)?.round !== this.run.round) {
        await this.enqueue(uiReviewer);
      }
      if (this.run.phase === "REVIEW_HANDOFF" &&
        requiredReviewers(this.run).every(role => this.job(role)?.finished)) {
        if (this.approvedReviews()) {
          await this.checkCandidate();
          if (this.run.phase === "REVIEW_HANDOFF") {
            await this.requestReport();
          }
        } else if (this.run.round >= this.run.maxRounds) {
          await this.block("Review round limit reached with outstanding changes.");
        } else {
          await this.requestTriage();
        }
      }
      await this.save();
      await this.flush();
    });
  }

  async inspect(sessionID) {
    // Hooks can run during a locked dispatch or permission assertion. A durable
    // read avoids re-entering that lock and never observes uncommitted changes.
    const run = await this.ctx.storage.get(this.key);
    const role = run && (run.root === sessionID ? "orchestrator"
      : Object.keys(run.sessions).find(role => run.sessions[role] === sessionID));
    if (role === "orchestrator") {
      const session = await this.ctx.session.get({ sessionID });
      if (session.agent !== "orchestrator" || session.location.directory !== run.location) {
        return { phase: run.phase };
      }
    }
    return {
      role, phase: run?.phase,
      submitted: role ? run.jobs.findLast(job => job.role === role)?.done : false,
    };
  }

  async fail(error) {
    return this.locked(async () => {
      if (this.run && !terminal(this.run.phase)) {
        await this.block(`Controller error: ${error.message}`);
        await this.flush();
      }
    });
  }
}
