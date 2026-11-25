import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isTemporaryReportArtifact, reportFilename } from "./artifact-paths.js";
import { reviewers, requiredReviewers, requireThat, uiReviewer } from "./protocol.js";

const escape = value => String(value ?? "").replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);
const pre = value => `<pre>${escape(value)}</pre>`;
const section = (title, content) => `<section><h2>${escape(title)}</h2>${content}</section>`;
const fields = entries => `<dl>${entries.map(([label, value]) =>
  `<dt>${escape(label)}</dt><dd>${escape(value)}</dd>`).join("")}</dl>`;
const details = (title, content) => `<details><summary>${escape(title)}</summary>${content}</details>`;

export function renderReport(run, narrative) {
  const required = requiredReviewers(run);
  requireThat(run.candidate && required.every(role =>
    run.reports[role]?.verdict === "approve" && run.reports[role].candidate === run.candidate.id) &&
    !run.findings.some(finding => finding.status === "open"),
  "HTML completion reports require all required matching approvals and no open findings.");
  const triages = run.history.filter(entry => entry.phase === "TRIAGED");
  const cards = [
    ["Review rounds", run.round],
    ["Findings", run.findings.length],
    ["Resolved", run.findings.filter(finding => finding.status === "resolved").length],
    ["Dismissed", run.findings.filter(finding => finding.status === "dismissed").length],
  ].map(([label, value]) => `<div class="card"><strong>${escape(value)}</strong><span>${escape(label)}</span></div>`).join("");
  const verdicts = required.map(role => {
    const report = run.reports[role];
    return `<article><h3>${escape(role)} — ${escape(report.verdict)}</h3>
      ${pre(report.summary)}${details("Verification evidence", pre(report.evidence))}</article>`;
  }).join("");
  const findings = run.findings.map(finding => details(
    `${finding.severity} · ${finding.status} · ${finding.id}`,
    fields([
      ["Owner", finding.reviewer], ["Location", finding.location], ["Kind", finding.kind],
      ["Reported in round", finding.round],
    ]) +
    pre(finding.description) +
    details("Expected / actual / reproduction", fields([
      ["Expected", finding.expected], ["Actual", finding.actual],
    ]) + pre(finding.reproduction) + pre(finding.recommendation)) +
    (finding.decisions ?? []).map(decision => `<article><h4>Round ${escape(decision.round)} — ${escape(decision.outcome)}</h4>
      ${fields([
        ["Orchestrator action", decision.triage?.action ?? "Legacy record"],
        ["Orchestrator reason", decision.triage?.reason ?? "Not recorded"],
        ["Builder response", decision.proposal?.action],
      ])}${pre(decision.proposal?.reason)}${pre(decision.reason)}</article>`).join(""),
  )).join("") || "<p>No findings were reported.</p>";
  const triageHistory = triages.map(entry => `<article>
    <h3>${escape(entry.request)}</h3>${pre(entry.summary)}
    <ul>${entry.decisions.map(decision => `<li><strong>${escape(decision.action)}</strong> —
      ${escape(decision.findingID)}${pre(decision.reason)}</li>`).join("")}</ul>
    </article>`).join("") || "<p>No triage was needed.</p>";
  const rounds = run.history.filter(entry => entry.candidate && entry.reports &&
    typeof entry.candidate === "object" && Object.keys(entry.reports).length)
    .map(entry => details(entry.candidate.id,
      pre(entry.candidate.summary) + details("Builder evidence", pre(entry.candidate.evidence)) +
      [...reviewers, uiReviewer].filter(role => entry.reports[role]).map(role => `<h4>${escape(role)} —
        ${escape(entry.reports[role].verdict)}</h4>${pre(entry.reports[role].summary)}
        ${details("Review evidence", pre(entry.reports[role].evidence))}`).join(""),
    )).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${escape(narrative.title)}</title>
<style>
:root{color-scheme:light dark;font:16px/1.6 system-ui,sans-serif}
body{max-width:1100px;margin:0 auto;padding:2rem;background:#101723;color:#e8edf5}
h1,h2,h3{line-height:1.25}h1{font-size:2.2rem}h2{margin-top:0}
header,section{margin:0 0 1.5rem;padding:1.5rem;border:1px solid #344257;border-radius:.75rem}
.badge{display:inline-block;background:#174838;color:#adf4cb;padding:.3rem .7rem;border-radius:2rem}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:1rem;margin-top:1.5rem}
.card{background:#1b283b;padding:1rem;border-radius:.5rem}.card strong{display:block;font-size:1.8rem}
.card span{color:#b6c5da}dt{font-weight:650;color:#b6c5da}dd{margin:0 0 .65rem;overflow-wrap:anywhere}
pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;margin:.5rem 0 1rem}
article{padding:1rem 0;border-top:1px solid #344257}summary{cursor:pointer;font-weight:650;overflow-wrap:anywhere}
details{padding:.8rem;border:1px solid #344257;border-radius:.4rem;margin:.6rem 0}li{margin:.5rem 0}
@media print{body{background:white;color:black;padding:0}header,section,details{border-color:#999}dt,.card span{color:#333}.card{background:#eee}.badge{background:#eee;color:black}details{display:block}}
</style>
</head>
<body>
<header><p class="badge">All ${required.length} required reviewers approved this candidate</p>
<h1>${escape(narrative.title)}</h1>${pre(narrative.summary)}
<div class="cards">${cards}</div></header>
<main>
${section("Run and candidate", fields([
    ["Run", run.id], ["Repository", run.directory], ["Orchestrator", run.root],
    ["Candidate", run.candidate.id],
    ["UI changes", run.candidate.ui?.changes ?? "Not recorded (legacy run)"],
    ["Generated", new Date(run.reportRequest.created).toISOString()],
  ]))}
${section("Final review verdicts", verdicts)}
${section("Orchestrator triage", triageHistory)}
${section("Findings, fixes, and owner verification", findings)}
${section("Final implementation and test evidence", pre(run.candidate.summary) + pre(run.candidate.evidence) + pre(run.candidate.ui?.evidence))}
${section("Earlier review rounds", rounds || "<p>This candidate passed on its first review round.</p>")}
${section("Task and requirements", details("Original task", pre(run.requirements)))}
${section("Limitations", pre(narrative.limitations) + "<p>This is a point-in-time record for the candidate above, not a live approval indicator. Later code or requirement changes can invalidate workflow approval. Review and finite testing do not prove the absence of defects. Evidence is reported by the named agents, not independently certified by this renderer.</p>")}
</main>
</body>
</html>
`;
}

const identity = stat => ({ dev: stat.dev, ino: stat.ino, birthtime: stat.birthtimeMs });
const matchesIdentity = (recorded, stat) => recorded?.dev === stat.dev &&
  recorded?.ino === stat.ino && recorded?.birthtime === stat.birthtimeMs;

// Called only under the controller lock, with no report writer active.
// A crash can leave a recorded empty/partial file. Remove only the original
// private temporary inode, never a replacement or a published report.
export async function recoverReportTemps(directory, provenance) {
  const entries = provenance.artifacts.filter(entry =>
    entry.kind === "temporary" && isTemporaryReportArtifact(entry.file));
  if (!entries.length) return;
  requireThat(provenance.tracked instanceof Set,
    "Temporary recovery requires the current set of tracked files.");
  const root = await fs.realpath(directory);
  const output = await fs.lstat(path.join(root, ".swarms")).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (output && (!output.isDirectory() || output.isSymbolicLink())) return;
  for (const entry of entries) {
    if (provenance.tracked.has(entry.file)) continue;
    const file = path.join(root, entry.file);
    const stat = output && await fs.lstat(file).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (stat) {
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 ||
        !matchesIdentity(entry.identity, stat)) continue;
      await fs.unlink(file);
    }
    await provenance.record({ file: entry.file, remove: true });
  }
}

async function sameFile(file, content, recorded) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    requireThat(stat.isFile(), "Report destination is not a regular file.");
    requireThat((stat.mode & 0o777) === 0o600,
      "An existing report is not private (0600); refusing to accept it.");
    requireThat(matchesIdentity(recorded.identity, stat),
    "An existing report no longer matches its recorded identity.");
    requireThat(await handle.readFile("utf8") === content,
      "An existing report has different contents; refusing to overwrite it.");
  } finally {
    await handle.close();
  }
}

export async function writeReport(run, narrative, provenance) {
  requireThat(provenance && Array.isArray(provenance.artifacts) &&
    typeof provenance.record === "function", "Report publication requires controller provenance.");
  const filename = reportFilename(run);
  const content = renderReport(run, narrative);
  const root = await fs.realpath(run.directory);
  const directory = path.join(root, ".swarms");
  await fs.mkdir(directory, { mode: 0o700 }).catch(error => {
    if (error.code !== "EEXIST") throw error;
  });
  const stat = await fs.lstat(directory);
  requireThat(stat.isDirectory() && !stat.isSymbolicLink(),
    ".swarms must be a real directory, not a symlink.");
  const destination = path.join(directory, filename);
  const temporary = path.join(directory, `.${filename}.tmp-${randomUUID().replaceAll("-", "")}`);
  const handle = await fs.open(temporary, "wx", 0o600);
  const relative = file => path.relative(root, file).split(path.sep).join("/");
  const sha256 = createHash("sha256").update(content).digest("hex");
  const owned = provenance.artifacts.find(entry => entry.file === relative(destination) &&
    entry.kind === "report");
  const artifact = {
    file: relative(destination), kind: "report", identity: identity(await handle.stat()), sha256,
  };
  try {
    try {
      await provenance.record({
        ...artifact, file: relative(temporary), kind: "temporary",
      });
      await handle.writeFile(content);
    } finally {
      await handle.close();
    }
    // Persist ownership before publication so a crash after link() is retryable.
    // The inode and hash must match; this cannot hide a pre-existing user file.
    const existing = await fs.lstat(destination).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!existing) await provenance.record(artifact);
    try {
      // Atomic publication without replacing existing user files.
      await fs.link(temporary, destination);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      requireThat(owned, "An existing report is not a recorded swarm artifact.");
      await sameFile(destination, content, owned);
    }
  } finally {
    await fs.unlink(temporary).catch(error => {
      if (error.code !== "ENOENT") throw error;
    });
    await provenance.record({ file: relative(temporary), remove: true });
  }
  return {
    path: destination, candidate: run.candidate.id,
    sha256,
    bytes: Buffer.byteLength(content), created: run.reportRequest.created,
  };
}
