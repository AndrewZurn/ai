import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { recoverReportTemps, renderReport, writeReport } from "../lib/html-report.js";
import { browserCommand } from "../lib/browser.js";
import { reportFilename } from "../lib/artifact-paths.js";
import { snapshot, trackedFiles } from "../lib/snapshot.js";
import { reviewers } from "../lib/protocol.js";
import { SwarmController } from "../lib/controller.js";

function data(directory = "/repo") {
  const candidate = { id: "2:candidate-digest", digest: "candidate-digest",
    summary: "Added the required guard", evidence: "node --test: 12 passed" };
  const run = {
    id: `run_${"a".repeat(32)}`, root: "ses_root", directory, round: 2,
    candidate, reportRequest: { id: `html_${"b".repeat(32)}`, created: 1_800_000_000_000 },
    requirements: "Handle empty inputs and preserve compatibility.",
    reports: Object.fromEntries(reviewers.map(role => [role, {
      candidate: candidate.id, verdict: "approve", summary: `${role} verified`,
      evidence: `${role} independent evidence`,
    }])),
    findings: [{
      id: "test-engineer:empty-input", reviewer: "test-engineer", severity: "major",
      kind: "defect", status: "resolved", round: 1, location: "code.js:3",
      description: "Empty input crashes", expected: "Return empty result", actual: "Throws",
      reproduction: "parse('')", recommendation: "Add a guard",
      decisions: [{
        round: 2, outcome: "resolved", reason: "Verified the original reproduction",
        triage: { action: "fix", reason: "The requirement is explicit" },
        proposal: { action: "fixed", reason: "Guard implemented and regression test passes" },
      }],
    }],
    history: [{
      phase: "TRIAGED", request: "triage_request", summary: "Repair the guard",
      decisions: [{ findingID: "test-engineer:empty-input", action: "fix", reason: "Required behavior" }],
    }, {
      candidate: { id: "1:seed", summary: "First attempt", evidence: "Initial test evidence" },
      reports: { "test-engineer": { verdict: "changes_requested",
        summary: "Missing guard", evidence: "Original reproduction fails" } },
    }],
  };
  const narrative = {
    title: "Task review summary", summary: "The defect was fixed and independently verified.",
    limitations: "Finite testing only; no performance measurements.",
  };
  return { run, narrative };
}

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "swarm-html-test-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: root });
  await fs.writeFile(path.join(root, "code.js"), "candidate\n");
  const artifacts = [];
  const record = async entry => {
    const index = artifacts.findIndex(item => item.file === entry.file);
    if (index !== -1) artifacts.splice(index, 1);
    if (!entry.remove) artifacts.push(structuredClone(entry));
  };
  const write = (run, narrative) => writeReport(run, narrative, {
    artifacts: structuredClone(artifacts), record,
  });
  return { root, artifacts, record, write, ...data(root) };
}

test("HTML summarizes authoritative verdicts, findings, triage, fixes, evidence, and limitations", () => {
  const { run, narrative } = data();
  const html = renderReport(run, narrative);
  for (const text of [
    "<!doctype html>", 'lang="en"', "<title>Task review summary</title>",
    "All three reviewers approved", "Repair the guard", "Required behavior",
    "Guard implemented", "Verified the original reproduction", "12 passed",
    "Original reproduction fails", "Finite testing only", "Handle empty inputs",
    run.id, run.candidate.id,
  ]) assert(html.includes(text), text);
  for (const role of reviewers) assert(html.includes(`${role} independent evidence`));
  assert.match(html, /point-in-time record/);
  assert.doesNotMatch(html, /<script|<iframe|<form|<link|<img/i);
  assert.match(html, /Content-Security-Policy/);
});

test("all model/reviewer text is escaped rather than executable HTML", () => {
  const { run, narrative } = data();
  const payload = '<script>alert("x")</script><img src=x onerror="evil()"> & \'quoted\'';
  narrative.title = payload;
  narrative.summary = payload;
  narrative.limitations = payload;
  run.requirements = payload;
  run.findings[0].description = payload;
  run.findings[0].decisions[0].triage.reason = payload;
  run.reports["test-engineer"].evidence = payload;
  run.history[0].decisions[0].reason = payload;
  const html = renderReport(run, narrative);
  assert(!html.includes(payload));
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)/);
  assert.match(html, /&amp; &#39;quoted&#39;/);
  assert.doesNotMatch(html, /<script|<img/i);
});

test("HTML refuses missing, mismatched or incomplete approvals", () => {
  for (const mutate of [
    run => { delete run.reports["test-engineer"]; },
    run => { run.reports["test-engineer"].verdict = "changes_requested"; },
    run => { run.reports["test-engineer"].candidate = "old"; },
    run => { run.findings[0].status = "open"; },
  ]) {
    const { run, narrative } = data();
    mutate(run);
    assert.throws(() => renderReport(run, narrative), /matching approvals/);
  }
});

