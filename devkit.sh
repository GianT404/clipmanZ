#!/usr/bin/env bash
set -euo pipefail

UUID="clipboard-history@clipmanz"
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

for tool in gnome-shell dbus-run-session; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'Missing prerequisite: %s\n' "$tool" >&2
    exit 1
  fi
done

if ! gnome-shell --help | grep -q -- '--devkit'; then
  printf 'This GNOME Shell build does not support --devkit.\n' >&2
  exit 1
fi

if [[ ! -x /usr/lib/mutter-devkit ]]; then
  printf 'Mutter Devkit is not installed. On Arch Linux, install it with:\n' >&2
  printf '  sudo pacman -S mutter-devkit\n' >&2
  exit 1
fi

"$ROOT/install.sh"
printf 'Starting an isolated GNOME Shell Devkit session. Close its window and run this script again after code changes.\n'
printf 'This is a separate test desktop; it does not reload your main session.\n'

TEST_CONFIG="$(mktemp -d "${TMPDIR:-/tmp}/clipmanz-devkit.XXXXXX")"
cleanup_config() {
  if [[ -d "$TEST_CONFIG" ]]; then
    rm -r -- "$TEST_CONFIG"
  fi
}
trap cleanup_config EXIT
mkdir -p "$TEST_CONFIG/config"
export XDG_CONFIG_HOME="$TEST_CONFIG/config"
export DCONF_PROFILE="$ROOT/devkit/dconf-profile"

dbus-run-session -- bash -c '
  set -euo pipefail
  UUID="$1"
  gsettings set org.gnome.shell enabled-extensions "['\''$UUID'\'']"
  gnome-shell --devkit --wayland &
  shell_pid=$!
  cleanup() {
    kill "$shell_pid" 2>/dev/null || true
    wait "$shell_pid" 2>/dev/null || true
  }
  trap cleanup EXIT INT TERM

  ready=false
  for _ in {1..30}; do
    if gnome-extensions info "$UUID" >/dev/null 2>&1; then
      ready=true
      break
    fi
    sleep 1
  done
  if [[ "$ready" != true ]]; then
    printf "Devkit Shell did not expose its extension service.\n" >&2
    exit 1
  fi

  gnome-extensions enable "$UUID"
  gnome-extensions info "$UUID"
  gdbus call --session --dest org.gnome.Shell.Extensions \
    --object-path /org/gnome/Shell/Extensions \
    --method org.gnome.Shell.Extensions.GetExtensionErrors "$UUID"
  wait "$shell_pid"
' _ "$UUID"
