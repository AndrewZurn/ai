---
name: jira-story-drafter
description: Expertise in creating Jira story tickets to define new features in a system.
---

# Jira Story Drafting Skill

## Purpose

Create clear, implementation-ready Jira stories for Connection Hub endpoint work. The output must be Jira Markdown and include the required sections in the correct order.

## Required Sections (in order)

1. `h2. User Story`
2. `h2. Acceptance Criteria`
3. `h2. Technical Details`

## User Story Guidelines

- 1–2 sentences.
- Explicitly describe the feature from a user perspective.

## Acceptance Criteria Format

- Use Gherkin-style scenarios.
- Each scenario title is an `h3.` header.
- Each Given/When/Then/And keyword is bolded (e.g., `*Given*`).
- Include at least:
  - Happy path for the feature
  - Access control cases for the feature (scope/claims/token auth, etc.)
  - Edge cases for the feature, including graceful degradation if possible.
  - Timeout scenario: provider timeout during fan-out results in partial response (only successful providers).

## Technical Details Content

Include concise bullets covering:

- Authentication and authorization requirements
- Basic performance requirements
- Documentation requirements (ie. openapi specifications, system diagrams) as outputs for the ticket
- Testing expectations (unit, integration, etc.)

## Style Rules

- Use concise, implementation-focused language.
- Prefer explicit paths in scenarios (e.g., `/v1/connections`, `/v1/users/{userId}/connections`).
- Do not include implementation code.

## Example Snippet (Acceptance Criteria)

```
h3. Scenario: Access list of connections via /v1 with fan-out
*Given* a valid bearer token and either X-Account-Id header or JWT sub
*When* the client calls GET /v1/connections
*Then* the hub fans out to all configured providers in parallel and returns 200 with a merged connections array
```
