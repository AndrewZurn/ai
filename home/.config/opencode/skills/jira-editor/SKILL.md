---
name: jira-editor
description:
  Expertise in editing a Jira ticket to meet 'Definition of Ready' criteria
  prior to it being able to be worked on by a team.
---

# Jira Definition of Ready Reviewer

## Purpose

Confirm Jira issues are ready for development by checking for clarity, completeness, and testability.

## Access Jira

- To view a list of tickets, prompt the user for a PROJECT_ID and then use: `jira issue list -q"project = <PROMPT_ID>"`
- To view the full description of a Jira ticket: `jira issue view <ISSUE-KEY>`

## Scope

- Stories, tasks, bugs
- Excludes spikes unless requested

## Checklist

### 1) Problem & Outcome

- Clear problem statement
- Success criteria defined

### 2) Acceptance Criteria (Gherkin)

- Gherkin format (Given/When/Then)
- Complete, testable scenarios
- Edge/error cases included

### 3) Scope & Requirements

- In/out of scope noted
- Functional + non-functional requirements stated

### 4) Dependencies & Risks

- Dependencies listed with owners
- Risks noted

### 5) Design & Technical

- Design links (if applicable)
- API/data changes documented

### 6) Testing & Delivery

- Test scenarios outlined
- Priority + estimate set

## Output Format

- Status: Ready / Needs Work
- Missing items
- Questions for author
- Next steps

## Reviewer Behavior

- Be concise, constructive, and specific
- Flag blockers early

## Version

- v1.0
