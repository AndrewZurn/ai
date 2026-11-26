# Swarm

A local OpenCode V2 server plugin (`opencode-swarm`, plugin ID `swarm`).
An `orchestrator` agent coordinates a
`builder` child and three baseline independent reviewers:

- `adversarial-reviewer`: defects, regressions, security, and unnecessary complexity.
- `test-engineer`: test quality, useful additions/edits/deletions, and independent
  exploratory testing with reproducible evidence, including Playwright MCP for
  web UI changes.
- `specification-reviewer`: requirement-to-implementation-and-test traceability.

The orchestrator reads specialist descriptions to decide which expertise the
task and actual changes need. The default specialist, `ui-design-reviewer`,
reviews rendered design, usability, accessibility, and responsive layouts.
All mandatory and selected specialist reviewers run in parallel.
Browser reviewers use separate Playwright MCP servers to avoid shared state.

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
/swarm --plan docs/plan.md Implement <task>. Acceptance criteria: <criteria>.
```

The command selects `orchestrator` for that session, captures the original user
conversation and command attachments, persists the task and complete plan text,
and dispatches the orchestrator for plan review. The plan path is required,
relative to the repository root or absolute; quote paths containing spaces.
The plan must be a readable nonempty UTF-8 text file no larger than 1 MiB.
Plan identity hashes the original bytes, not normalized text. Plan reads
respect the orchestrator's read permissions. Optional task details default to
"Implement the referenced plan."
Enrollment failures before a new run is created restore the session's previous
agent; failures after durable enrollment keep the orchestrator for recovery.
It also supplies standard orchestrator system instructions: plugin-owned
dispatch, mandatory approvals and owner-verified triage, HTML/browser completion,
final evidence, and safe status/resume controls. They are injected on every
orchestrator model turn, including after plugin reloads, not stored as permanent
chat instructions that could affect a later Build turn. The command adds only
a short run-specific startup notice and status/resume/cancel help to chat.
Supply the plan path, task, acceptance criteria, and task-specific constraints; there
is no need to repeat these workflow rules. They are not appended to the stored
task requirements. A clean first review may pass; a mandatory repair cycle or
unchanged-seed failure rule belongs only to an explicitly requested evaluation.
Alternatively, select or launch `orchestrator` as a subagent and give it a task; its `swarm_start` tool
requires both `task` and `plan` and enrolls it for plan review. Move a delegated orchestrator to its target Git checkout before
enrollment; its builder and reviewers inherit that location. The outer parent
does not gain permission to submit its candidates or approvals.
Enforcement begins at enrollment, not agent selection alone.

### Plan review before implementation

New runs start in `PLAN_REVIEW`. No builder or reviewer is dispatched until the
orchestrator reads the complete plan and calls `swarm_plan` with `decision: ready`.
It reviews scope, acceptance criteria, dependencies, constraints, risks and tests.
For ambiguity, it first records `decision: clarify` and targeted `questions`,
then uses the question tool to ask the user. `CLARIFYING` waits without a builder
or a human-answer deadline. `answers` records each pending question and its real
answer; incomplete, duplicate, stale or unauthorized submissions cannot start
work. Further clarification rounds are allowed.

Once clear, the orchestrator records its review summary and answers and the
plugin automatically releases the builder. The plan is not edited. Its pinned
path/content/hash and clarification history go to participants and the HTML
report. New preflight input or changed plan content invalidates the review
request. Changed/unreadable plans after implementation block the run; resume
requires renewed plan review when requirements changed. Preflight consumes no
candidate rounds. Legacy runs without a plan must be restarted with `--plan`.

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
- In `PLAN_REVIEW`/`CLARIFYING`, ordinary answers are recorded for the orchestrator
  and do not require resume. After implementation starts, new user prompts
  become clarifications and block the run,
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

### Configure reviewers

Edit `workflow.json` next to this README. The plugin directory is already linked
into `~/.config/opencode/plugins/swarm/`; no additional home symlink is needed.

```json
{
  "version": 1,
  "reviewers": {
    "adversarial-reviewer": {
      "required": true,
      "description": "Find defects, regressions, security risks, and unnecessary complexity."
    },
    "test-engineer": {
      "required": true,
      "description": "Check test coverage and independently verify behavior."
    },
    "specification-reviewer": {
      "required": true,
      "description": "Verify that the implementation and its evidence satisfy every task requirement."
    },
    "ui-design-reviewer": {
      "required": false,
      "description": "Review web interface usability, visual design, and interaction quality."
    }
  }
}
```

- `required: true` always participates and cannot be skipped by the orchestrator.
- `required: false` is a specialist: the orchestrator reads its workflow
  `description` and records `invoke` or `skip`, with a task-specific reason.
  There are no path/keyword conditions or ordering dependencies in configuration.
- All configured agents must exist and have a nonempty workflow `description`.
  These descriptions are stored with the configuration in the run. They provide scope
  and invocation criteria, not permission to override workflow policy.
- A selected specialist's approval becomes mandatory for every subsequent
  candidate, even after its findings close. Reassessment can add, not remove,
  specialists. Selection is model judgment; the controller validates the complete
  decision set, identity, and approval bookkeeping, not semantic relevance.
- Each candidate's reviewer list and selection reasons persist in status and HTML.
  New runs use configuration loaded by the plugin; `/reload` explicitly reloads
  external workflow edits. Active/resumed runs keep their enrolled configuration
  and descriptions, even if new workflow edits are invalid. Invalid edits reject
  new enrollment without disabling status, recovery, or completion of saved runs.
  Older runs without this configuration retain legacy membership.
- Strict JSON is required. Unknown fields, reserved/invalid agent IDs, and
  configurations without at least one mandatory reviewer are rejected.

To add a reviewer, create its shared agent definition, add a `reviewers` entry
with a clear `description` here, and assign its model in each machine profile.
Profile validation discovers configured reviewers; no code or explicit
orchestrator allowlist edit is needed. Run `oc2 --setup <profile>` after profile
edits. A deny-only hook restricts orchestrator dispatch to configured/enrolled
IDs; the plugin never adds dispatch grants or overrides deny/ask rules, including
blanket denials. Dispatch still requires user/session permission and allowed providers.
The manual-subagent guard also runs outside Git repositories, where the plugin
does not install controller tools; the global orchestrator cannot bypass it there.
Reviewers cannot edit; new reviewers receive the read-only Git shell guard.
The test engineer alone keeps its existing user-approved exploratory shell checks.

```text
PLAN_REVIEW ↔ CLARIFYING
    ↓ ready
