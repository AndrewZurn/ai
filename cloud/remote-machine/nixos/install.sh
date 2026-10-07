#!/usr/bin/env bash
set -euo pipefail

: "${TARGET_HOST:?Set TARGET_HOST to root@the-server-ip}"
: "${SSH_PUBLIC_KEY:?Set SSH_PUBLIC_KEY to the public key used to access the server}"
: "${TAILSCALE_AUTH_KEY:?Set TAILSCALE_AUTH_KEY to a reusable Tailscale auth key}"
: "${GITHUB_SSH_PRIVATE_KEY:?Set GITHUB_SSH_PRIVATE_KEY to the private SSH key for the GitHub machine user}"

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
work_dir=$(mktemp -d)
extra_files="${work_dir}/extra-files"
flake_dir="${work_dir}/nixos"
trap 'rm -rf "${work_dir}"' EXIT

umask 077
mkdir -p "${flake_dir}"
cp -R "${script_dir}/." "${flake_dir}/"
mkdir -p "${extra_files}/etc/ssh/authorized_keys.d" "${extra_files}/root/.ssh"
printf '%s\n' "${SSH_PUBLIC_KEY}" > "${extra_files}/etc/ssh/authorized_keys.d/root"
printf '%s\n' "${TAILSCALE_AUTH_KEY}" > "${extra_files}/root/tailscale-auth-key"
printf '%s\n' "${GITHUB_SSH_PRIVATE_KEY}" > "${extra_files}/root/.ssh/id_ed25519"

nix --extra-experimental-features 'nix-command flakes' \
  run github:nix-community/nixos-anywhere -- \
  --extra-files "${extra_files}" \
  --build-on remote \
  --flake "${flake_dir}#remote-devbox" \
  --target-host "${TARGET_HOST}"
