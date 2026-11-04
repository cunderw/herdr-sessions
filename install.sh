#!/usr/bin/env bash
# Copies the mod into Herdr's home. A symlinked mod folder loads its JavaScript but
# not its icons, so this copies instead; run it again after pulling.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
dest=${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods/sessions
mkdir -p "$dest"
rm -f "$dest"/*.js "$dest"/*.svg
cp "$here"/mods/sessions/*.js "$here"/mods/sessions/*.svg "$here"/mods/sessions/mod.json "$dest"/
herdr-app check "$dest"
