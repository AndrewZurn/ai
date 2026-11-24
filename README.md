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

`home/.config/opencode/` is the single OpenCode 2 configuration:

- `opencode.jsonc`: agents, local providers, and disabled optional MCP servers.
- `cli.json`: terminal preferences, without a repository-managed Herdr plugin.
- `agents/`, `commands/`, `skills/`, and `plugins/`: shared definitions and plugins.

`oc2` forwards arguments directly to the installed `opencode2` binary and retains
the Netskope CA setting. `oc2-restart-service` remains an explicit helper for
binding the service to a detected `192.168.x.x` address and restarting it.
Neither linking nor this migration restarts the service or installs binaries.

Run `./scripts/link-home.sh` to migrate an existing checkout. It replaces the
old config links, backs up a local `cli.json` before linking V2 preferences, and
retires the old isolated config and wrapper links. The `opencode-v2` and
`opencode2-v2` wrappers are no longer used.

Machine-specific `service.json` stays outside version control and is not linked.
Existing service settings and credentials are not migrated or changed. Unmanaged
files, including Herdr-generated files, are left to their owning tools.

A client already launched with the old isolation wrapper retains its process's
`XDG_CONFIG_HOME`. Launch future clients with `oc2` from a normal shell without
that legacy environment override.

Validate link behavior and the usage plugin without downloads:

```bash
bash scripts/test-links.sh
node --test home/.config/opencode/plugins/go-usage/test/usage-core.test.js
```

### Import files and directories into home/

Use the import script to copy an external file or directory into `home/`
and automatically add the resulting path to `scripts/links.txt`.

```bash
# Import a directory (keeps the basename by default)
./scripts/import-home.sh ~/.gemini/skills .gemini

# Import a single file
./scripts/import-home.sh ~/.config/opencode/opencode.jsonc .config/opencode
```

Notes:
- The destination is under `home/` and defaults to appending the source
  basename when the target path does not already end with it.
- The script refuses to overwrite existing destinations.

### Check link status

```bash
./scripts/check-links.sh
```

This prints OK/missing/wrong-target statuses and exits non-zero if anything is off.
