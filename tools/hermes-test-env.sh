#!/bin/sh
# Throwaway venv with the packages Hermes v0.22.6 needs so the Mac profile
# test can import its toolset and plugin loader. Prints that venv's python path.
# Scratch stays outside the home directory. Pins come from that commit's pyproject.
set -eu

scratch="${TESS_HERMES_SCRATCH:-/tmp/tess-hermes-test}"
home="${HOME:-}"
case "$scratch" in
  "$home"|"$home"/*)
    echo "hermes-test-env: scratch is inside the home directory" >&2
    exit 1
    ;;
esac

src="${HERMES_AGENT_SRC:-/tmp/hermes-agent}"
case "$src" in
  "$home"|"$home"/*)
    echo "hermes-test-env: Hermes source is inside the home directory" >&2
    exit 1
    ;;
esac

pin=f0d94882e89ab8d4098b5bb2f166adfb9ee0a0ab
if [ ! -d "$src/.git" ]; then
  git clone https://github.com/NousResearch/hermes-agent "$src"
fi
current=$(git -C "$src" rev-parse HEAD)
if [ "$current" != "$pin" ]; then
  git -C "$src" fetch origin "$pin"
  git -C "$src" checkout "$pin"
fi

venv="$scratch/venv"
stamp="$venv/.tess-hermes-pin"
if [ ! -x "$venv/bin/python" ] || [ "$(cat "$stamp" 2>/dev/null || true)" != "$pin" ]; then
  python3 -m venv "$venv"
  req="$scratch/requirements.txt"
  "$venv/bin/python" - "$src/pyproject.toml" "$req" <<'PY'
import sys
import tomllib
from pathlib import Path

data = tomllib.loads(Path(sys.argv[1]).read_text())
lines = []
for dep in data["project"]["dependencies"]:
    lines.append(" ".join(dep.split()))
Path(sys.argv[2]).write_text("\n".join(lines) + "\n")
PY
  # browser-harness pins Pillow 12.3.0. Hermes overrides that to Pillow 13.0.0
  # in [tool.uv] override-dependencies, which pip does not read. Install the
  # harness without its dependency pin so the pyproject pin wins.
  core="$scratch/requirements-core.txt"
  grep -v '^browser-harness' "$req" > "$core"
  "$venv/bin/python" -m pip install --disable-pip-version-check -r "$core"
  harness=$(grep '^browser-harness' "$req" || true)
  if [ -n "$harness" ]; then
    "$venv/bin/python" -m pip install --disable-pip-version-check --no-deps "$harness"
  fi
  printf '%s\n' "$pin" > "$stamp"
fi

printf '%s\n' "$venv/bin/python"
