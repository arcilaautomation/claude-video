#!/usr/bin/env bash
# build-skill.sh — package the make-video skill as a claude.ai-upload-ready .skill file.
# Usage: bash skills/make-video/scripts/build-skill.sh   (run from anywhere)
#
# Produces dist/make-video.skill, a zip with a single top-level `make-video/` directory
# containing SKILL.md plus references/, runtime/, templates/ and scripts/ from
# skills/make-video. Archiving the subtree directly keeps the bundle to exactly
# one SKILL.md and well under claude.ai's 200-file cap.
#
# Note: the skill needs Node 18+, ffmpeg and a Chromium it can launch, so it
# only runs where the code-execution sandbox provides those.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO_ROOT"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "error: working tree is dirty; commit or stash before building" >&2
  exit 1
fi

mkdir -p dist
OUT="dist/make-video.skill"
git archive --format=zip --prefix=make-video/ --output="$OUT" HEAD:skills/make-video

COUNT=$(unzip -l "$OUT" | tail -1 | awk '{print $2}')
SIZE=$(du -h "$OUT" | cut -f1)

if [ "$COUNT" -gt 200 ]; then
  echo "error: $COUNT files in zip, claude.ai's cap is 200" >&2
  echo "       trim the skills/make-video/ tree or add a .gitattributes export-ignore entry" >&2
  exit 1
fi

SKILL_MD_COUNT=$(unzip -l "$OUT" | grep -c "SKILL.md" || true)
if [ "$SKILL_MD_COUNT" -ne 1 ]; then
  echo "error: expected exactly one SKILL.md, found $SKILL_MD_COUNT" >&2
  exit 1
fi

echo "built $OUT ($COUNT files, $SIZE)"
echo "upload via the claude.ai skill UI"
