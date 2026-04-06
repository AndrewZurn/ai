---
name: jira-story-drafter
description: Expertise in creating Jira story tickets to define new features in a system.
---

# Jira Story Drafting Skill

## Purpose

Create clear, implementation-ready Jira stories for new features in a health data platform using Jira Wiki Markup syntax (not GitHub/CommonMark markdown) and include the required sections in the correct order. Follow the "Jira Wiki Markup Rules" section precisely to avoid rendering issues. Review the content of the ticket with the user, and then offer to do one of the following:

- Offer to write the content to a file.
- Offer to create the ticket on a Jira instance. Ask the user what the project key is. Use the `create-jira-story.py` script bundled with this skill (see "Ticket Creation" below). Do NOT use the `jira` CLI for creation -- it runs a markdown-to-wiki converter that corrupts bold markers, brace escapes, and bullet prefixes.

## Ticket Creation

Requirements:

- The environment variable `JIRA_API_TOKEN` must contain a valid bearer token (PAT).
- The Jira server URL can be read from `~/.config/.jira/.config.yml` (look for the `server:` key) or asked from the user.

Write the ticket description to a temp file, then invoke the script:

```bash
tmpfile="$(mktemp -t jira-story)"
cat > "$tmpfile" <<'EOF'
<TICKET_CONTENT>
EOF

python3 create-jira-story.py \
  --server <JIRA_SERVER_URL> \
  --project <PROJECT> \
  --summary "<STORY_SUMMARY>" \
  --epic-link "<EPIC_KEY>" \
  --body-file "$tmpfile"

rm -f "$tmpfile"
```

The script also accepts optional flags:

- `--fix-version "<VERSION>"` (repeatable)
- `--epic-link "<EPIC_KEY>"`
- `--label "<LABEL>"` (repeatable)
- `--priority "<PRIORITY>"`

When the user provides an epic, pass it directly with `--epic-link` during ticket creation instead of creating the issue first and patching the Epic Link afterward.

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
- Each Gherkin keyword MUST start a new line. Keep the full clause on that single line — do not wrap mid-sentence.
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

## Jira Wiki Markup Rules

These rules are critical for producing well-formatted Jira tickets. Violations cause broken rendering (literal asterisks, runaway emphasis, macro errors).

### Bold/emphasis (`*...*`)

- Every `*open*` and `*close*` pair MUST live on the **same line**. Never let a `*` span across a line break.
- The opening `*` must touch the first character of the bolded word (no space after `*`).
- The closing `*` must touch the last character of the bolded word (no space before `*`).
- When bolding an inline term inside a sentence, keep the whole `*term*` on one line. If the sentence is long, break the line **outside** the bold markers.

Good — single-line bold pairs:

```
*Given* a valid bearer token and the user exists
*When* the client calls *GET /v1/users* with a valid token
```

Bad — bold spanning a line break:

```
*Given a valid bearer token
and the user exists*
```

### Escaping special characters

- **Curly braces** — Jira interprets `{text}` as macros. Escape with backslash: `\{userId\}`.
- **Underscores in identifiers** — Jira interprets `_text_` as italic. Escape mid-word underscores: `HEALTH\_SYSTEM`, `user\_id`.
- **Square brackets** — Jira interprets `[text]` as links. Escape if literal: `\[value\]`.

### Line spacing

- One blank line between every `h2.` / `h3.` header and the content that follows.
- One blank line between the last line of a section and the next header.
- No blank lines between consecutive Gherkin keyword lines (`*Given*` / `*When*` / `*Then*` / `*And*`).

### Bullet lists

- Use `-` (hyphen + space) for unordered list items in the Technical Details section.
- Each bullet should be a single, self-contained line. Do not wrap a bullet across multiple lines.

## Style Rules

- Use concise, implementation-focused language.
- Prefer explicit paths in scenarios (e.g., `*GET /v1/users*`, `*GET /v1/users/\{userId\}*`).
- Do not include implementation code.
- Bold API paths, HTTP methods, status codes, class names, and parameter names when they appear inline (e.g., `*ConnectionsController*`, `*400 Bad Request*`, `*type*`).

## Full Example

```
h2. User Story

As a <persona>, I want *<HTTP\_METHOD> /v1/resources/\{resourceId\}* to <desired behavior> so that <business value or reason>.

h2. Acceptance Criteria

h3. Scenario: <Happy path description>

*Given* <preconditions on a single line>
*When* the client calls *<HTTP\_METHOD> /v1/resources/\{resourceId\}* with <request details>
*Then* the API returns <expected response> with a status code *200*

h3. Scenario: <Auth failure description>

*Given* an expired or missing bearer token
*When* the client calls *<HTTP\_METHOD> /v1/resources/\{resourceId\}*
*Then* the API returns a *401 Unauthorized* response

h3. Scenario: <Edge case description>

*Given* <edge case preconditions>
*When* the client calls *<HTTP\_METHOD> /v1/resources/\{resourceId\}* with <edge case input>
*Then* the API returns <graceful response> with a status code *<appropriate code>*

h2. Technical Details

- Implement <component or layer> changes for *<HTTP\_METHOD> /v1/resources/\{resourceId\}*
- Enforce authentication and scope-based authorization via *<auth mechanism>*
- Update OpenAPI specification to document the new endpoint contract
- Preserve existing performance characteristics; no additional downstream calls
- Add unit and integration test coverage for success, auth failure, not found, and error paths
```
