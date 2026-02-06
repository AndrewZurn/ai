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

This script will back up existing paths in the repo at `.link-backups/<timestamp>` and then create symlinks.

### Import files and directories into home/

Use the import script to copy an external file or directory into `home/`
and automatically add the resulting path to `scripts/links.txt`.

```bash
# Import a directory (keeps the basename by default)
./scripts/import-home.sh ~/.gemini/skills .gemini

# Import a single file
./scripts/import-home.sh ~/.config/opencode/opencode.json .config/opencode
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
