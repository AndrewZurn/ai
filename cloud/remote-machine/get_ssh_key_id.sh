#!/usr/bin/env bash
set -euo pipefail

: "${HCLOUD_TOKEN:?Set HCLOUD_TOKEN to your Hetzner project API token}"

curl -sS \
  -H "Authorization: Bearer $HCLOUD_TOKEN" \
  https://api.hetzner.cloud/v1/ssh_keys \
| python3 -c '
import json, sys
response = json.load(sys.stdin)
if "error" in response:
    raise SystemExit("Hetzner API error: " + response["error"].get("message", str(response["error"])))
for key in response.get("ssh_keys", []):
    print("{}\t{}\t{}".format(key["id"], key["name"], key["fingerprint"]))
'
