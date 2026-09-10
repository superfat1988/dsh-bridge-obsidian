#!/usr/bin/env bash
# ==================== dsh-bridge-obsidian DSH-side setup ====================
# Registers the bridge plugin into the dsh `web` profile (idempotent):
#   1. build packages/bridge-obsidian (pnpm install + tsdown)
#   2. add link: dependency + bundle entry into ~/.dsh/profiles/web/package.json
#   3. pnpm install inside the profile
#   4. print the restart command and the token file path
#
# Usage:  bash scripts/setup-dsh.sh
# Env:    DSH_PROFILE_DIR  (default ~/.dsh/profiles/web)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRIDGE_PKG="$REPO_ROOT/packages/bridge-obsidian"
DSH_PROFILE_DIR="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}"
PKG_NAME="@yuxianglin/dsh-bridge-obsidian"

step() { printf '\n== %s ==\n' "$1"; }
fail() { printf '[FAIL] %s\n' "$1" >&2; exit 1; }

step "1/5 checking prerequisites"
command -v dsh >/dev/null 2>&1 || fail "dsh not found on PATH — install DeepSeek Harness first"
command -v pnpm >/dev/null 2>&1 || fail "pnpm not found on PATH — npm install -g pnpm"
[ -d "$DSH_PROFILE_DIR" ] || fail "profile dir not found: $DSH_PROFILE_DIR"
echo "dsh:   $(command -v dsh)"
echo "pnpm:  $(command -v pnpm)"
echo "profile: $DSH_PROFILE_DIR"

step "2/5 building bridge plugin"
cd "$BRIDGE_PKG"
pnpm install
pnpm run build
[ -f lib/index.js ] || fail "build did not produce lib/index.js"
echo "built: $BRIDGE_PKG/lib/index.js"

step "3/5 registering into web profile"
node - "$DSH_PROFILE_DIR/package.json" "$BRIDGE_PKG" "$PKG_NAME" <<'NODE'
const fs = require('fs')
const [, pkgPath, bridgePath, name] = process.argv
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
pkg.dependencies = pkg.dependencies || {}
pkg.dependencies[name] = `link:${bridgePath}`
const bundles = pkg.dsh = pkg.dsh || {}
bundles.profile = bundles.profile || {}
const list = bundles.profile.bundles = bundles.profile.bundles || []
if (!list.includes(name)) list.push(name)
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
console.log(`registered: ${name} -> link:${bridgePath} (bundle #${list.length})`)
NODE

step "4/5 installing profile dependencies"
cd "$DSH_PROFILE_DIR"
pnpm install

step "5/5 done"
cat <<EOF

Next steps:
  1. Restart the web service (adjust to your unit name):
       systemctl --user restart dsh-web.service
  2. Verify the bridge:
       curl http://127.0.0.1:3080/obsidian/bridge-config
     -> should return {"wsUrl":"ws://.../obsidian/bridge"}
  3. The bearer token auto-generates on first boot at:
       ~/.dsh/obsidian-bridge-token
     Paste it into the Obsidian plugin settings (see README §2).
  4. To pin a fixed token instead: set DSH_OBSIDIAN_TOKEN and restart.
EOF
