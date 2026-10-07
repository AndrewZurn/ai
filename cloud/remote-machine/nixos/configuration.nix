{ config, pkgs, ... }:

{
  boot.loader.grub = {
    device = "/dev/sda";
    efiSupport = true;
    efiInstallAsRemovable = true;
  };
  boot.initrd.availableKernelModules = [ "virtio_pci" "virtio_scsi" "ahci" ];

  networking.hostName = "remote-devbox";
  networking.useDHCP = true;
  time.timeZone = "America/Los_Angeles";
  i18n.defaultLocale = "en_US.UTF-8";

  nix.settings.experimental-features = [ "nix-command" "flakes" ];
  programs.nix-ld.enable = true;

  services.openssh.enable = true;
  services.openssh.settings.PermitRootLogin = "prohibit-password";
  services.openssh.authorizedKeysFiles = [ "/etc/ssh/authorized_keys.d/%u" ];
  services.tailscale.enable = true;

  environment.etc."ssh/ssh_known_hosts".text = ''
    github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl
  '';

  environment.etc."remote-machine/repos.txt".source = ./repos.txt;

  environment.systemPackages = with pkgs; [ curl jq tmux ];

  programs.git.enable = true;
  programs.git.config = {
    user.name = "Andrew Zurn";
    user.email = "awzurn@gmail.com";
  };

  systemd.services.tailscale-enroll = {
    description = "Enroll the remote machine with Tailscale";
    wantedBy = [ "multi-user.target" ];
    after = [ "network-online.target" "tailscale.service" ];
    wants = [ "network-online.target" ];
    serviceConfig = { Type = "oneshot"; RemainAfterExit = true; };
    script = ''
      if [ -s /root/tailscale-auth-key ]; then
        ${pkgs.tailscale}/bin/tailscale up \
          --auth-key="$(cat /root/tailscale-auth-key)" \
          --hostname=remote-devbox \
          --ssh
        rm -f /root/tailscale-auth-key
      fi
    '';
  };

  systemd.services.remote-tools = {
    description = "Install Herdr, OpenCode, and their integration";
    wantedBy = [ "multi-user.target" ];
    after = [ "network-online.target" "tailscale-enroll.service" ];
    wants = [ "network-online.target" ];
    serviceConfig = { Type = "oneshot"; RemainAfterExit = true; };
    script = ''
      set -eu
      export HOME=/root
      export PATH=/root/.local/bin:/root/.opencode/bin:/run/current-system/sw/bin:$PATH

      if [ ! -x /root/.local/bin/herdr ]; then
        installer=$(${pkgs.coreutils}/bin/mktemp)
        ${pkgs.curl}/bin/curl -fsSL -o "$installer" https://herdr.dev/install.sh
        ${pkgs.bash}/bin/bash "$installer"
        rm -f "$installer"
      fi
      if [ ! -x /root/.opencode/bin/opencode ]; then
        installer=$(${pkgs.coreutils}/bin/mktemp)
        ${pkgs.curl}/bin/curl -fsSL -o "$installer" https://opencode.ai/v2/install
        ${pkgs.bash}/bin/bash "$installer" --no-modify-path
        rm -f "$installer"
      fi

      test -x /root/.local/bin/herdr
      test -x /root/.opencode/bin/opencode

      mkdir -p /etc/remote-machine/bin /root/.config/opencode
      ln -sf /root/.local/bin/herdr /etc/remote-machine/bin/herdr
      ln -sf /root/.opencode/bin/opencode /etc/remote-machine/bin/opencode
      ln -sf /root/.opencode/bin/opencode2 /etc/remote-machine/bin/opencode2
      /root/.local/bin/herdr integration install opencode
    '';
  };

  systemd.services.seed-repos = {
    description = "Seed and update configured GitHub repositories";
    wantedBy = [ "multi-user.target" ];
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
    serviceConfig = { Type = "oneshot"; RemainAfterExit = true; };
    script = ''
      set -u
      export HOME=/root
      export GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/etc/ssh/ssh_known_hosts"

      repos_file=/etc/remote-machine/repos.txt
      src_root=/root/src
      status=0
      mkdir -p "$src_root"

      while IFS= read -r line || [ -n "$line" ]; do
        IFS=$' \t' read -r repo _ <<< "''${line%%#*}"
        [ -n "$repo" ] || continue

        if [[ "$repo" == *"://"* || "$repo" == *@* ]]; then
          clone_url="$repo"
        elif [[ "$repo" == */* && "$repo" != */*/* ]]; then
          clone_url="git@github.com:$repo.git"
        else
          printf 'Invalid repository entry: %s\n' "$repo" >&2
          status=1
          continue
        fi

        repo_name=''${repo##*/}
        repo_name=''${repo_name%.git}
        if [[ ! "$repo_name" =~ ^[A-Za-z0-9._-]+$ || "$repo_name" == . || "$repo_name" == .. ]]; then
          printf 'Invalid repository name in entry: %s\n' "$repo" >&2
          status=1
          continue
        fi

        target="$src_root/$repo_name"
        if [[ -e "$target" || -L "$target" ]]; then
          if ! ${pkgs.git}/bin/git -C "$target" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
            printf 'Not a git worktree; leaving untouched: %s\n' "$target" >&2
            status=1
            continue
          fi
          current_url=$(${pkgs.git}/bin/git -C "$target" remote get-url origin 2>/dev/null || true)
          if [[ "$current_url" != "$clone_url" ]]; then
            printf 'Origin mismatch in %s (expected %s, found %s)\n' "$target" "$clone_url" "$current_url" >&2
            status=1
            continue
          fi
          if ! ${pkgs.git}/bin/git -C "$target" fetch --prune origin; then
            printf 'Fetch failed for %s\n' "$repo" >&2
            status=1
          fi
        elif ! ${pkgs.git}/bin/git clone -- "$clone_url" "$target"; then
          printf 'Clone failed for %s\n' "$repo" >&2
          status=1
        fi
      done < "$repos_file"

      exit "$status"
    '';
  };

  environment.etc."profile.d/remote-machine.sh".text = ''
    export PATH=/etc/remote-machine/bin:$PATH
  '';

  programs.bash.interactiveShellInit = ''
    export PATH=/etc/remote-machine/bin:$PATH
  '';

  system.stateVersion = "26.05";
}