test("writes a private self-contained report at repository-root/.swarms with safe idempotent publication", async t => {
  const { root, run, narrative, write, artifacts } = await fixture(t);
  const before = await snapshot(root);
  const report = await write(run, narrative);
  assert.equal(report.path, path.join(root, ".swarms", reportFilename(run)));
  assert.match(await fs.readFile(report.path, "utf8"), /Task review summary/);
  assert.equal((await fs.stat(report.path)).mode & 0o777, 0o600);
  assert.deepEqual(await write(run, narrative), report);
  assert.deepEqual(await fs.readdir(path.dirname(report.path)), [path.basename(report.path)]);
  assert.equal((await snapshot(root, artifacts)).digest, before.digest, "report must not invalidate candidate");
  await assert.rejects(write(run, { ...narrative, summary: "Different report" }), /refusing to overwrite/);
  assert.match(await fs.readFile(report.path, "utf8"), /independently verified/);
});

test("only recorded unchanged untracked artifacts are excluded; lookalikes and tracked files are reviewed", async t => {
  const { root, run, narrative, write, artifacts } = await fixture(t);
  const before = await snapshot(root);
  await write(run, narrative);
  assert.equal((await snapshot(root, artifacts)).digest, before.digest);
  assert.notEqual((await snapshot(root)).digest, before.digest, "a name alone is not provenance");
  const temporary = path.join(root, ".swarms",
    `.${reportFilename(run)}.tmp-${"c".repeat(32)}`);
  await fs.writeFile(temporary, "temporary report");
  assert.notEqual((await snapshot(root, artifacts)).digest, before.digest,
    "user-created temporary lookalikes must not be excluded");
  await fs.unlink(temporary);
  const lookalike = path.join(root, ".swarms", `run_${"d".repeat(32)}-html_${"e".repeat(32)}.html`);
  await fs.writeFile(lookalike, "user HTML");
  const first = await snapshot(root, artifacts);
  assert.notEqual(first.digest, before.digest);
  await fs.appendFile(lookalike, "changed during review");
  assert.notEqual((await snapshot(root, artifacts)).digest, first.digest);
  await fs.unlink(lookalike);
  const notes = path.join(root, ".swarms", "notes.txt");
  await fs.writeFile(notes, "ordinary user file");
  assert.notEqual((await snapshot(root, artifacts)).digest, before.digest);
  await fs.unlink(notes);
  execFileSync("git", ["add", "--", `.swarms/${reportFilename(run)}`], { cwd: root });
  const tracked = await snapshot(root, artifacts);
  assert(tracked.files.includes(`.swarms/${reportFilename(run)}`));
  const previous = tracked.digest;
  await fs.appendFile(path.join(root, ".swarms", reportFilename(run)), "\ntracked change");
  assert.notEqual((await snapshot(root, artifacts)).digest, previous);
});

test("refuses symlink output directories and destinations without changing existing files", async t => {
  const { root, run, narrative, write } = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-html-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.symlink(outside, path.join(root, ".swarms"));
  await assert.rejects(write(run, narrative), /not a symlink/);
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.unlink(path.join(root, ".swarms"));
  await fs.mkdir(path.join(root, ".swarms"));
  const victim = path.join(outside, "user.html");
  await fs.writeFile(victim, "keep this file");
  await fs.symlink(victim, path.join(root, ".swarms", reportFilename(run)));
  await assert.rejects(write(run, narrative));
  assert.equal(await fs.readFile(victim, "utf8"), "keep this file");
  assert.deepEqual(await fs.readdir(path.join(root, ".swarms")), [reportFilename(run)]);
});

test("rejects invalid report paths and approval before making any output directory", async t => {
  const { root, run, narrative, write } = await fixture(t);
  run.id = "../../escape";
  await assert.rejects(write(run, narrative), /Invalid report identity/);
  await assert.rejects(fs.access(path.join(root, ".swarms")), { code: "ENOENT" });
});

test("idempotent publication rejects an existing report with broader permissions", async t => {
  const { run, narrative, write } = await fixture(t);
  const report = await write(run, narrative);
  await fs.chmod(report.path, 0o644);
  await assert.rejects(write(run, narrative), /not private/);
  assert.equal((await fs.stat(report.path)).mode & 0o777, 0o644,
    "do not silently change the user's file permissions");
});

