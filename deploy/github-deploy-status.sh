#!/usr/bin/env bash
# Marks the GitHub copy of a commit as deployed: a status named "deploy/production" (green check on success, red
# cross on failure) with the pipeline number and time. Run by the jobs github_status_deployed / github_status_failed
# in .gitlab-ci.yml right after the production deploy job finished.
#
# The mirror rewrites commit ids, so the GitHub commit is found by its title among the newest 100 commits of the
# public repository. A commit that is not on GitHub (documentation-only commits are never mirrored) is skipped.
# Needs GITHUB_MIRROR_TOKEN (masked CI variable) with permission to write commit statuses on GITHUB_MIRROR_REPO.
set -euo pipefail

STATE="${1:?usage: github-deploy-status.sh success|failure}"
REPO="${GITHUB_MIRROR_REPO:-lsegroup/mnemosyne}"
TITLE="${CI_COMMIT_TITLE:?CI_COMMIT_TITLE missing (run inside GitLab CI)}"
: "${GITHUB_MIRROR_TOKEN:?GITHUB_MIRROR_TOKEN missing}"

AUTH=(-H "Authorization: Bearer ${GITHUB_MIRROR_TOKEN}" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28")

LIST="$(curl -sS "${AUTH[@]}" "https://api.github.com/repos/${REPO}/commits?per_page=100")"
SHA="$(TITLE="$TITLE" python3 -c '
import json, os, sys
title = os.environ["TITLE"]
data = json.loads(sys.stdin.read() or "[]")
if isinstance(data, list):
    for c in data:
        if c["commit"]["message"].split("\n")[0] == title:
            print(c["sha"])
            break
' <<<"$LIST")"

if [ -z "$SHA" ]; then
  echo "Commit not on GitHub (documentation-only or not mirrored yet): ${TITLE}"
  exit 0
fi

if [ "$STATE" = "success" ]; then
  DESC="Deployed to production - pipeline #${CI_PIPELINE_ID} at $(date -u '+%Y-%m-%d %H:%M') UTC"
else
  DESC="Production deploy FAILED - pipeline #${CI_PIPELINE_ID} at $(date -u '+%Y-%m-%d %H:%M') UTC"
  STATE="failure"
fi

BODY="$(STATE="$STATE" DESC="$DESC" URL="${CI_PIPELINE_URL:-}" python3 -c '
import json, os
print(json.dumps({"state": os.environ["STATE"], "context": "deploy/production", "description": os.environ["DESC"][:140], "target_url": os.environ["URL"]}))')"

CODE="$(curl -sS -o /tmp/gh-status.out -w '%{http_code}' -X POST "${AUTH[@]}" -d "$BODY" "https://api.github.com/repos/${REPO}/statuses/${SHA}")"
if [ "$CODE" = "201" ]; then
  echo "GitHub ${SHA:0:7}: deploy/production = ${STATE} (${DESC})"
else
  echo "GitHub refused the status (HTTP ${CODE}). The mirror token needs permission to write commit statuses on ${REPO}:" >&2
  python3 -c 'import json,sys; print(json.load(open("/tmp/gh-status.out")).get("message",""))' >&2 || true
  exit 1
fi
