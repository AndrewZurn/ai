# AGENTS.md

This repository manages symlinks from `home/` into `$HOME`.
It is intentionally small and script-driven.

## Quick Orientation

- `home/` mirrors `$HOME` paths that should be linked.
- `scripts/links.txt` lists paths (relative to `home/`) to link.
- `scripts/retired-links.txt` lists obsolete repository-owned symlinks.
- `scripts/link-home.sh` backs up replaced/retired paths and creates symlinks.
- `scripts/check-links.sh` verifies link targets.
- `config/opencode/` contains common settings and machine profiles.
- `scripts/opencode-profile.mjs` builds local OpenCode config; `oc2 --setup`
  selects a machine profile. See README.md's **OpenCode 2** section before editing.

## Build / Lint / Test

There is no repository-wide build system, linter, or test framework.
Use the scripts below as the primary validation mechanisms.

### Primary Commands

- Link all configured paths:
  - `./scripts/link-home.sh`
- Check link status:
  - `./scripts/check-links.sh`
- Test link migration in an isolated temporary home:
  - `bash scripts/test-links.sh`
- Test OpenCode profiles and the launcher in isolated temporary homes:
  - `node --test scripts/opencode-profile.test.mjs`
- Test the OpenCode Go usage plugin with Node's built-in runner:
  - `node --test home/.config/opencode/plugins/go-usage/test/usage-core.test.js`
- Test the mandatory swarm plugin without providers or downloads:
  - `node --test home/.config/opencode/plugins/swarm/test/*.test.js`

### Single-Test Equivalents

For a read-only check of the installed links:

- Validate link status only:
  - `./scripts/check-links.sh`

If you need to validate a single link path, use `scripts/check-links.sh`
and temporarily narrow `scripts/links.txt` in your working tree.
Do not commit narrowed `scripts/links.txt` unless explicitly requested.

### Manual Verification

- Ensure `home/` contains the target files/dirs listed in
  `scripts/links.txt`.
- Ensure `.link-backups/` is created when existing paths are backed up.

## Code Style Guidelines

This repo is primarily Bash plus plain text/JSON. Follow the style in
existing scripts and keep changes minimal.

### Bash Scripts

- Use `#!/usr/bin/env bash` shebang for scripts.
- Start scripts with `set -euo pipefail` for strictness.
- Use `printf` over `echo` for predictable output.
- Quote variables unless word splitting is intended.
- Prefer `${var}` and `${var%pattern}` style expansions already used.
- Use `[[ ... ]]` for tests and `-e`, `-f`, `-d`, `-L` for file checks.
- Use `IFS= read -r` when reading lines to avoid escaping issues.
- Trim comments and whitespace defensively (see existing scripts).
- Avoid subshell-heavy pipelines when a simple loop suffices.
- Avoid Bash arrays unless they improve clarity for multiple values.

### Error Handling

- Fail fast on missing inputs (`home/`, `scripts/links.txt`).
- Write errors to stderr via `printf ... >&2`.
- Return non-zero exit codes on validation failures.
- Prefer explicit `status` aggregation for validation results.

### Imports / Dependencies

- OpenCode profile setup requires Node.js 22+ and no external Node packages.
- Scripts rely on standard Unix tools (`bash`, `readlink`, `mkdir`, `mv`, `ln`).
- If adding new tool usage, ensure it exists on macOS (darwin).

### Formatting

- Keep indentation at two spaces in shell scripts.
- Use blank lines to separate logical blocks.
- Keep lines reasonably short; wrap long `printf` strings when helpful.
- Avoid tabs in scripts and text files.

### Naming Conventions

- File names: lower-case, hyphenated shell scripts (e.g., `check-links.sh`).
- Variables: lower-case with underscores (e.g., `home_root`, `links_file`).
- Prefer descriptive variable names over short abbreviations.

### JSON Files

- Keep valid JSON with double-quoted keys and values.
- Preserve existing formatting style (two-space indentation).
- Avoid trailing commas (JSON does not allow them).

### Text Files

- `scripts/links.txt` contains one path per line.
- Allow comments with `#` and ignore blank lines.
- Paths are relative to `home/`.

## Repository-Specific Practices

- The `home/` directory mirrors `$HOME`.
- Symlinks are created into `$HOME` and backed up under a unique
  `.link-backups/<timestamp>-<suffix>/` directory, preserving relative paths.
- Retire only symlinks whose exact targets belong to this checkout; leave
  unmanaged retired paths untouched.
- OpenCode 2 uses `home/.config/opencode/`; do not restore the isolated V2 tree.
- OpenCode's `opencode.jsonc` and `oc2-profile.json` are generated local files,
  not managed symlinks. Never add them to `scripts/links.txt` or commit them.
- Keep shared agent files model-neutral; assign models in machine profiles.
- Keep explicit provider allowlists in each profile. Work permits only OpenAI
  and Copilot; profile policy rules must not weaken that boundary.
- New profiles are discovered from `config/opencode/profiles/*.json`; do not
  hard-code profile names in scripts. Update README.md and tests for new features.
- Do not remove or overwrite a user’s files without backing them up.
- Keep link logic idempotent: re-running should be safe.

## Cursor / Copilot Rules

No `.cursor/rules`, `.cursorrules`, or `.github/copilot-instructions.md`
files were found in this repository at the time of writing.

## When Updating This File

- Keep content concise and aligned with actual scripts.
- Avoid inventing build/test tools that are not present.
- Update commands if new scripts or tooling are added.
