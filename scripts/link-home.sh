#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
home_root="$repo_root/home"
links_file="$repo_root/scripts/links.txt"
retired_links_file="$repo_root/scripts/retired-links.txt"

if [[ ! -d "$home_root" ]]; then
  printf "Missing repo home directory: %s\n" "$home_root" >&2
  exit 1
fi

if [[ ! -f "$links_file" ]]; then
  printf "Missing links file: %s\n" "$links_file" >&2
  exit 1
fi

backup_root="$repo_root/.link-backups"
backup_dir=""
did_backup=0

backup_path() {
  local rel_path="$1"
  if [[ -z "$backup_dir" ]]; then
    mkdir -p "$backup_root"
    backup_dir=$(mktemp -d "$backup_root/$(date '+%Y%m%d-%H%M%S')-XXXXXX")
  fi
  mkdir -p "$(dirname "$backup_dir/$rel_path")"
  mv "$HOME/$rel_path" "$backup_dir/$rel_path"
  did_backup=1
}

# Never retire real files or links managed by another checkout/tool.
if [[ -f "$retired_links_file" ]]; then
  while IFS= read -r rel_path || [[ -n "$rel_path" ]]; do
    rel_path="${rel_path%%#*}"
    rel_path="${rel_path%"${rel_path##*[![:space:]]}"}"
    rel_path="${rel_path#"${rel_path%%[![:space:]]*}"}"

    if [[ -z "$rel_path" ]]; then
      continue
    fi

    dst="$HOME/$rel_path"
    if [[ -L "$dst" ]] && [[ "$(readlink "$dst")" == "$home_root/$rel_path" ]]; then
      backup_path "$rel_path"
      printf "RETIRED repo link: %s\n" "$dst"
    elif [[ -e "$dst" || -L "$dst" ]]; then
      printf "KEEP unmanaged retired path: %s\n" "$dst"
    fi
  done < "$retired_links_file"
fi

while IFS= read -r rel_path || [[ -n "$rel_path" ]]; do
  rel_path="${rel_path%%#*}"
  rel_path="${rel_path%"${rel_path##*[![:space:]]}"}"
  rel_path="${rel_path#"${rel_path%%[![:space:]]*}"}"

  if [[ -z "$rel_path" ]]; then
    continue
  fi

  src="$home_root/$rel_path"
  dst="$HOME/$rel_path"

  if [[ ! -e "$src" ]]; then
    printf "SKIP missing source: %s\n" "$src"
    continue
  fi

  dst_parent=$(dirname "$dst")
  mkdir -p "$dst_parent"

  if [[ -L "$dst" ]]; then
    current_target=$(readlink "$dst")
    if [[ "$current_target" == "$src" ]]; then
      printf "OK already linked: %s -> %s\n" "$dst" "$src"
      continue
    fi
    backup_path "$rel_path"
    printf "BACKUP symlink: %s\n" "$dst"
  elif [[ -e "$dst" ]]; then
    backup_path "$rel_path"
    printf "BACKUP existing: %s\n" "$dst"
  fi

  ln -s "$src" "$dst"
  printf "LINK %s -> %s\n" "$dst" "$src"
done < "$links_file"

if [[ "$did_backup" -eq 1 ]]; then
  printf "Backups stored in: %s\n" "$backup_dir"
fi
