---
name: jira-story-drafter
description: Expertise in creating Jira story tickets to define new features in a system.
---

# Jira Story Drafting Skill

## Purpose

Create clear, implementation-ready Jira stories for new features in a health data platform using Jira Markdown syntax and include the required sections in the correct order. Ensure that there is an extra line between all header lines (h1., h2., etc.). Review the content of the ticket with the user, and then offer to do one of the following:

- Offer to write the content to a file.
- Offer to create the ticket on a Jira instance using the `jira cli` tool. Ask the user what the project ID is, and then create the ticket using `--template -` with a HEREDOC instead of trying to inline the full body via `--body`.

```bash
jira issue create \
  --project <PROJECT> \
  --type Story \
  --summary "<STORY_SUMMARY>" \
  --template - <<'EOF'
<TICKET_CONTENT>
EOF
```

## Jira CLI Creation Guidance

- Prefer `--template - <<'EOF'` for multiline ticket bodies. This is the most reliable way to preserve Jira Markdown and avoid shell-quoting failures.
- Do not use deeply nested shell quoting like `--body "$(cat <<'EOF' ... )"` for full ticket bodies. It is fragile and can fail with unmatched quotes.
- If you need to set fix versions, include `--fix-version "<FIX_VERSION>"` in the command.
- If the content must be reviewed or reused before creation, use a temporary file and pass it with `--template "$tmpfile"`.
- On macOS, prefer `mktemp -t jira-story` over Linux-style `mktemp /tmp/jira-story.XXXXXX.md`.

Reliable temp-file fallback:

```bash
tmpfile="$(mktemp -t jira-story)" &&
cat > "$tmpfile" <<'EOF'
<TICKET_CONTENT>
EOF
jira issue create \
  --project <PROJECT> \
  --type Story \
  --summary "<STORY_SUMMARY>" \
  --template "$tmpfile"
rm -f "$tmpfile"
```

## Required Sections (in order)

1. `h2. User Story`
2. `h2. Acceptance Criteria` (Scenarios)
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

## Technical Details Content

Include concise bullets covering:

- Authentication and authorization requirements
- Basic performance requirements
- Documentation requirements (ie. openapi specifications, system diagrams) as outputs for the ticket
- Testing expectations (unit, integration, etc.)

## Style Rules

- Use concise, implementation-focused language.
- Prefer explicit paths in scenarios (e.g., `/v1/users`, `/v1/users/{userId}`).
- Do not include implementation code.

## Example Scenario (Acceptance Criteria)

```
h3. Scenario: Access user info
*Given* a valid bearer token and the user exists in the system
*When* the client calls GET /v1/user
*Then* the API returns the user info with a status code 200
```
