# Swarm

A local OpenCode V2 server plugin (`opencode-swarm`, plugin ID `swarm`).
An `orchestrator` agent coordinates a
`builder` child and three independent reviewers:

- `adversarial-reviewer`: defects, regressions, security, and unnecessary complexity.
- `test-engineer`: test quality, useful additions/edits/deletions, and independent
  exploratory testing with reproducible evidence.
- `specification-reviewer`: requirement-to-implementation-and-test traceability.

The orchestrator owns finding triage: fix or propose dismissal, with reasons.
The builder is the only permanent source/test writer and must follow that
triage. Reviewers own findings, fix verification, and final dismissal decisions.
Plugin code owns dispatch and state.
After reviews pass, the orchestrator produces an HTML summary through the
plugin. The file is saved in `<repository-root>/.swarms/` and automatically
opened in the web browser.

## Use

Requires OpenCode V2's current server plugin API (`Plugin.define`, transforms,
hooks, storage, and idempotent session creation/prompt admission).
Developed against the V2 documentation with OpenCode 2.4.1 installed. Automated
integration tests use a scripted API double; a live provider-backed run is a
separate validation step.

From this repository, apply the normal links and regenerate your saved profile
if necessary. No new packages are required:

```sh
./scripts/link-home.sh
oc2 --setup work
# Or: oc2 --setup personal
```

Shared agent/plugin directories are already in `scripts/links.txt`. Do not add
generated config files. OpenCode reloads definitions after changes; `/reload`
forces a full reload without a service restart.

The former plugin ID was `review-gate`. The new `swarm` ID has a separate
plugin-storage namespace; old run records are not automatically migrated.
Cancel active runs before upgrading, and explicitly start new runs afterward.
Do not treat an old run as resumed or approved by the renamed plugin.

Start OpenCode at the **canonical root of the Git checkout** to avoid competing
location-scoped controllers:

```text
/swarm Implement <task>. Acceptance criteria: <criteria>.
```

The command selects `orchestrator` for that session, captures the original user
conversation and command attachments, persists the task, and starts the builder.
Alternatively, select or launch `orchestrator` as a subagent and give it a task; its `swarm_start` tool
enrolls the task. Move a delegated orchestrator to its target Git checkout before
enrollment; its builder and reviewers inherit that location. The outer parent
does not gain permission to submit its candidates or approvals.
Enforcement begins at enrollment, not agent selection alone.

```text
/swarm-status
/swarm-resume
/swarm-cancel
```

- Status rechecks the candidate and prints authoritative state.
- Resume preserves requirements, findings, and history. Open findings or
  changes-requested feedback return to orchestrator triage before the builder
  restarts. It does not bypass triage or the round limit.
- Cancel stops participants and leaves the task incomplete.
- New user prompts during a run become clarifications and block the run,
  invalidating approvals. After clarifying requirements, use `/swarm-resume`.
  Even a conversational status question conservatively counts as new input;
  use `/swarm-status` instead.
- Start a new `/swarm` explicitly after cancellation, approval, or a blocker if
  a new run/budget is needed. The old run is archived in plugin storage.

Models remain in machine profiles. The builder's base system prompt,
instructions, and permissions derive from the resolved `build` agent.
Orchestrator and reviewer prompts remain model-neutral. The default primary
agent remains `plan`; ordinary Build sessions retain optional review behavior.

## Protocol

```text
BUILDING → HANDOFF → REVIEWING → REVIEW_HANDOFF → REPORTING → APPROVED
    ↑                                    │
    └──────────── TRIAGING ←──────────────┘
              failures → BLOCKED
          cancellation → CANCELLED
```

1. Builder calls `swarm_candidate` with summary, test evidence, and one response
   per open finding, then stops.
2. After the builder finishes successfully, the plugin dispatches all three
   reviewers concurrently, with the original task and a shared candidate ID.
3. Each reviewer calls `swarm_report`. A prose reply is not a report.
4. After all reports arrive and all three reviewer turns finish, requested
   changes enter `TRIAGING`. The plugin supplies the full reports/findings to
   the orchestrator and pauses builder edits. Completion is correlated through
   a saved pre-dispatch idle-marker ID and a new durable idle marker, not
   timestamps alone. This survives compaction of the original prompt.
   A blocked reviewer blocks the entire run.
5. The orchestrator calls `swarm_triage` with the current request ID, candidate
   ID, summary, and exactly one `fix` or `dismiss` decision with a reason for
   every open finding. General feedback must be addressed in summary even when
   the decision list is empty. Triage is not approval and closes no findings.
6. The same builder session receives those decisions. Its candidate responses
   must match: `fixed` for `fix`, or `dismiss` for a proposed dismissal, with
   supporting implementation/verification evidence. The builder cannot switch
   actions. If an instruction cannot be followed safely, report a blocker.
