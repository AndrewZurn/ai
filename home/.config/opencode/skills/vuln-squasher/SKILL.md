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
