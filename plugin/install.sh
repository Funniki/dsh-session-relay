#!/bin/sh
# Install dsh-session-relay into one DSH profile — POSIX counterpart of install.ps1.
#
# The plugin ships as a single self-contained package: the bundle row and the browser
# half live in the same package, so one `dsh plugin add` is the whole install.
#
# Usage:
#   sh install.sh                        # profile "desktop", this folder
#   DSH_PROFILE=web sh install.sh        # another profile
#   DSH_VERSION=0.4.1 sh install.sh      # pin the version (needed right after a release:
#                                        # pnpm holds back versions newer than its
#                                        # minimumReleaseAge window)
#   DSH_FROM_REGISTRY=1 sh install.sh    # install the published package, not this folder
#   DSH_BIN=/path/to/dsh sh install.sh
set -eu

PROFILE="${DSH_PROFILE:-desktop}"
PACK="dsh-session-relay"

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ -n "${DSH_BIN:-}" ]; then
	dsh="$DSH_BIN"
elif command -v dsh >/dev/null 2>&1; then
	dsh=$(command -v dsh)
else
	printf 'error: the dsh CLI was not found on PATH.\n' >&2
	printf 'Install DeepSeek Harness, or run this script with DSH_BIN=/path/to/dsh.\n' >&2
	exit 1
fi

add() {
	printf 'Adding %s\n' "$1"
	"$dsh" plugin --profile "$PROFILE" add "$1"
}

registry_spec() {
	if [ -n "${DSH_VERSION:-}" ]; then printf '%s@%s' "$1" "$DSH_VERSION"; else printf '%s' "$1"; fi
}

# This folder when it is the extracted zip, the registry otherwise.
if [ -z "${DSH_FROM_REGISTRY:-}" ] && [ -f "$script_dir/cordis.patch.yml" ] && [ -f "$script_dir/package.json" ]; then
	add "$script_dir"
else
	add "$(registry_spec "$PACK")"
fi

dsh_home="${DSH_HOME:-$HOME/.dsh}"
profile_dir="$dsh_home/profiles/$PROFILE"
manifest="$profile_dir/package.json"
installed="$profile_dir/node_modules/$PACK/package.json"

if [ ! -f "$manifest" ]; then
	printf 'error: profile "%s" has no package.json (%s)\n' "$PROFILE" "$profile_dir" >&2
	exit 1
fi
if [ ! -f "$installed" ]; then
	printf 'error: %s is not resolvable from the profile root.\n' "$PACK" >&2
	exit 1
fi

# The bundle row is what makes the plugin load; a plain dependency would sit inert.
if ! grep -q "$PACK" "$manifest"; then
	printf 'error: the profile did not record %s as a bundle.\n' "$PACK" >&2
	exit 1
fi

version=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$installed" | head -1)
printf '\nInstalled %s@%s into profile "%s".\n' "$PACK" "$version" "$PROFILE"
printf 'Restart DSH, or disable and re-enable the bundle in Plugins if it is already running.\n'
