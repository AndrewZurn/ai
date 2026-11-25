# AI workspace

This repository is a central location for all AI-related work, including
tooling, apps, integrations, and experiments. It will grow over time as new
projects are added.

## Tooling

This section covers the current tooling that manages AI configuration files
under your `$HOME` directory using symlinks. Additional sections will be added
as more tooling, apps, and integrations land in this repo.

### Layout

The `home/` directory mirrors `$HOME` paths. For example:

- `home/.config/opencode/skills` maps to `$HOME/.config/opencode/skills`

### Manage links

1. Add paths to `scripts/links.txt` (relative to `home/`).
2. Ensure the files/directories exist under `home/`.
3. Run the link script:

```bash
./scripts/link-home.sh
```

This script backs up existing paths under `.link-backups/` and creates symlinks.

Backups use a unique timestamped directory and preserve paths relative to `$HOME`,
so files with the same basename do not overwrite one another.
`scripts/retired-links.txt` lists obsolete links: the script backs them up only
when they point to this checkout. Other files and symlinks at retired paths are
left untouched.

### OpenCode 2

Use one saved profile per machine. Shared instructions, agent prompts and
permissions, commands, skills, plugins, and `cli.json` stay under
`home/.config/opencode/`. Model choices belong in profiles, not shared agent files.

#### Set up a machine

Prerequisites: Bash, Node.js 22 or newer, and OpenCode 2.2.3 or newer installed as
`opencode2`. Setup does not install packages or download scripts.

From the checkout:

```bash
./scripts/link-home.sh
export PATH="$HOME/.local/bin:$PATH"
oc2 --list-profiles
oc2 --setup work       # Work machine
# oc2 --setup personal  # Personal machine
oc2 --profile-status
oc2
```

Keep `$HOME/.local/bin` in your shell's `PATH`. Before linking, the equivalent
setup command is `./home/.local/bin/oc2 --setup work`.

The environment-variable form is also supported:

```bash
OPENCODE_PROFILE=personal oc2 --setup
```

If both an argument and `OPENCODE_PROFILE` are set, they must agree. The variable
only selects setup; it never switches profiles during a normal launch.
The setup commands exit without launching OpenCode.

`oc2` manages only `~/.config/opencode/`. Unset a legacy `XDG_CONFIG_HOME` override
before setup or launch. This includes overrides inherited from the removed
`opencode-v2` and `opencode2-v2` wrappers. Do not create another isolated config tree.

Setup combines `config/opencode/common.json` with the selected
`config/opencode/profiles/<name>.json`. It writes two local regular files:

- `~/.config/opencode/opencode.jsonc`: the generated OpenCode config.
- `~/.config/opencode/oc2-profile.json`: the selected profile and launcher settings.

These files must not be linked into the repository or committed. Setup backs up
existing files and symlinks under `.link-backups/opencode-profile-*`, including
a conflicting legacy `opencode.json`. It never writes through an old config
symlink. Failed replacements restore the previous files. Repeating unchanged
setup does not rewrite files or create another backup.

Normal launches check that the saved config still matches its source profile.
After changing or pulling profile settings, run `oc2 --setup <name>` again.
Edit the source files, not the generated config. A missing profile, invalid input,
or stale generated config stops the launcher rather than selecting another profile.
The general link/check scripts manage shared symlinks only; use
`oc2 --profile-status` to check the generated config.

After setup, use `/connect` to sign in to the required providers and `/models` to
check the available model IDs. Credentials stay in the local OpenCode credential
store. Setup validates JSON structure, required agent models, model-reference
syntax, and provider restrictions; it does not authenticate or check subscription
entitlements, live model availability, or the complete OpenCode schema.

#### Included profiles and restrictions

| Profile | Defaults | Allowed providers |
| --- | --- | --- |
| `personal` | Current Go build/plan models; Go reviewer | `opencode-go`, `mlx`, `local-llama`, `ollama`, `lmstudio`, `vllm` |
| `work` | OpenAI build/plan; existing OpenAI reviewer | `openai`, `github-copilot` |

