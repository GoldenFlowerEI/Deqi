#!/usr/bin/env bash
# Install deqi (Golden Flower Emergent Intelligence) from a local clone.
#
# Usage:
#   ./install.sh              # install to ~/.local/bin
#   ./install.sh /usr/local   # install to a custom prefix
#
# After install, ensure $PREFIX/bin is on your PATH and that Deqi_HOME
# points to the project root, then open a NEW shell so the env takes
# effect. Then:
#   deqi --version
#   deqi --list-models
#   deqi

set -euo pipefail

PREFIX="${1:-$HOME/.local}"
PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "deqi installer"
echo "  project: $PROJECT_ROOT"
echo "  prefix:  $PREFIX"
echo "  bun:     $(command -v bun || echo MISSING)"
echo "  node:    $(node --version 2>/dev/null || echo MISSING)"

# Pre-flight.
command -v bun >/dev/null 2>&1 || { echo "ERROR: bun is required. Install from https://bun.sh"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "ERROR: node is required."; exit 1; }

# Build.
echo "-> bun install"
bun install >/dev/null
echo "-> bun run build"
bun run build >/dev/null

# Install.
mkdir -p "$PREFIX/bin"
cp bin/deqi.js "$PREFIX/bin/deqi.js"
cp bin/deqi "$PREFIX/bin/deqi"
chmod +x "$PREFIX/bin/deqi" "$PREFIX/bin/deqi.js"

# Persist Deqi_HOME in the user's shell rc.
SHELL_RC=""
case "${SHELL:-}" in
  *zsh)  SHELL_RC="$HOME/.zshrc" ;;
  *bash) SHELL_RC="$HOME/.bashrc" ;;
  *)     SHELL_RC="$HOME/.profile" ;;
esac
if [ -n "$SHELL_RC" ]; then
  if ! grep -q "Deqi_HOME" "$SHELL_RC" 2>/dev/null; then
    printf '\n# deqi location\nexport Deqi_HOME=%q\n' "$PROJECT_ROOT" >> "$SHELL_RC"
    echo "  appended Deqi_HOME to $SHELL_RC"
  else
    echo "  Deqi_HOME already in $SHELL_RC"
  fi
fi

# PATH check (best-effort).
case ":$PATH:" in
  *":$PREFIX/bin:"*) echo "  $PREFIX/bin already on PATH" ;;
  *) echo "  add $PREFIX/bin to your PATH if not already there" ;;
esac

echo
echo "Installed: $PREFIX/bin/deqi"
echo
echo "Open a NEW shell so PATH + Deqi_HOME take effect, then:"
echo "  deqi --version"
echo "  deqi --list-models"
echo "  deqi"