test("recorded reports remain fingerprinted if edited, replaced or made public", async t => {
  const { root, run, narrative, write, artifacts } = await fixture(t);
  const before = await snapshot(root);
  const report = await write(run, narrative);
  const content = await fs.readFile(report.path);
  await fs.appendFile(report.path, "user change");
  assert.notEqual((await snapshot(root, artifacts)).digest, before.digest);
  await fs.writeFile(report.path, content);
  assert.equal((await snapshot(root, artifacts)).digest, before.digest);
  await fs.chmod(report.path, 0o644);
  assert.notEqual((await snapshot(root, artifacts)).digest, before.digest);
  await fs.chmod(report.path, 0o600);
  const replaced = `${report.path}.replacement`;
  await fs.writeFile(replaced, content, { mode: 0o600 });
  await fs.rename(replaced, report.path);
  assert.notEqual((await snapshot(root, artifacts)).digest, before.digest);
  await assert.rejects(write(run, narrative), /recorded identity/);
});

test("a report with identical content but no provenance is not adopted", async t => {
  const { root, run, narrative, write, artifacts } = await fixture(t);
  await fs.mkdir(path.join(root, ".swarms"));
  const file = path.join(root, ".swarms", reportFilename(run));
  await fs.writeFile(file, renderReport(run, narrative), { mode: 0o600 });
  const before = await snapshot(root);
  await assert.rejects(write(run, narrative), /not a recorded swarm artifact/);
  assert.equal((await snapshot(root, artifacts)).digest, before.digest);
  await assert.rejects(write(run, narrative), /not a recorded swarm artifact/);
});

test("durable publication provenance permits retry after a crash following the atomic link", async t => {
  const { root, run, narrative, record, artifacts, write } = await fixture(t);
  let crash = true;
  await assert.rejects(writeReport(run, narrative, {
    artifacts: [],
    record: async entry => {
      await record(entry);
      if (entry.remove && crash) {
        crash = false;
        throw new Error("crash after atomic publication");
      }
    },
  }), /crash after atomic publication/);
  const before = await snapshot(root, artifacts);
  const report = await write(run, narrative);
  assert.match(await fs.readFile(report.path, "utf8"), /Task review summary/);
  assert.equal((await snapshot(root, artifacts)).digest, before.digest);
});

test("a crash after provenance persistence but before publication can retry safely", async t => {
  const { root, run, narrative, record, artifacts, write } = await fixture(t);
  const before = await snapshot(root);
  await assert.rejects(writeReport(run, narrative, {
    artifacts: [],
    record: async entry => {
      await record(entry);
      if (entry.kind === "report") throw new Error("crash before publication");
    },
  }), /crash before publication/);
  assert.equal((await snapshot(root, artifacts)).digest, before.digest);
  await write(run, narrative);
  assert.equal((await snapshot(root, artifacts)).digest, before.digest);
});

for (const partial of ["", "<!doctype html><html>"]) {
  test(`controller restart recovers a real process exit with ${partial ? "partial" : "empty"} temporary HTML`, async t => {
    const { root, run, narrative } = await fixture(t);
    const before = await snapshot(root);
    const journal = path.join(root, ".git", "crash-provenance.json");
    const source = `
      import fs from "node:fs/promises";
      import path from "node:path";
      import { writeReport } from ${JSON.stringify(new URL("../lib/html-report.js", import.meta.url).href)};
      const [run, narrative, journal, partial] = JSON.parse(process.argv[1]);
      await writeReport(run, narrative, {
        artifacts: [],
        record: async entry => {
          await fs.writeFile(journal, JSON.stringify([entry]));
          if (entry.kind === "temporary") {
            if (partial) await fs.writeFile(path.join(run.directory, entry.file), partial);
            process.exit(73); // No finally handlers: leave the in-progress write on disk.
          }
        },
      });
    `;
    assert.throws(() => execFileSync(process.execPath, [
      "--input-type=module", "-e", source, JSON.stringify([run, narrative, journal, partial]),
    ]), error => error.status === 73);
    const artifacts = JSON.parse(await fs.readFile(journal, "utf8"));
    const temporary = path.join(root, artifacts[0].file);
    assert.equal(await fs.readFile(temporary, "utf8"), partial);
    assert.notEqual((await snapshot(root, artifacts)).digest, before.digest,
      "the incomplete file is not hidden merely because it has provenance");

    const stored = new Map();
    const opened = [];
    const ctx = {
      storage: {
        get: async key => structuredClone(stored.get(key)),
        set: async (key, value) => { stored.set(key, structuredClone(value)); },
      },
      session: {
        get: async () => ({ agent: "orchestrator", location: { directory: root }, time: {} }),
      },
    };
    const options = { openReport: async file => { opened.push(file); } };
    const original = new SwarmController(ctx, root, options);
    Object.assign(run, {
      phase: "REPORTING", location: root, sessions: {}, maxRounds: run.round,
      context: [], files: [], skills: [],
      jobs: [{
        role: "orchestrator", kind: "html_report", sessionID: run.root,
        sent: true, done: false, deadline: Date.now() + 60_000,
      }],
    });
    run.candidate.digest = before.digest;
    original.run = run;
    run.reportRequest.requirements = original.requirementsDigest();
    await ctx.storage.set(original.key, run);
    await ctx.storage.set(`${original.key}/artifacts`, artifacts);

    const restarted = new SwarmController(ctx, root, options);
    await restarted.reconcile();
    assert.equal(stored.get(restarted.key).phase, "REPORTING",
      "recovery must not consume or require a fresh code-review round");
    await assert.rejects(fs.access(temporary), { code: "ENOENT" });
    assert.deepEqual(stored.get(`${restarted.key}/artifacts`), []);
    const result = await restarted.tool("report_html", {
      request: run.reportRequest.id, candidate: run.candidate.id, ...narrative,
    }, run.root);
    assert.equal(result.phase, "APPROVED");
    assert.deepEqual(opened, [result.htmlReport.path]);
    assert.equal((await snapshot(root, stored.get(`${restarted.key}/artifacts`))).digest, before.digest);
  });
}