BUILDING → HANDOFF → SELECTING → REVIEWING → REVIEW_HANDOFF → REPORTING → APPROVED
    ↑                                    │
    └──────────── TRIAGING ←──────────────┘
              failures → BLOCKED
          cancellation → CANCELLED
```

1. Builder calls `swarm_candidate` with summary, test evidence, `ui` classification
   and evidence (below), and one response per open finding, then stops.
2. After the builder finishes successfully, `SELECTING` asks the orchestrator to
   read every specialist description and assess the full plan, requirements, and
   actual changes. `swarm_select` takes `selectionRequest.id` as `request`,
   `candidate.id`, and `decisions`: exactly one `{ reviewer, action, reason }`
   per specialist. `action` is `invoke` or `skip`; mandatory reviewers must not
   appear. Missing, duplicate, stale, unauthorized or invalid decisions cannot
   release reviews. If there are no specialists, selection is unnecessary.
3. The plugin dispatches all mandatory and selected reviewers concurrently.
   Each reviewer calls `swarm_report`. A prose reply is not
   a report. Status exposes the complete `requiredReviewers` list.
4. After all required reports arrive and their reviewer turns finish, requested
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
8. Only explicit `approve` verdicts from every required reviewer for the current
   candidate, with no open findings, transition to `REPORTING`.
9. The orchestrator reads the final ledger and calls `swarm_report_html` with
   `request` (`reportRequest.id`), `candidate` (`candidate.id`), `title`,
   `summary`, `executiveSummary`, and `limitations`. The plugin adds authoritative evidence and
   writes the HTML file. Only successful publication transitions to `APPROVED`.
   It then automatically attempts to open the file in the browser.

Every candidate creates a new round and clears prior approvals, even when the
orchestrator only proposes dismissals. Review sessions are reused. All required
reviewers must approve again after any permanent test or implementation change.
Once a specialist is selected, it remains required for subsequent repair
rounds. UI scope downgrades are rejected: `web` must remain `web`, and `non-web`
cannot become `none` (but can upgrade to `web`). This keeps the test engineer's
applicable UI checks required against each candidate, not just the design
reviewer's approval. Scope covers the full task, even for a non-UI repair.

### UI scope and browser evidence

Every `swarm_candidate` includes:

```json
{
  "ui": {
    "changes": "web",
    "evidence": "Changed /settings form states. Local URL: http://localhost:3000/settings. Startup: use the existing dev script with approval. Use synthetic settings data; no sign-in required."
  }
}
```

`changes` is `none`, `web`, or `non-web`. Evidence is required even for `none`.
Classify actual UI work across the task, including interaction, style, layout,
and user-visible state changes, not file extensions. For web work include a test
URL, startup instructions, and safe test data/access requirements. The test
engineer and specification reviewer independently check the classification.
This is an evidence-based declaration, not automatic source-code UI detection;
an incorrect classification must be reported and corrected through review.
Every configured specialist's availability and description are checked at
enrollment. Dispatch permission is checked only if selected.

For web UI, both browser reviewers must use Playwright MCP themselves against
the running test application. The test engineer checks behavior and failure
paths; the UI design reviewer checks rendered design and usability. Evidence
identifies URLs, viewports, states, interactions, expected/actual results,
screenshots or page snapshots, and limitations. Test engineers also inspect
console/network failures. Source checks and builder screenshots do not replace
independent browser checks. Required unavailable tools/app/access mean blocked,
not approval. Non-web UI uses platform-appropriate evidence and states why
Playwright does not apply.

The test engineer uses `playwright`; UI design uses `ui-browser`, a separate
server running `@playwright/mcp@latest --isolated`. Browser state is not shared,
and cross-server use is denied for these roles. The original `playwright`
persistent profile is unchanged. Regenerate the saved machine profile for the
additional server. Setup does not run `npx`, install packages, or start browsers;
OpenCode can start configured MCP servers afterward, which may download packages.
Additional browser specialists need their own independent browser server before
parallel browser work; a separate tab on an existing server is not isolation.

Use local or explicitly authorized test environments and synthetic data. Keep
screenshots/outputs in approved temporary directories outside the candidate.
Browser/dependency installation, service startup, credentials, and destructive
actions still need required permission. The plugin does not auto-install tools,
start an app, or certify that prose evidence proves browser execution. Existing
Playwright MCP configuration and user restrictions remain unchanged.

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
- A visible executive summary, written by the orchestrator from the full ledger,
  with a short story for every review round and a summary and finding bullets
  for each reviewer, including the final round.
- All findings, severities, owners, triage rationale, builder responses, rejected
  repairs/dismissals, and final owner verification.
- Final and earlier-round test/review evidence, original task, and limitations.

### Executive summary contract

The executive summary is a 2–3 minute decision brief, not a copy of the review
transcripts. Aim for 400–550 words; simpler tasks can be shorter. The plugin
enforces a maximum of 600 prose words across these required tool fields:

- `summary`: 2–3 sentences on the requested outcome, what changed, and approval scope.
- `executiveSummary.rounds`: one entry per unique candidate, in chronological order,
  with `candidate` (exact ID), `summary` (two short storytelling sentences), and
  `reviewers`. Explain what happened and why it needed another round or passed.
- Each round's `reviewers`: one entry per reviewer in that candidate's saved
  `reviewers` list, in its recorded configuration order. Each entry has
  `reviewer` (exact role), `summary` (one concise line), and `findings` (a nonempty
  bullet array). Prefer 2–3 short bullets on that reviewer's findings, resolutions,
  dismissals, and verification; one explicit no-new-findings bullet can suffice.
  Missing reports are labeled separately from no new findings. Verdict labels
  come from the recorded ledger, not the authored narrative.
- `executiveSummary.findings`: grouped themes, resolved/dismissed totals, and
  consequential dismissal reasons. Overlapping reviewer findings are not necessarily
  separate implementation defects.
- `executiveSummary.verification`: strongest actual checks and results, with
  builder-reported evidence distinguished from independent reviewer execution.
- `limitations`: residual risks, untested areas, and scope exclusions.
- `executiveSummary.actions`: the user's next action/decision, or explicitly none
  within scope. Workflow approval does not establish deployment readiness.

Candidate IDs and reviewer role labels do not count toward the prose budget.
Raw commands, file paths, and exhaustive evidence belong in the detailed ledger below. Timings/costs are
included only when recorded. The renderer checks structure, round coverage,
order, per-round reviewer coverage, and length; it cannot certify the truth or
quality of agent-written prose.
Invalid summaries are rejected before freezing a draft, so the orchestrator can
correct them without another code-review round. The reporting tool now requires
`executiveSummary`; existing completed HTML files are not rewritten.

### Publication and recovery

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
Recovery starts **after plugin setup returns**; it cannot hold agent/plugin
activation while waiting for session admission. Events and timer ticks coalesce
into one active sweep plus at most one pending sweep. A failed event subscription
is retried on the next sweep.
Pending triage and HTML reporting use the durable outbox and per-turn deadline;
missing or late submissions block the run. An idle orchestrator turn is merely
waiting, not workflow completion. An all-approved clean review needs no triage
but still requires the orchestrator's HTML summary.
Failed participant interruptions are retained as `stopFailures`. Resume retries
stopping prior child turns and stays blocked until their stopped state is
confirmed. Candidate/report calls are bound to their dispatch when invoked, so
an old call queued behind resume cannot submit into the next builder turn.

Session/agent/permission requests, storage reads, and candidate fingerprints have
a **60-second operation deadline**, separate from the participant's turn deadline.
`operationTimeoutSeconds` (positive number) overrides it. This includes permission
approval waits: after a timeout, retry the operation and approve the new request.
SDK requests receive cancellation signals. Tool cancellation and plugin unload
abort those waits, and cancelled callbacks cannot write new controller state.
Authorized `/swarm-cancel` preempts an in-flight controller operation before
waiting for the queue; failed child stops remain visible in `stopFailures`.
Cancellation does not queue another orchestrator notification.

A timed-out prompt/create request that ignores cancellation remains tracked
across in-process reloads. A participant cannot be reused until that admission
settles and a new stop check succeeds. An uncertain root additionally requires
`oc2-swarms interrupt/cancel` to verify and acknowledge an empty native inbox;
idle execution alone cannot clear that fence through ordinary resume.
Recovery of an interrupted, idle
orchestrator blocks the run without waking it again; use `/swarm-resume`
explicitly. Resume acknowledges that interruption and retains the same review
and deadline safeguards. A normal successful orchestrator turn can still wait
for its builder/reviewers.

Cleanup does not wait for broken event sources or outstanding recovery requests.
Writes already in progress are awaited to prevent late storage commits from
overwriting newer state. This is not a watchdog for a blocked JavaScript event
loop, stalled storage write, or uninterruptible filesystem/report I/O. The
OpenCode service may still need an explicit restart for those failures; never
delete its database or session history to recover a run.

### Operator recovery without an agent

`oc2-swarms` is a terminal utility, linked by the normal home-link setup.
Before linking, use `node scripts/opencode-swarms.mjs --help` from this checkout.
It uses OpenCode's CLI discovery/authentication, not direct database access.

```sh
oc2-swarms list                         # Active and blocked runs
oc2-swarms list --all --json             # Include approved/cancelled records
oc2-swarms inspect <run-or-session-id>
oc2-swarms interrupt <run-or-session-id>  # Pause and stop execution
oc2-swarms resume <run-or-session-id>     # Explicitly continue a blocked run
oc2-swarms cancel <run-or-session-id>     # End the run; preserve history/code
oc2-swarms help interrupt                # Detailed, offline subcommand help
```

`start` is an alias for resume, not plan enrollment; `kill` is an alias for
cancel, not session deletion or process termination. New work still requires
`/swarm --plan <path>`. No bulk mutation is supported. Inspection is read-only
and does not acquire the workflow queue or add synthetic messages/model turns.
It shows run state, stop errors, participants and outstanding admissions, not
task prompts, requirements or source contents.
`--help`, `help <command>` and `<command> --help` work without a running service
and include examples, options, safety details and exit codes.

Interrupt/cancel first persist a run-ID-bound operator fence. The CLI then
cancels queued inputs and interrupts the root plus its descendant sessions
through native session APIs. Confirmation clears the fence only after stop
checks pass. The CLI must also explicitly acknowledge its successful native
root-inbox inspection; ordinary workflow recovery cannot make that assertion.
The Promise plugin API does not expose inbox inspection, so this is an
authenticated operator acknowledgement, not proof against a hostile client.
An inbox-endpoint error never counts as proof that a session is absent.
Starting/resuming a run is blocked while confirmation is pending,
so a new run cannot reuse those sessions halfway through an operator stop.
A CLI crash, timeout, unsettled admission or partial failure keeps that fence:
inspect the errors, then explicitly retry interrupt/cancel. This includes
undelivered user input, not only plugin messages; history and code are not deleted.

The plugin registers authenticated `swarm-operator` RPC methods (`inspect`,
`control`, `confirm`) during setup without storage reads. Operator controls do not
depend on an agent turn. Cancel/interrupt preemption is bound to the exact saved
run ID; a stale caller cannot abort another run's enrollment. Inspection remains
available while the workflow queue is busy, unless the service or storage itself
is unavailable. Access follows the service's authentication boundary; it is an
operator surface, not an additional sandbox against other authenticated clients.

If the plugin is unavailable, `oc2-swarms interrupt <root-session-id>` has a
native-only fallback. It still stops the selected tree and cancels queued input,
but reports the ledger as unconfirmed. Cancel/resume do not silently fall back.
Discovery covers loaded canonical Git checkouts and active swarm sessions in
the current service, not unloaded history or independently hosted services.
Use `--directory <checkout>` with an exact target when discovery is unavailable.
`--timeout-seconds` defaults to 15 per API call; calls are bounded and independent
locations/participants are checked with at most four concurrent requests.
Exit codes are 0 (confirmed), 1 (failed/invalid), and 2 (incomplete/unavailable).
Resume returns 2 if dispatch returns the run to `BLOCKED`, even when participant
stop checks succeeded. Descendant pagination retains and checks each parent
filter; unrelated records abort the stop before native mutations.
No service restart, dependency installation, database edits, or session deletion
is performed. `OPENCODE_SWARMS_BIN` overrides the default `opencode2` executable.

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
  enforces the adversarial/specification/UI-design reviewers' read-only Git shell allowlist,
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
node --test scripts/opencode-swarms.test.mjs
```

