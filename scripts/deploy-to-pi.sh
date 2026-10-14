#!/usr/bin/env bash
# Copy this project from the Mac to the Pi over SSH, then run the installer there.
#   scripts/deploy-to-pi.sh pi@homehub.local            copy + full install
#   scripts/deploy-to-pi.sh pi@homehub.local --update   copy + redeploy only
# (A USB stick works too: copy the folder, then run ./install.sh on the Pi.)
set -euo pipefail
TARGET="${1:?usage: deploy-to-pi.sh user@host [install.sh options]}"
shift
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
rsync -av --delete --exclude '.DS_Store' --exclude '._*' --exclude 'node_modules/' --exclude '.git/' --exclude 'hardware/' --exclude 'docs/' \
	"$REPO_DIR/" "$TARGET:MagicMirrorCode/"
ssh -t "$TARGET" "cd ~/MagicMirrorCode && ./install.sh $*"
