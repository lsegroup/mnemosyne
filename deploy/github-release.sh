#!/usr/bin/env bash
# Publishes the GitHub release of a version tag. Run by the job `release_github` in .gitlab-ci.yml when a tag like v0.6.0 is pushed.
#
# The mirror rewrites commit ids (deploy/mirror-to-github.sh), so the release is attached to the GitHub copy of the tagged commit,
# found by its title among the newest 100 commits of the public repository; GitHub creates the tag there. The text of the release
# is the section of CHANGELOG.md for that version. It is scanned like the mirror is: nothing is published when it holds an internal
# address or a credential. A release that already exists is left as it is.
# Needs GITHUB_MIRROR_TOKEN (masked CI variable) with permission to write contents on GITHUB_MIRROR_REPO.
set -euo pipefail

TAG="${CI_COMMIT_TAG:?run inside GitLab CI on a tag pipeline}"
VERSION="${TAG#v}"
REPO="${GITHUB_MIRROR_REPO:-lsegroup/mnemosyne}"
: "${GITHUB_MIRROR_TOKEN:?GITHUB_MIRROR_TOKEN missing}"
TITLE="$(git log -1 --format=%s "${CI_COMMIT_SHA:-HEAD}")"

AUTH=(-H "Authorization: Bearer ${GITHUB_MIRROR_TOKEN}" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28")

CODE="$(curl -sS -o /dev/null -w '%{http_code}' "${AUTH[@]}" "https://api.github.com/repos/${REPO}/releases/tags/${TAG}")"
if [ "$CODE" = "200" ]; then echo "GitHub already has the release ${TAG}: left as it is"; exit 0; fi

BODY="$(VERSION="$VERSION" TITLE="$TITLE" LIST="$(curl -sS "${AUTH[@]}" "https://api.github.com/repos/${REPO}/commits?per_page=100")" python3 - <<'PY'
import json, os, re, sys
version, title = os.environ["VERSION"], os.environ["TITLE"]
sha = ""
data = json.loads(os.environ["LIST"] or "[]")
if isinstance(data, list):
    for c in data:
        if c["commit"]["message"].split("\n")[0] == title:
            sha = c["sha"]
            break
if not sha:
    sys.exit("the tagged commit is not on GitHub yet (title: %s): wait for the mirror job and run this job again" % title)
text = open("CHANGELOG.md", encoding="utf8").read()
m = re.search(r"^## %s\b.*\n(.*?)(?=^## |\Z)" % re.escape(version), text, re.S | re.M)
if not m:
    sys.exit("CHANGELOG.md has no section for version %s" % version)
notes = m.group(1).strip()
pattern = r"(^|[^0-9.])(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)([^0-9]|$)|glpat-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|BEGIN [A-Z ]*PRIVATE KEY|hvs\.[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}"
if re.search(pattern, notes):
    sys.exit("the release text matched the safety scan (internal address or credential): nothing is published")
print(json.dumps({"tag_name": "v" + version, "target_commitish": sha, "name": "Mnemosyne " + version, "body": notes, "draft": False, "prerelease": False, "make_latest": "true"}))
PY
)"

OUT="$(mktemp)"
CODE="$(curl -sS -o "$OUT" -w '%{http_code}' -X POST "${AUTH[@]}" -d "$BODY" "https://api.github.com/repos/${REPO}/releases")"
if [ "$CODE" = "201" ]; then
  echo "GitHub release created: $(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["html_url"])' "$OUT")"
else
  echo "GitHub refused the release (HTTP ${CODE}). The mirror token needs permission to write contents on ${REPO}:" >&2
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("message",""))' "$OUT" >&2 || true
  exit 1
fi
