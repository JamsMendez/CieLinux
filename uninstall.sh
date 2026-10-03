#!/usr/bin/env bash
# Remove what install.sh installed, including its marked Hyprland binds block.
# Settings ($XDG_CONFIG_HOME/cielinux) are kept unless --purge is given.
set -euo pipefail

# Must match install.sh.
HYPR_BINDS_BEGIN='# >>> cielinux mini position binds (managed by CieLinux install.sh) >>>'
HYPR_BINDS_END='# <<< cielinux mini position binds <<<'
HYPR_LUA_BINDS_BEGIN='-- >>> cielinux mini position binds (managed by CieLinux install.sh) >>>'
HYPR_LUA_BINDS_END='-- <<< cielinux mini position binds <<<'

# Removes exactly the marked block (BEGIN..END, default: the hyprlang markers) from FILE (written atomically, through a symlink,
# mode kept). No block: the file is not touched. A begin marker without an end marker:
# the file is left alone and the function fails.
hypr_binds_remove() {
  local file=$1 begin=${2:-$HYPR_BINDS_BEGIN} end=${3:-$HYPR_BINDS_END} kept real tmp
  grep -qxF -- "$begin" "$file" || return 0
  if ! kept=$(awk -v begin="$begin" -v end="$end" '
      $0 == begin { inside = 1; next }
      inside && $0 == end { inside = 0; next }
      !inside { out = out $0 "\n" }
      END { if (inside) exit 3; printf "%s", out }' "$file" && printf x); then
    echo "uninstall.sh: $file has an unterminated CieLinux binds block; remove it by hand" >&2
    return 1
  fi
  kept=${kept%x}
  real=$(realpath -- "$file") || return 1
  tmp=$(mktemp "$(dirname -- "$real")/.cielinux-binds.XXXXXX") || return 1
  if ! { printf '%s' "$kept" >"$tmp" && chmod --reference="$real" -- "$tmp" && mv -f -- "$tmp" "$real"; }; then
    rm -f -- "$tmp"
    return 1
  fi
}

# Removes the block from every file install.sh may have written in the Hyprland config
# DIR: bindings.lua (Lua config), bindings.conf and hyprland.conf (hyprlang). Fails when
# any of them has an unterminated block (that file is left alone; the others are cleaned).
hypr_binds_uninstall() {
  local dir=$1 conf rc=0
  if [[ -f $dir/bindings.lua ]]; then
    hypr_binds_remove "$dir/bindings.lua" "$HYPR_LUA_BINDS_BEGIN" "$HYPR_LUA_BINDS_END" || rc=1
  fi
  for conf in "$dir/bindings.conf" "$dir/hyprland.conf"; do
    if [[ -f $conf ]]; then hypr_binds_remove "$conf" || rc=1; fi
  done
  return "$rc"
}

main() {
  local prefix="$HOME/.local" purge=0
  while (($#)); do
    case $1 in
      --prefix) [[ $# -ge 2 && -n $2 ]] || { echo "Usage: ./uninstall.sh [--prefix DIR] [--purge]" >&2; exit 2; }; prefix=$2; shift 2 ;;
      --purge) purge=1; shift ;;
      -h|--help) echo "Usage: ./uninstall.sh [--prefix DIR] [--purge]"; exit 0 ;;
      *) echo "uninstall.sh: unknown argument: $1" >&2; exit 2 ;;
    esac
  done

  unit="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/cielinux.service"
  if command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
    systemctl --user disable --now cielinux.service 2>/dev/null || true
  fi
  rm -f -- "$unit" "$prefix/bin/cielinux"
  if command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
    systemctl --user daemon-reload
  fi
  hypr_binds_uninstall "${XDG_CONFIG_HOME:-$HOME/.config}/hypr" || true
  if ((purge)); then
    rm -rf -- "${XDG_CONFIG_HOME:-$HOME/.config}/cielinux" \
              "${XDG_STATE_HOME:-$HOME/.local/state}/cielinux" \
              "${XDG_DATA_HOME:-$HOME/.local/share}/cielinux"
  fi
  echo "CieLinux removed"
}

# Sourcing this file (tests) defines the functions without removing anything.
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
