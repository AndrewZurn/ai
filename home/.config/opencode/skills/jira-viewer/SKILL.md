---
name: jira-viewer
description:
  Expertise in viewing and summarizing Jira ticket content. Use when the user
  wants to read, review, inspect, or discuss existing Jira issues.
---

# Jira Ticket Viewer

## Purpose

Retrieve and present Jira ticket content so the user can review, discuss, or make decisions about existing issues. This skill is read-only -- it never creates or modifies tickets.

## When to Use

- User asks to "look at", "show", "view", "pull up", or "review" a Jira ticket.
- User references a ticket key (e.g., `PROJ-123`) and wants to see its content.
- User asks to list or search for tickets in a project or sprint.
- User wants to compare multiple tickets or summarize a backlog.

## Jira CLI Commands

Use the `jira` CLI for all read operations. It is safe for viewing -- the markup conversion issues only affect writing.

### View a single ticket

```bash
jira issue view <ISSUE-KEY>
```

Add `--plain` for a cleaner terminal-friendly output:

```bash
jira issue view <ISSUE-KEY> --plain
```

Add `--raw` to get the full JSON payload (useful for inspecting exact field values):

```bash
jira issue view <ISSUE-KEY> --raw
```

### List tickets in a project

```bash
jira issue list -q"project = <PROJECT_KEY>"
```

### List tickets with JQL filters

```bash
jira issue list -q"project = <PROJECT_KEY> AND status = 'To Do'"
jira issue list -q"project = <PROJECT_KEY> AND assignee = currentUser()"
jira issue list -q"project = <PROJECT_KEY> AND sprint in openSprints()"
```

### View sprint board

```bash
jira sprint list
jira sprint list --current
```

## Output Guidelines

- Present ticket content in a readable format. Summarize long descriptions if the user asks for an overview.
- When showing a ticket, include: key, summary, status, assignee, and description.
- If the user asks about specific fields (priority, labels, fix version, etc.), extract them from `--raw` JSON output.
- When comparing tickets, present a concise side-by-side summary of the key differences.
- Do not modify any ticket content. If the user wants changes, direct them to the `jira-editor` or `jira-story-drafter` skills.
