#!/usr/bin/env bash
set -euo pipefail

platform=${1:?Usage: bash scripts/verify-distribution.sh PLATFORM}
case "$platform" in
  linux-x64) asset_platform=linux-amd64 ;;
	linux-arm64) asset_platform=linux-arm64 ;;
  darwin-arm64) asset_platform=darwin-arm64 ;;
  *) echo 'Unsupported distribution platform' >&2; exit 2 ;;
esac
source_bin=".crust/$platform/bin"
output=.crust/distribution
mkdir -p "$output"
cp "$source_bin/gh-local-repo-cleaner-bun-$platform" "$output/gh-local-repo-cleaner-$asset_platform"

sandbox=$(mktemp -d)
sandbox=$(cd "$sandbox" && pwd -P)
trap 'rm -rf "$sandbox"' EXIT
export HOME="$sandbox/home" XDG_CONFIG_HOME="$sandbox/config" XDG_DATA_HOME="$sandbox/data" XDG_CACHE_HOME="$sandbox/cache" GH_CONFIG_DIR="$sandbox/gh-config"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG_COUNT GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN
# Only local installation is used. The placeholder bypasses gh's login gate;
# no real GitHub credential or public remote is consulted.
export GH_TOKEN=local-smoke-test GH_HOST=github.com
mkdir -p "$HOME" "$sandbox/gh-local-repo-cleaner" "$sandbox/minimal-bin" "$sandbox/repositories/repo"
cp -R "$source_bin/." "$sandbox/gh-local-repo-cleaner/"
mv "$sandbox/gh-local-repo-cleaner/gh-local-repo-cleaner-bun-$platform" "$sandbox/gh-local-repo-cleaner/gh-local-repo-cleaner"
git -C "$sandbox/gh-local-repo-cleaner" init -q
git -C "$sandbox/repositories/repo" init -q -b main
git -C "$sandbox/repositories/repo" config user.name 'Distribution Test'
git -C "$sandbox/repositories/repo" config user.email test@example.invalid
git -C "$sandbox/repositories/repo" config commit.gpgsign false
echo preserved > "$sandbox/repositories/repo/tracked"
git -C "$sandbox/repositories/repo" add .
git -C "$sandbox/repositories/repo" commit -qm initial
git init -q --bare "$sandbox/remote"
git -C "$sandbox/repositories/repo" remote add origin "$sandbox/remote"
git -C "$sandbox/repositories/repo" push -qu origin main
gh_path=$(command -v gh)
git_path=$(command -v git)
ln -s "$gh_path" "$sandbox/minimal-bin/gh"
ln -s "$git_path" "$sandbox/minimal-bin/git"
(cd "$sandbox/gh-local-repo-cleaner" && env PATH="$sandbox/minimal-bin" "$gh_path" extension install .)
env PATH="$sandbox/minimal-bin" "$gh_path" local-repo-cleaner --help
env PATH="$sandbox/minimal-bin" "$gh_path" local-repo-cleaner scan "$sandbox/repositories" --json > "$sandbox/scan.json"
grep -q '"status":"SAFE"' "$sandbox/scan.json"
env PATH="$sandbox/minimal-bin" "$gh_path" local-repo-cleaner trash list --state-dir "$sandbox/absent-state"
test ! -e "$sandbox/absent-state"
tar -czf "$output/gh-local-repo-cleaner-$asset_platform.tar.gz" -C "$sandbox/gh-local-repo-cleaner" --exclude=.git .
(cd "$output" && shasum -a 256 "gh-local-repo-cleaner-$asset_platform" "gh-local-repo-cleaner-$asset_platform.tar.gz" > SHA256SUMS)
