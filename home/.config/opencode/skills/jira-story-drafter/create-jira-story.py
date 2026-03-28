#!/usr/bin/env python3
"""Create a Jira Story ticket via the REST API.

This script bypasses the jira CLI, which runs a markdown-to-wiki converter
that corrupts Jira wiki markup (bold markers, brace escapes, bullet prefixes).

Usage:
    python3 create-jira-story.py \
        --server https://jira.example.com \
        --project PROJ \
        --summary "Story title" \
        --body-file /path/to/description.txt

    Optionally add:
        --fix-version "1.0"
        --label bug --label urgent
        --priority High

Environment:
    JIRA_API_TOKEN  Bearer token (PAT) for authentication (required).
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.error


def main():
    parser = argparse.ArgumentParser(description="Create a Jira Story via REST API.")
    parser.add_argument("--server", required=True, help="Jira server URL (e.g. https://jira.example.com)")
    parser.add_argument("--project", required=True, help="Jira project key (e.g. PROJ)")
    parser.add_argument("--summary", required=True, help="Issue summary / title")
    parser.add_argument("--body-file", required=True, help="Path to file containing the description in Jira wiki markup")
    parser.add_argument("--fix-version", action="append", default=[], help="Fix version (repeatable)")
    parser.add_argument("--label", action="append", default=[], help="Label (repeatable)")
    parser.add_argument("--priority", default=None, help="Priority name (e.g. High)")
    args = parser.parse_args()

    token = os.environ.get("JIRA_API_TOKEN")
    if not token:
        print("Error: JIRA_API_TOKEN environment variable is not set.", file=sys.stderr)
        sys.exit(1)

    with open(args.body_file) as f:
        description = f.read()

    fields = {
        "project": {"key": args.project},
        "issuetype": {"name": "Story"},
        "summary": args.summary,
        "description": description,
    }

    if args.fix_version:
        fields["fixVersions"] = [{"name": v} for v in args.fix_version]
    if args.label:
        fields["labels"] = args.label
    if args.priority:
        fields["priority"] = {"name": args.priority}

    server = args.server.rstrip("/")
    payload = json.dumps({"fields": fields})

    req = urllib.request.Request(
        f"{server}/rest/api/2/issue",
        data=payload.encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        resp = urllib.request.urlopen(req)
        result = json.loads(resp.read())
        key = result["key"]
        print(f"Created: {key}")
        print(f"{server}/browse/{key}")
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"Error {e.code}: {body}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
