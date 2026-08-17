#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_dir/package/ego-browser"
install_dir="$repo_dir/.local/bin"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "install-linux.sh supports Linux only" >&2
  exit 1
fi

cd "$package_dir"
npm ci --ignore-scripts
npm run build
mkdir -p "$install_dir"
ln -sfn "$package_dir/dist/out/index.js" "$install_dir/ego-browser"
chmod +x "$package_dir/dist/out/index.js"
echo "Installed $install_dir/ego-browser"
echo "Add to PATH: export PATH=\"$install_dir:\$PATH\""