7. Its owning reviewer independently records `resolved`, `dismissed`, or
   `rejected`. A rejected proposal returns to the orchestrator for fresh triage.
   Neither orchestrator nor builder can close findings or override that reviewer.
8. Only three explicit `approve` verdicts for the current candidate, with no
   open findings, transition to `REPORTING`.
9. The orchestrator reads the final ledger and calls `swarm_report_html` with
   `request` (`reportRequest.id`), `candidate` (`candidate.id`), `title`,
   `summary`, and `limitations`. The plugin adds authoritative evidence and
   writes the HTML file. Only successful publication transitions to `APPROVED`.
   It then automatically attempts to open the file in the browser.

Every candidate creates a new round and clears prior approvals, even when the
orchestrator only proposes dismissals. Review sessions are reused. All three must
approve again after any permanent test or implementation change.

`swarm_report` includes:

- Candidate ID; verdict (`approve`, `changes_requested`, or `blocked`).
- Summary and evidence, including test commands/results and limitations.
- New findings with unique kebab-case IDs, severity, kind, location, description,
  expected/actual behavior, reproduction, and recommendation.
- Decisions on prior findings, with their full `reviewer:local-id` and rationale.

The tool input schema gives the exact fields. Reporter identity is taken from
the registered session ID and current agent, never from model-supplied identity.
Invalid submissions do not partially mutate the ledger.

`swarm_triage` is restricted to the registered orchestrator session:

```json
{
  "request": "<triageRequest.id from swarm_status>",
  "candidate": "<candidate.id from swarm_status>",
  "summary": "Assess the reports and explain the next actions",
  "decisions": [
    {
      "findingID": "test-engineer:example-finding",
      "action": "fix",
      "reason": "The reproduction contradicts the stated requirement"
    }
  ]
}
```

Missing, duplicate, unknown, closed, or stale finding/request IDs are rejected.
Every triage request has a fresh ID and content fingerprint, including after
resume, so an earlier decision cannot be replayed after changed requirements.
Triage history preserves the orchestrator's rationale separately from builder
evidence and reviewer acceptance/rejection. Rejected dismissals can be changed
to fixes at the next triage; they cannot be marked dismissed by the orchestrator.

## Automatic HTML display

This is part of normal future swarm completion, not a separate evaluation report.
The orchestrator supplies the narrative; the plugin renders the stored ledger
as a self-contained HTML document with:

- Run/candidate identity, summary, round counts, and final reviewer verdicts.
- All findings, severities, owners, triage rationale, builder responses, rejected
  repairs/dismissals, and final owner verification.
- Final and earlier-round test/review evidence, original task, and limitations.

Reports use `.swarms/<run-id>-<report-request-id>.html` at the canonical Git root.
Existing user files are not overwritten. Publication is atomic, files are
private (`0600`), and `.swarms` symlinks are rejected. Text is HTML-escaped;
there are no scripts, remote assets, or external dependencies. Reports can
contain task/code details: inspect them before sharing.

Only **untracked** reports and temporary files with durable controller provenance,
matching filesystem identity, private permissions, and matching content hashes
are excluded from candidate fingerprints. A generated-looking filename alone
does not establish ownership. Tracked files, changed/replaced artifacts, and
other `.swarms` contents remain reviewed. Provenance persists across runs and
plugin restarts, preventing reporting from invalidating its own candidate.
Before checking a candidate, recovery removes recorded temporary files whose
original filesystem identity and private permissions still match, including
empty/partial files left by an interrupted write. Tracked files, replaced files,
and symlinks are preserved and remain subject to fingerprint checks.
The plugin does not edit `.gitignore`. Reports are historical snapshots, not
live approval indicators; later code/requirement changes can revoke approval.

On macOS, reports open in Safari so an HTML editor association cannot intercept
them. Linux uses `xdg-open`; Windows uses its file-URL handler. Browser launching
is attempted once per published report. If unavailable, it does not discard the
report or code approvals: `htmlReport.browser` contains the failure and the
orchestrator provides a manual-open path. A crash during launching is recorded
as `unknown` on recovery rather than opening duplicate tabs.

Write failures remain in `REPORTING` with `reportError`; retry the same frozen
narrative after fixing the error. After a reporting timeout, `/swarm-resume`
can retry reporting without another code-review round only if approvals,
candidate contents, and requirements are unchanged. New requirements or changed
code require fresh reviews. New runs require the HTML stage; previously
completed runs are not retroactively given reports.
Generation that finishes after its reporting deadline cannot approve the run
or open the browser. Retries refuse existing reports with permissions other
than `0600`, even when their contents match.

## Recovery and limits

