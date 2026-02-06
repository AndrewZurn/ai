#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
home_root="$repo_root/home"
links_file="$repo_root/scripts/links.txt"

if [[ ! -d "$home_root" ]]; then
  printf "Missing repo home directory: %s\n" "$home_root" >&2
  exit 1
fi

if [[ ! -f "$links_file" ]]; then
  printf "Missing links file: %s\n" "$links_file" >&2
  exit 1
fi

status=0

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
    printf "MISSING source: %s\n" "$src"
    status=1
    continue
  fi

  if [[ ! -L "$dst" ]]; then
    if [[ -e "$dst" ]]; then
      printf "NOT LINKED: %s (exists, not symlink)\n" "$dst"
    else
      printf "MISSING link: %s\n" "$dst"
    fi
    status=1
    continue
  fi

  current_target=$(readlink "$dst")
  if [[ "$current_target" != "$src" ]]; then
    printf "WRONG TARGET: %s -> %s (expected %s)\n" "$dst" "$current_target" "$src"
    status=1
    continue
  fi

  printf "OK %s -> %s\n" "$dst" "$src"
done < "$links_file"

exit "$status"
