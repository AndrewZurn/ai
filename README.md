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

### Check link status

```bash
./scripts/check-links.sh
```

This prints OK/missing/wrong-target statuses and exits non-zero if anything is off.
