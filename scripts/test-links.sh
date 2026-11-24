#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
test_root=$(mktemp -d "${TMPDIR:-/tmp}/opencode-links-XXXXXX")
test_root=$(cd "$test_root" && pwd)
trap 'rm -rf "$test_root"' EXIT

assert_equal() {
  if [[ "$1" != "$2" ]]; then
    printf 'FAIL expected <%s>, got <%s>\n' "$2" "$1" >&2
    exit 1
  fi
}

fixture_root="$test_root/repo"
export HOME="$test_root/home"
mkdir -p "$fixture_root/scripts" "$fixture_root/home/.config/opencode" \
  "$fixture_root/home/.codex" "$HOME/.config/opencode" "$HOME/.codex"
cp "$repo_root/scripts/link-home.sh" "$repo_root/scripts/check-links.sh" \
  "$fixture_root/scripts/"

cat > "$fixture_root/scripts/links.txt" <<'EOF'
# Same basenames must be backed up separately.
.config/opencode/AGENTS.md
.codex/AGENTS.md
.config/opencode/opencode.jsonc
EOF
cat > "$fixture_root/scripts/retired-links.txt" <<'EOF'
  .config/opencode/agent  # A broken link still belongs to this checkout.
.config/opencode-v2
.local/bin/opencode2-v2
EOF

printf 'managed instructions\n' > "$fixture_root/home/.config/opencode/AGENTS.md"
printf 'managed codex instructions\n' > "$fixture_root/home/.codex/AGENTS.md"
printf '{}\n' > "$fixture_root/home/.config/opencode/opencode.jsonc"
printf 'local instructions\n' > "$HOME/.config/opencode/AGENTS.md"
printf 'local codex instructions\n' > "$HOME/.codex/AGENTS.md"

ln -s "$fixture_root/home/.config/opencode/agent" "$HOME/.config/opencode/agent"
ln -s "$test_root/another-checkout" "$HOME/.config/opencode-v2"
mkdir -p "$HOME/.local/bin"
printf 'unmanaged wrapper\n' > "$HOME/.local/bin/opencode2-v2"

bash "$fixture_root/scripts/link-home.sh"
bash "$fixture_root/scripts/check-links.sh"
if [[ -L "$HOME/.config/opencode/agent" ]]; then
  printf 'FAIL repository-owned retired link was not removed\n' >&2
  exit 1
fi
assert_equal "$(readlink "$HOME/.config/opencode-v2")" "$test_root/another-checkout"
assert_equal "$(cat "$HOME/.local/bin/opencode2-v2")" "unmanaged wrapper"

backup_count=0
for backup_dir in "$fixture_root"/.link-backups/*; do
  backup_count=$((backup_count + 1))
  assert_equal "$(cat "$backup_dir/.config/opencode/AGENTS.md")" "local instructions"
  assert_equal "$(cat "$backup_dir/.codex/AGENTS.md")" "local codex instructions"
  assert_equal "$(readlink "$backup_dir/.config/opencode/agent")" \
    "$fixture_root/home/.config/opencode/agent"
done
assert_equal "$backup_count" "1"

# Re-running must not create another backup or replace unmanaged retired paths.
bash "$fixture_root/scripts/link-home.sh"
bash "$fixture_root/scripts/check-links.sh"
backup_count=0
for backup_dir in "$fixture_root"/.link-backups/*; do
  backup_count=$((backup_count + 1))
done
assert_equal "$backup_count" "1"
assert_equal "$(readlink "$HOME/.config/opencode-v2")" "$test_root/another-checkout"
assert_equal "$(cat "$HOME/.local/bin/opencode2-v2")" "unmanaged wrapper"

printf 'PASS link migration, backups, ownership checks, and idempotency\n'
