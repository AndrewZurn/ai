---
name: figma-make-poc
description: Plan a new POC from a Figma Make export, or compare a new Make iteration with a saved baseline and plan changes to an existing POC. Preserve a compact context guide so later work can inspect relevant files selectively. Use for Make-to-POC planning and rebaselining, not Git rebasing.
---

# Figma Make POC

Turn a Make prototype into a concrete implementation plan and reusable project context. Default to planning: do not implement application changes unless the user requests implementation. Creating the requested planning documents is part of this workflow; respect repository instructions and execution permissions.

## Select the workflow

- **Initial plan:** no established Make baseline or POC guide exists. Assess the export and plan a runnable skeleton plus one representative end-to-end flow.
- **Iteration plan / rebaseline:** a POC or prior guide exists and the user supplies a new Make iteration. Compare design intent and map the differences onto the actual POC.
- Interpret rebaseline as updating the recorded design reference, never as permission to run Git rebase or replace application files.

Use supplied paths and project conventions. Ask only for missing information that changes the plan: target repo/platform, source export, the journey the POC must prove, or real versus mocked integrations. Keep useful independent inspection moving while answers are pending. Do not assume the export's web stack is appropriate for a native target.

## Inspect economically

1. Read applicable repo instructions and the existing POC guide first. Locate the source export, previous snapshot if any, visual references, and working app.
2. Inventory filenames, package/run configuration, routes, entry points, styles, assets, and shared components. Exclude dependencies, build output, and large generated artifacts from broad reads.
3. Inspect the components and state transitions for the requested flow, following imports as needed. Do not ingest every file or paste full source into the guide.
4. When permitted and practical, run the prototype and inspect key screens and interactions. Use supplied screenshots or a walkthrough if execution is unavailable. Record what was actually observed versus inferred from code; never claim visual verification from source inspection alone.
5. Use Figma tools only when available and useful for a specific unresolved detail. A local code export is sufficient to begin; do not require an MCP connection. Respect existing restrictions on dependency installation and command execution.

The Make source and visual references express design intent. The target repo owns implementation choices, working integrations, and established components. Surface disagreements rather than silently overwriting either side.

## Initial plan

Identify the app shell, navigation, design tokens, reusable controls, screen states, and data boundaries. Recommend what to reuse directly and what to adapt, based on the target stack and observed source quality. Avoid a wholesale rewrite by default.

Plan small, reviewable increments:
- Runnable foundation using existing repo conventions.
- One representative screen or complete flow using realistic mock data, demonstrating styling and state handling.
- Remaining flows and necessary real integrations.

For each increment, state scope, affected areas, acceptance criteria, and appropriate functional/visual checks. Include relevant empty, loading, error, and responsive states rather than inventing unspecified product requirements. Record unresolved behavior as a question or explicit assumption.

## Iteration plan

Compare three inputs: the prior Make snapshot, the new Make snapshot, and the current POC. A source-to-source diff alone cannot establish what the POC needs.

- Read the designer's change note and affected screenshots first when supplied.
- Use file-level differences to focus inspection; follow changes to shared styles/components into their consumers.
- Separate intentional appearance or behavior changes from generated-code churn. Treat uncertain intent as uncertain, including apparent deletion of screens.
- For each meaningful change, record old versus new behavior, evidence paths, affected POC areas, whether already implemented, and a proposed disposition: implement, defer, or resolve conflict.
- Preserve working backend integrations, fixes, and intentional deviations. Do not copy the new export over the POC.
- If the old snapshot is missing, use the guide and current app for a provisional comparison. Label it as such; do not fabricate a historical delta. Ask for the old snapshot only if it is necessary to resolve a consequential ambiguity.

Finish with a prioritized implementation plan, acceptance criteria, test plan, and any decisions that block implementation. A planning-only request ends with this concrete plan, not application edits.

## Durable context

Reuse an existing equivalent location; otherwise maintain `docs/POC_GUIDE.md` as the concise entry point and `docs/poc/plans/<iteration>.md` for detailed plans. Link to source files and screenshots instead of embedding large excerpts. Keep originals untouched and reference immutable snapshots or commits when possible; do not commit bulky exports or relocate user files without a need and authorization.

The guide should contain:
- POC objective, target platform, real/mocked boundaries, and run/verification instructions (mark untested commands).
- Make snapshot identifiers, locations or commits, date, and available visual references. Record a checksum when useful for otherwise ambiguous local exports; a moving URL alone is not a durable baseline.
- **Reviewed design baseline:** the latest snapshot actually inspected.
- **Implementation coverage:** per-flow or per-change status, source iteration, intentional deviations, and pending/deferred work. Do not label the entire app current when only part was implemented.
- Screen/flow map: purpose and important states, exact Make source paths, corresponding POC paths where present, and visual reference locations. Mark planned files as planned.
- Shared components, token/asset locations, and significant implementation conventions.
- Links to the active plan, open decisions, and relevant supporting references.

In planning runs, advance only the reviewed baseline after inspection. Keep pending changes visible across subsequent iterations; reconcile unfinished plans with new intent instead of dropping them. Update implementation coverage only from verified code evidence or completed implementation, and distinguish implementation from runtime verification.

If repo instructions permit, add a short pointer to the guide in the existing agent instructions. Never overwrite existing instructions; if edits are prohibited, report the guide location instead.

## Completion

Check that reference paths exist or are clearly marked planned/unavailable, the plan covers the requested journey, and baseline/coverage claims match observed evidence. Report the selected workflow, guide and plan locations, key decisions, and remaining blockers. When implementation is also authorized, follow the plan, verify affected flows and appearance, and update coverage to reflect the actual result.