test("temporary recovery preserves replaced files, non-private files and symlinked directories", async t => {
  const { root, run, record, artifacts } = await fixture(t);
  await fs.mkdir(path.join(root, ".swarms"));
  const relative = `.swarms/.${reportFilename(run)}.tmp-${"c".repeat(32)}`;
  const file = path.join(root, relative);
  await fs.writeFile(file, "original incomplete HTML", { mode: 0o600 });
  const stat = await fs.stat(file);
  await record({ file: relative, kind: "temporary",
    identity: { dev: stat.dev, ino: stat.ino, birthtime: stat.birthtimeMs }, sha256: "unfinished" });
  await fs.chmod(file, 0o644);
  await recoverReportTemps(root, { artifacts, record, tracked: await trackedFiles(root) });
  assert.equal(await fs.readFile(file, "utf8"), "original incomplete HTML");
  const replacement = `${file}.replacement`;
  await fs.writeFile(replacement, "user replacement", { mode: 0o600 });
  await fs.rename(replacement, file);
  await recoverReportTemps(root, { artifacts, record, tracked: await trackedFiles(root) });
  assert.equal(await fs.readFile(file, "utf8"), "user replacement");
  await fs.rename(path.join(root, ".swarms"), path.join(root, "moved-reports"));
  await fs.symlink(path.join(root, "moved-reports"), path.join(root, ".swarms"));
  await recoverReportTemps(root, { artifacts, record, tracked: await trackedFiles(root) });
  assert.equal(await fs.readFile(file, "utf8"), "user replacement");
  assert.equal(artifacts.length, 1);
});

test("temporary recovery preserves a recorded original inode after it is added to Git", async t => {
  const { root, run, record, artifacts } = await fixture(t);
  const before = await snapshot(root);
  await fs.mkdir(path.join(root, ".swarms"));
  const relative = `.swarms/.${reportFilename(run)}.tmp-${"c".repeat(32)}`;
  const file = path.join(root, relative);
  await fs.writeFile(file, "staged temporary HTML", { mode: 0o600 });
  const stat = await fs.stat(file);
  await record({ file: relative, kind: "temporary",
    identity: { dev: stat.dev, ino: stat.ino, birthtime: stat.birthtimeMs }, sha256: "unfinished" });
  execFileSync("git", ["add", "--", relative], { cwd: root });
  await recoverReportTemps(root, { artifacts, record, tracked: await trackedFiles(root) });
  assert.equal(await fs.readFile(file, "utf8"), "staged temporary HTML");
  assert.equal(artifacts.length, 1);
  const current = await snapshot(root, artifacts);
  assert(current.files.includes(relative), "tracked temporary files must be reviewed");
  assert.notEqual(current.digest, before.digest);
});

test("browser launch plans pass a file URL as one argument without a shell", () => {
  const file = "/example/path with spaces/report;$(touch unexpected).html";
  const url = pathToFileURL(file).href;
  assert.deepEqual(browserCommand(file, "darwin"), ["/usr/bin/open", ["-b", "com.apple.Safari", url]]);
  assert.deepEqual(browserCommand(file, "linux"), ["xdg-open", [url]]);
  assert.deepEqual(browserCommand(file, "win32"), ["rundll32", ["url.dll,FileProtocolHandler", url]]);
  assert.throws(() => browserCommand(file, "unsupported"), /unsupported/);
});
