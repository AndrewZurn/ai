# NixOS remote development machine

This setup provisions a Hetzner Cloud server for NixOS, Herdr, and OpenCode, with a Cloudflare Worker managing lifecycle operations.

## Architecture

- Hetzner **CPX31** server in Hillsboro (`hil`), initially bootstrapped with Ubuntu.
- Convert the initial server to NixOS with `nixos-anywhere`.
- Tailscale provides access from laptops and phones; Herdr and OpenCode are installed automatically by NixOS.
- The Worker exposes authenticated `POST /start`, `POST /stop`, and `GET /status` endpoints.
- The Worker never starts the server automatically.
- At 10pm Pacific, or after two hours below the configured CPU threshold, it gracefully shuts down, snapshots, and deletes the server.
- A later explicit `/start` recreates it from the newest available snapshot created from the `remote-devbox` server, including snapshots made manually in Hetzner, and reattaches the reserved IPv4 address.
- Snapshot reconciliation retains only the two newest snapshots labeled as Worker-managed. Manually created and older unlabeled snapshots can be used to start the server but are never pruned automatically.

Snapshot/recreate reduces compute billing, but snapshots and the reserved IPv4 address still cost money. The snapshot preserves the disk and Tailscale state, but not running processes or RAM. Do not run Terraform again after lifecycle management is handed to the Worker.

## Setup

1. Create a reusable Tailscale auth key tagged `tag:devbox`.
2. Create a Hetzner API token, a Hetzner SSH key, and a Cloudflare KV namespace.
3. Copy `terraform/terraform.tfvars.example` to `terraform/terraform.tfvars`, fill it in, and run:

   ```sh
   cd terraform
   terraform init
   terraform apply
   ```

4. Create an SSH key for a GitHub machine-user account that has write access to the repositories in `nixos/repos.txt`. Add the public key to that GitHub account (not as a deploy key: GitHub deploy keys are limited to one repository each). Then convert the bootstrap server to NixOS. The checked-in configuration uses Disko to partition `/dev/sda`, enrolls Tailscale, installs Herdr and OpenCode v2, and installs the Herdr OpenCode integration. From this directory, run:

   ```sh
   ssh-keygen -t ed25519 -N '' -f ~/.ssh/remote-devbox-github
   export TARGET_HOST=root@SERVER_IP
   export SSH_PUBLIC_KEY="$(cat ~/.ssh/id_ed25519.pub)"
   export TAILSCALE_AUTH_KEY=tskey-auth-...
   export GITHUB_SSH_PRIVATE_KEY="$(cat ~/.ssh/remote-devbox-github)"
   ./nixos/install.sh
   ```

    This is destructive: `nixos-anywhere` replaces the Ubuntu filesystem. Confirm `SERVER_IP` is the reserved IPv4 address before running it. See [Managing NixOS](#managing-nixos) for subsequent changes.

5. Create a KV namespace named `remote-devbox-state`, copy its ID into `worker/wrangler.jsonc`, and leave its binding as `REMOTE_DEVBOX_STATE`. Copy the Terraform `primary_ip_id` output into the same file.
6. Set the KV namespace ID and Worker secrets:

   ```sh
   cd worker
   npx wrangler secret put HETZNER_TOKEN
   npx wrangler secret put BASIC_AUTH_PASSWORD
   npx wrangler deploy
   ```

7. Allow the initial NixOS server to boot and complete Tailscale enrollment. The first `/stop` creates the snapshot used by future `/start` requests.

## Managing NixOS

Keep the `nixos/` directory in version control. Edit `nixos/configuration.nix` to add packages to `environment.systemPackages`, enable services, or change system settings. Apply changes to the running machine from an x86_64 Linux builder (the server itself is suitable):

```sh
export TARGET_HOST=root@SERVER_IP
nixos-rebuild switch \
  --flake ./nixos#remote-devbox \
  --build-host "$TARGET_HOST" \
  --target-host "$TARGET_HOST"
```

The NixOS configuration uses `nixos-26.05` and enables flakes and `nix-ld`. Do not run Terraform after the Worker takes over lifecycle management. Deploy NixOS changes before creating a new snapshot so future `/start` operations receive them.

Herdr and OpenCode are upstream Linux binaries, not currently Nix packages in this configuration. The `remote-tools` systemd service installs them into `/root` and installs the Herdr OpenCode integration. The base tools (`curl`, `jq`, and `tmux`) are managed declaratively by Nix in `configuration.nix`; Git and the commit identity are configured through the NixOS Git module.

The `seed-repos` systemd service reads `nixos/repos.txt` and clones repositories into `/root/src/<repo>` on boot. Existing clones only run `git fetch --prune`; the service does not change checked-out branches or working trees. Add one `owner/repo` per line (or an SSH clone URL for another host), rebuild, then run `systemctl restart seed-repos` to apply list changes immediately. Entries are never deleted from disk when removed from the list, and repository names must be unique because the clone directory is based on the final path segment. The list must be committed to Git for Nix flakes to include it.

For an already-installed machine, install the machine-user key without reinstalling NixOS:

```sh
ssh root@SERVER_IP 'install -d -m 700 /root/.ssh'
scp ~/.ssh/remote-devbox-github root@SERVER_IP:/root/.ssh/id_ed25519
ssh root@SERVER_IP 'chmod 600 /root/.ssh/id_ed25519 && systemctl restart seed-repos'
```

The public key provides access to every private repository granted to that GitHub account, so protect the private key accordingly. The Git identity is `Andrew Zurn <awzurn@gmail.com>`.

## API

```sh
curl -u "$BASIC_AUTH_USERNAME:$BASIC_AUTH_PASSWORD" -X POST https://WORKER_URL/start
curl -u "$BASIC_AUTH_USERNAME:$BASIC_AUTH_PASSWORD" -X POST https://WORKER_URL/stop
curl -u "$BASIC_AUTH_USERNAME:$BASIC_AUTH_PASSWORD" https://WORKER_URL/status
```

`/start` is the only automatic creation path. Lifecycle operations return `202` because Hetzner actions are asynchronous.

## Idle policy

The default policy is average CPU below **5% for 120 minutes**. Adjust `IDLE_CPU_PERCENT` and `IDLE_MINUTES` in `worker/wrangler.jsonc`. CPU-only detection can stop a server while an agent is waiting on a network response, so use `/stop` manually or raise the threshold if that risk is unacceptable.

## Validation

- `terraform fmt -check terraform`
- `terraform validate` from `terraform/`
- `npx wrangler deploy --dry-run` from `worker/`
- Test unauthorized, `/status`, `/start`, and `/stop` before relying on the schedule.
