#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

long_root=$(mktemp -d /tmp/sdlong.XXXXXX)
folders="$long_root/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T"
mkdir -p "$folders"
real=$(mktemp -d /tmp/sdreal.XXXXXX)
ln -s "$real" "$folders/tmp"

failgpg=$(mktemp)
cat > "$failgpg" << 'EOF'
#!/bin/sh
echo "gpg: signing failed: No pinentry" >&2
exit 1
EOF
chmod +x "$failgpg"

gitcfg=$(mktemp)
cat > "$gitcfg" << EOF
[commit]
	gpgsign = true
[tag]
	gpgsign = true
[gpg]
	program = $failgpg
EOF

cleanup() {
  rm -rf "$long_root" "$real" "$failgpg" "$gitcfg"
}
trap cleanup EXIT

export TMPDIR="$folders/tmp"
export GIT_CONFIG_GLOBAL="$gitcfg"
unset GIT_CONFIG_NOSYSTEM || true
unset GIT_CONFIG_SYSTEM || true

npm test
