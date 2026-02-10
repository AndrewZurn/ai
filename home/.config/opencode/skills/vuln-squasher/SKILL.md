---
name: vuln-squasher
description: A skill to manage dependency vulnerability remediatation.
---

# Skill

Use the Snyk MCP to scan this project's dependencies, then update any
vulnerable dependencies, run tests, and fix any issues that occur.
Only update MEDIUM, HIGH or CRITICAL vulnerabilities. Prefer to update the
direct dependencies to fix issues rather than pinning transitive dependency
versions.

If this is a Gradle project:

- remove all existing `constraints` before running scan
- use the `constraints` construct and include a `because` if updating
  transitive dependencies
- To test, use `./gradlew test`.

When you are done (the code compiles and all tests pass), print out a list of
the CVEs that were remediated, their severity, and the dependency that was
updated to remediate it.

Finally, create a commit and use the GitHub MCP server to create a Pull
Request against master or main branch for the repo you are currently working
in, including the actions taken and vulnerabilities that were remediated.

Use the following commit and PR title template:

```
(chore): Remediate vulnerabilities in <INSERT_PROJECT_NAME>
```