Both profiles enable the local [Playwright MCP](https://github.com/microsoft/playwright-mcp)
server through `npx -y @playwright/mcp@latest`. OpenCode starts it automatically
after the selected profile is regenerated with `oc2 --setup <name>`. This can
download the package on first use; setup itself does not install or start it.
Playwright uses a separate persistent browser profile, not your regular browser
session. Use `/mcps` to check its connection.

Work keeps the Snyk (`synk`), Lucid, and Datadog MCP servers disabled and blocks the Go usage plugin.
Copilot is allowed, but no Copilot model ID is assumed: connect the account, check
`/models`, then update the work profile if it should be the default.
Personal retains the local provider settings. Existing sessions can retain their
selected model; profile defaults do not reset those selections.

Every profile needs an explicit `allowed_providers` list. Setup appends a
`provider.use` deny-all rule followed by exact allows. Project configuration
cannot lift this global restriction. An unavailable model can fall back only
within the permitted providers, not to a personal provider on a work machine.
Higher-authority system or organization policies still apply. Provider policies
are not a network sandbox for tools/plugins, an account/organization restriction,
or protection for a separately selected remote server. Use approved work accounts
and enforce remote-server policy on that server.

The optional `launcher.ca_file` setting belongs to the work profile. `oc2` sets
`NODE_EXTRA_CA_CERTS` only when that file exists and the caller has not set a value.
It does not set a corporate CA on a personal machine. This affects the launched
client and newly inherited child processes, not an already-running server.
If the shared server also needs the CA, configure its environment separately with
the documented OpenCode service commands. Those commands stop the server, so do
not run them as an automatic setup step.

Setup does not sign in, change service settings, or restart the service. OpenCode
reloads configuration changes; use `/reload` if a full config reload is needed.
Machine-specific `service.json` and Herdr-generated files stay with their owning
tools. `oc2-restart-service` remains an explicit, separate service helper.

#### Add a profile

1. Copy `config/opencode/profiles/personal.json` to a new `<name>.json`.
   Names use lowercase letters/digits and single hyphens, such as `travel` or
   `work-laptop`. Profile discovery requires no script changes.
2. Set `description` and a non-empty, unique `allowed_providers` list of exact IDs.
3. Under `config`, set the root `model` and the models for `build`, `plan`,
   `orchestrator`, `builder`, `adversarial-reviewer`, `test-engineer`, and
   `specification-reviewer`, and `ui-design-reviewer`. Additional agents and commands can set models too.
   Every explicit model must use an allowed provider. Confirm IDs and variants
   with `/models`; do not guess them.
4. Add provider/MCP settings under `config`, and an optional absolute
   `launcher.ca_file` path. Keep private hostnames, credentials, and tokens out
   of Git. Use environment references for secrets, supplied to the server.
5. Run the tests below, then `oc2 --setup <name>` and `oc2 --profile-status`.

The profile envelope accepts only `description`, `allowed_providers`, `launcher`,
and `config`. Files use strict JSON, not JSONC. Objects merge by key; arrays and
scalars replace the common value. Provider-boundary rules are appended last and
cannot be weakened by rules in `config`. Omitted optional settings inherit from
the common file; keep machine-specific settings out of that file.

For future agents: keep prompts and permissions shared, keep model assignments
in profiles, and never restore the generated-config symlink in `scripts/links.txt`.
When adding profile features, update this section and the profile tests.

#### Mandatory review swarm

The opt-in `orchestrator` uses a local server plugin to dispatch a `builder`,
then three concurrent baseline reviewers. Completion requires explicit approval from
`adversarial-reviewer`, `test-engineer`, and `specification-reviewer` for the
same candidate. UI changes additionally require `ui-design-reviewer`, dispatched
after the baseline reviewers finish to avoid shared Playwright browser conflicts.
Both the test engineer and UI design reviewer use Playwright MCP for web UI work;
non-web UI uses platform-appropriate checks. No UI work means no UI design agent.
The builder records UI scope and evidence; reviewers check that classification.
Only a finding's owner can verify its fix or accept dismissal.
Findings first return to the orchestrator for mandatory fix/dismiss triage.
The builder must follow those decisions; proposed dismissals still need the
owning reviewer's agreement.
After all required reviewers approve, the orchestrator generates a self-contained HTML
summary in `<repository-root>/.swarms/`. The plugin automatically opens it in
the browser and records its path in `htmlReport`.

After regenerating your selected profile, start from a Git checkout's canonical
root and use `/swarm --plan docs/plan.md [task and acceptance criteria]`.
The plan file is required. The orchestrator reviews it and asks targeted
questions before any builder starts. Answers are recorded without editing the
plan; implementation starts automatically once the plan is clear.
Use `/swarm-status`, `/swarm-resume`, and `/swarm-cancel` to inspect or control
the run. After implementation starts, new user input blocks the run until
resumed so changed requirements cannot retain old approvals.
The default agent remains Plan and ordinary Build behavior is unchanged.

See [the Swarm plugin guide](home/.config/opencode/plugins/swarm/README.md)
for test-engineer responsibilities, recovery, permissions, and limitations.
The plugin enforces its approval state; it cannot veto a model's final prose
reply or block commits/merges outside the workflow.

#### Validate

These tests use temporary homes and require no downloads or provider requests:

```bash
node --test scripts/opencode-profile.test.mjs
bash scripts/test-links.sh
node --test home/.config/opencode/plugins/go-usage/test/usage-core.test.js
node --test home/.config/opencode/plugins/swarm/test/*.test.js
```

### Import files and directories into home/

Use the import script to copy an external file or directory into `home/`
and automatically add the resulting path to `scripts/links.txt`.

```bash
# Import a directory (keeps the basename by default)
./scripts/import-home.sh ~/.gemini/skills .gemini

# Import a single file
./scripts/import-home.sh ~/.gemini/settings.json .gemini
```

Notes:
- The destination is under `home/` and defaults to appending the source
  basename when the target path does not already end with it.
- The script refuses to overwrite existing destinations.
- Do not import generated OpenCode profile files; edit profile source files instead.

### Check link status

```bash
./scripts/check-links.sh
```

This prints OK/missing/wrong-target statuses and exits non-zero if anything is off.