Durable plugin storage contains the active run, requirements, findings,
decisions, review reports, history, and dispatch outbox. Session and prompt IDs
are saved before dispatch and reused on retries. Startup recovery reconciles
saved session outcomes; live events are an optimization, not the only record.
A 30-second recovery sweep checks deadlines and catches missed events.
Pending triage and HTML reporting use the durable outbox and per-turn deadline;
missing or late submissions block the run. An idle orchestrator turn is merely
waiting, not workflow completion. An all-approved clean review needs no triage
but still requires the orchestrator's HTML summary.
Failed participant interruptions are retained as `stopFailures`. Resume retries
stopping prior child turns and stays blocked until their stopped state is
confirmed. Candidate/report calls are bound to their dispatch when invoked, so
an old call queued behind resume cannot submit into the next builder turn.

Defaults are **five candidate rounds** and **30 minutes per dispatched turn**.
Plugin options `maxRounds` (positive integer) and `timeoutMinutes` (positive
number) override these limits for new runs/dispatches. A limit, unavailable
agent, provider/permission failure, malformed or absent report, interruption,
or unverifiable candidate never counts as approval. Provider spend is not
metered by this plugin; the round/deadline limits bound workflow turns, not cost.

## Boundaries

- `APPROVED` is a **plugin-owned workflow outcome**, not OpenCode's session
  `succeeded` outcome. V2 does not document a final-reply veto hook. A model may
  still write premature completion text; it cannot turn that text into approval.
  There is no CI, commit, merge, or deployment gate in this first version.
- Candidate identity hashes HEAD, index entries, and the contents/modes of
  tracked and non-ignored untracked files throughout the checkout. Staged and
  unstaged changes are included. Submodules and special files fail closed.
  Symlinks are hashed as links, not as external target contents.
  Generated untracked HTML artifacts are the narrow exception described above.
- Ignored files, external dependencies, tools, environment variables, services,
  and external symlink targets are **outside** candidate identity. Make required
  specifications/tests tracked or non-ignored. This is not a reproducible build
  or a defense against a hostile process changing files between checks.
- Fingerprints are rechecked on submissions, status, relevant filesystem/session
  events, and recovery sweeps. An external change revokes approval when detected.
- Run one controller per canonical checkout on one OpenCode service. This is
  not a distributed lock across independent servers. Other applications or
  ordinary Build sessions are not prevented from changing that checkout;
  detected changes block the managed run.
- Test-engineer shell checks require approval and must use temporary directories
  for exploratory files. Edit tools are denied. Shell permissions are not an OS
  sandbox: an approved test command can have side effects, access credentials,
  or write files. Review commands before granting access. Candidate changes
  caused by tests also invalidate the review.
- The plugin preserves user session permission rules for children. It separately
  enforces the adversarial/specification reviewers' read-only Git shell allowlist,
  even if a parent session allowed arbitrary shell commands. Managed diffs must
  use `git diff --no-ext-diff --no-textconv`; output redirection, write flags,
  and other commands are denied. Agent/global policies still apply.
  Plugin registrations and ordinary shell access are not a security boundary
  against malicious users or plugins.
- Switching the primary session back to Build releases workflow-only tool
  restrictions. Historical status remains readable, and the saved candidate can
  still be invalidated by later changes.
- Original user context and attachments go to all participants using their
  configured providers. Existing profile provider allowlists are unchanged.
  Requirements and review evidence persist in OpenCode's local plugin storage.
- The plugin SDK exposes `session.context`, not the HTTP client's
  `session.message.list`. Enrollment captures available user context; if an
  earlier compaction removed important requirements, supply them explicitly in
  the new task before starting. Dispatched requirements then persist in storage.
- Prompt admission hooks may run more than once or precede failed admission.
  Clarifications are deduplicated by message ID; failed admission can
  conservatively leave the run blocked. No review is silently skipped.
- Reviewer judgment remains probabilistic. Determinism applies to required
  participants, legal state transitions, and approval bookkeeping.

## Validate

No downloads or provider requests:

```sh
node --test home/.config/opencode/plugins/swarm/test/*.test.js
node --test scripts/opencode-profile.test.mjs
```

Tests cover dispatch ordering, three-reviewer approval, ownership and dismissal
negotiation, stale/forged/malformed reports, candidate changes, restart recovery,
retry-safe outbox delivery, blocked/missing reports, deadlines, cancellation,
permission failures, API registration, and real Git fingerprints.
HTML tests cover escaped content, private/atomic publication, output ownership,
fingerprint preservation, approval/role guards, retries, failures, and mocked
browser launches. Tests do not open browsers or create reports for users.

For a live smoke test, use a disposable Git checkout and a tiny task. Confirm
that three reviewer children appear only after builder handoff, an exploratory
test requires approval, and all three approvals lead to `REPORTING`. Confirm
the orchestrator generates the HTML in `.swarms`, the browser opens, and status
then becomes `APPROVED` with `htmlReport.path`. Add a non-ignored source file and
confirm status becomes `BLOCKED`. Do not use
production data or a valuable dirty checkout for the first live run.
