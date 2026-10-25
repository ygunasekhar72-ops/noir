#!/usr/bin/env bash
# NOIR — one-command Termux/Android install + automated self-test.
# Usage (in Termux):
#   curl -fsSL https://raw.githubusercontent.com/ygunasekhar72-ops/noir/main/install-termux.sh | bash
#
# What it does: installs node+git (if missing), clones or updates ~/noir,
# builds, links the global `noir` command, and runs `noir selftest` to verify
# the installation end to end — zero manual steps, zero tokens spent.
set -euo pipefail

REPO_URL="https://github.com/ygunasekhar72-ops/noir.git"
NOIR_HOME="$HOME/noir"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

if [ ! -d "$PREFIX" ]; then
  echo "This script is meant for Termux on Android."
  echo "On desktop: git clone $REPO_URL ~/noir && cd ~/noir && npm install && npm run build && npm link"
  exit 1
fi

say "1/4 — packages"
pkg update -y || true
pkg install -y nodejs-lts git

say "2/4 — repository"
if [ -d "$NOIR_HOME/.git" ]; then
  echo "already cloned — pulling latest"
  git -C "$NOIR_HOME" pull --ff-only
else
  git clone "$REPO_URL" "$NOIR_HOME"
fi
cd "$NOIR_HOME"

say "3/4 — build"
npm install --no-fund --no-audit
npm run build
npm link

say "4/4 — automated self-test"
noir selftest

say "done — try it:"
echo "  mkdir ~/myproject && cd ~/myproject"
echo "  export OPENAI_API_KEY=sk-...   # or ANTHROPIC_API_KEY / GROQ_API_KEY / GEMINI_API_KEY"
echo "  noir            # terminal UI"
echo "  noir serve      # mobile app: http://127.0.0.1:5178 -> Add to Home screen"
echo "  node ~/noir/examples/noir-pad/install.mjs .   # optional: NoirPad notes app (APPS tab)"