Tests cover workflow validation, complete description-based specialist selection,
mandatory enforcement, parallel dispatch, custom reviewers, saved descriptions,
three/four-reviewer approval, UI-scope validation, independent browser routing,
UI finding ownership across
repair rounds, missing/denied UI reviewers, blocked UI checks, ownership and dismissal
negotiation, stale/forged/malformed reports, candidate changes, restart recovery,
retry-safe outbox delivery, blocked/missing reports, deadlines, cancellation,
permission failures, API registration, and real Git fingerprints.
Failure-injection tests also cover startup ordering, coalesced event storms,
event reconnection, hung SDK requests/interrupts, cancellation preemption,
unload with uncooperative work, shared reload queues, late admissions, stale
writes, and interrupted-orchestrator recovery.
HTML tests cover escaped content, private/atomic publication, output ownership,
fingerprint preservation, approval/role guards, retries, failures, and mocked
browser launches. Tests do not open browsers or create reports for users.

For a live smoke test, use a disposable Git checkout and a tiny no-UI task. Confirm
that the orchestrator records a specialist skip reason during SELECTING and three
reviewer children appear together afterward, no UI reviewer appears, an
exploratory test requires approval, and three approvals lead to
`REPORTING`. Repeat with web UI work in a disposable running test application:
confirm a specialist invoke reason and parallel independent Playwright checks by
the test engineer (`playwright`) and UI design (`ui-browser`), and that all four
approvals are required. Confirm
the orchestrator generates the HTML in `.swarms`, the browser opens, and status
then becomes `APPROVED` with `htmlReport.path`. Add a non-ignored source file and
confirm status becomes `BLOCKED`. Do not use
production data or a valuable dirty checkout for the first live run.
