#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
home_root="$repo_root/home"
links_file="$repo_root/scripts/links.txt"

usage() {
  printf "Usage: %s <source_path> <target_rel_path>\n" "${0##*/}"
  printf "Example: %s ~/my-config .config/opencode\n" "${0##*/}"
  printf "Example: %s ~/.gemini/skills .gemini\n" "${0##*/}"
  printf "If the target path does not end with the source basename,\n"
  printf "the source basename is appended automatically.\n"
}

src_dir="${1:-}"
target_rel="${2:-}"

if [[ -z "$src_dir" || -z "$target_rel" ]]; then
  usage
  exit 1
fi

if [[ ! -e "$src_dir" ]]; then
  printf "Source path does not exist: %s\n" "$src_dir" >&2
  exit 1
fi

target_rel="${target_rel%/}"
if [[ -z "$target_rel" || "$target_rel" == /* || "$target_rel" == *".."* ]]; then
  printf "Target must be a relative path under home/: %s\n" "$target_rel" >&2
  exit 1
fi

if [[ ! -d "$home_root" ]]; then
  printf "Missing repo home directory: %s\n" "$home_root" >&2
  exit 1
fi

if [[ ! -f "$links_file" ]]; then
  printf "Missing links file: %s\n" "$links_file" >&2
  exit 1
fi

src_dir_trim="${src_dir%/}"
src_base=$(basename "$src_dir_trim")
target_base=$(basename "$target_rel")

if [[ "$src_base" == "$target_base" ]]; then
  link_rel="$target_rel"
else
  link_rel="$target_rel/$src_base"
fi

dst="$home_root/$link_rel"

if [[ -e "$dst" ]]; then
  printf "Destination already exists: %s\n" "$dst" >&2
  exit 1
fi

if [[ -d "$src_dir" ]]; then
  mkdir -p "$dst"
  cp -R -p "$src_dir"/. "$dst/"
else
  dst_parent=$(dirname "$dst")
  mkdir -p "$dst_parent"
  cp -p "$src_dir" "$dst"
fi

link_exists=0
while IFS= read -r rel_path || [[ -n "$rel_path" ]]; do
  rel_path="${rel_path%%#*}"
  rel_path="${rel_path%"${rel_path##*[![:space:]]}"}"
  rel_path="${rel_path#"${rel_path%%[![:space:]]*}"}"
  if [[ -z "$rel_path" ]]; then
    continue
  fi
  if [[ "$rel_path" == "$link_rel" ]]; then
    link_exists=1
    break
  fi
done < "$links_file"

if [[ "$link_exists" -eq 0 ]]; then
  printf "%s\n" "$link_rel" >> "$links_file"
  printf "Added to links: %s\n" "$link_rel"
else
  printf "Link already listed: %s\n" "$link_rel"
fi

printf "Imported %s into %s\n" "$src_dir" "$dst"
