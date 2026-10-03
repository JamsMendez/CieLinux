#!/usr/bin/env bash
# Build CieLinux and install it for the current user (no root):
#   <prefix>/bin/cielinux                       (scenes are embedded in the binary)
#   $XDG_CONFIG_HOME/systemd/user/cielinux.service
#   SUPER+Z / SUPER+SHIFT+Z mini position binds in your Hyprland config, Lua
#   (bindings.lua) or hyprlang (bindings.conf / hyprland.conf); one marked block,
#   skip with --no-hypr-binds
# The unit is only enabled and started with --enable.
set -euo pipefail

HYPR_BINDS_BEGIN='# >>> cielinux mini position binds (managed by CieLinux install.sh) >>>'
HYPR_BINDS_END='# <<< cielinux mini position binds <<<'
# Same block for Lua configs (Hyprland 0.56+ hyprland.lua), with Lua comment markers.
HYPR_LUA_BINDS_BEGIN='-- >>> cielinux mini position binds (managed by CieLinux install.sh) >>>'
HYPR_LUA_BINDS_END='-- <<< cielinux mini position binds <<<'

# "lua" when DIR holds a Lua config (hyprland.lua, which Hyprland loads instead of
# hyprland.conf), else "hyprlang".
hypr_binds_flavour() {
  if [[ -f $1/hyprland.lua ]]; then echo lua; else echo hyprlang; fi
}

# The hyprlang file the binds go in: Omarchy's bindings.conf when it exists, else
# hyprland.conf; nothing (empty output) when neither exists.
hypr_binds_target() {
  local dir=$1
  if [[ -f $dir/bindings.conf ]]; then printf '%s\n' "$dir/bindings.conf"
  elif [[ -f $dir/hyprland.conf ]]; then printf '%s\n' "$dir/hyprland.conf"
  fi
}

# Prints FILE without the block between BEGIN and END (markers included; defaults to the
# hyprlang markers); fails, printing nothing, when a begin marker has no end marker.
hypr_binds_strip() {
  awk -v begin="${2:-$HYPR_BINDS_BEGIN}" -v end="${3:-$HYPR_BINDS_END}" '
    $0 == begin { inside = 1; next }
    inside && $0 == end { inside = 0; next }
    !inside { out = out $0 "\n" }
    END { if (inside) exit 3; printf "%s", out }' "$1"
}

# Replaces the file's content atomically (temp file beside it, same mode), writing
# through a symlink so a dotfiles link stays a link.
hypr_binds_write() {
  local file content tmp
  file=$(realpath -- "$1") || return 1
  content=$2
  tmp=$(mktemp "$(dirname -- "$file")/.cielinux-binds.XXXXXX") || return 1
  if ! { printf '%s' "$content" >"$tmp" && chmod --reference="$file" -- "$tmp" && mv -f -- "$tmp" "$file"; }; then
    rm -f -- "$tmp"
    return 1
  fi
}

# Rewrites FILE with the BEGIN..END block replaced by LINES (appended at the end; an
# empty LINES only removes the block, and a file without a block is then not touched).
# Refuses, leaving the file alone, when a begin marker has no end marker.
hypr_binds_put() {
  local file=$1 begin=$2 end=$3 lines=$4 kept
  [[ -n $lines ]] || grep -qxF -- "$begin" "$file" || return 0
  if ! kept=$(hypr_binds_strip "$file" "$begin" "$end" && printf x); then
    echo "install.sh: $file has an unterminated CieLinux binds block; fix it by hand" >&2
    return 1
  fi
  kept=${kept%x}
  if [[ -n $lines ]]; then
    [[ -z $kept || $kept == *$'\n' ]] || kept+=$'\n'
    kept+="$begin"$'\n'"$lines"$'\n'"$end"$'\n'
  fi
  hypr_binds_write "$file" "$kept"
}

# The binary path as one sh word (Hyprland runs exec commands through sh).
hypr_binds_sh_quote() {
  local sq="'"
  printf "'%s'" "${1//"$sq"/"$sq\\$sq$sq"}"
}

# TEXT as a double-quoted Lua string literal.
hypr_binds_lua_string() {
  local s=$1 bs='\' dq='"'
  s=${s//"$bs"/"$bs$bs"}
  s=${s//"$dq"/"$bs$dq"}
  s=${s//$'\n'/"${bs}n"}
  s=${s//$'\r'/"${bs}r"}
  printf '"%s"' "$s"
}

# Adds (or refreshes) the hyprlang block at the end of FILE for the binary in BINDIR.
hypr_binds_add() {
  local file=$1 bin
  bin=$(hypr_binds_sh_quote "$2/cielinux")
  hypr_binds_put "$file" "$HYPR_BINDS_BEGIN" "$HYPR_BINDS_END" \
"bindd = SUPER, Z, CieLinux mini: next position, exec, $bin --cycle-position next
bindd = SUPER SHIFT, Z, CieLinux mini: previous position, exec, $bin --cycle-position prev"
}

# Adds (or refreshes) the Lua block (Omarchy's o.bind) at the end of FILE.
hypr_binds_lua_add() {
  local file=$1 bin next prev
  bin=$(hypr_binds_sh_quote "$2/cielinux")
  next=$(hypr_binds_lua_string "$bin --cycle-position next")
  prev=$(hypr_binds_lua_string "$bin --cycle-position prev")
  hypr_binds_put "$file" "$HYPR_LUA_BINDS_BEGIN" "$HYPR_LUA_BINDS_END" \
"o.bind(\"SUPER + Z\", \"CieLinux mini: next position\", $next)
o.bind(\"SUPER + SHIFT + Z\", \"CieLinux mini: previous position\", $prev)"
}

# Installs the binds for the binary in BINDIR into the Hyprland config in DIR. Lua
# config: the block goes in bindings.lua (created only when hyprland.lua requires
# hypr.bindings) and an old hyprlang block is removed from bindings.conf, which a Lua
# config does not load. hyprlang config: bindings.conf, else hyprland.conf.
hypr_binds_install() {
  local dir=$1 bindir=$2 target
  if [[ $(hypr_binds_flavour "$dir") == lua ]]; then
    target=$dir/bindings.lua
    if [[ ! -e $target ]]; then
      if [[ ! -L $target ]] && grep -Eq '^[[:space:]]*require[[:space:]]*\(?[[:space:]]*["'"'"']hypr\.bindings["'"'"']' "$dir/hyprland.lua"; then
        : >"$target" && chmod 0644 -- "$target" || return 1
      else
        echo "==> $dir/hyprland.lua does not load hypr/bindings.lua; mini position binds not added"
        return 0
      fi
    fi
    hypr_binds_lua_add "$target" "$bindir" || return 1
    echo "==> Added SUPER+Z / SUPER+SHIFT+Z mini position binds to $target"
    if [[ -f $dir/bindings.conf ]]; then
      hypr_binds_put "$dir/bindings.conf" "$HYPR_BINDS_BEGIN" "$HYPR_BINDS_END" "" || return 1
    fi
  else
    target=$(hypr_binds_target "$dir")
    if [[ -z $target ]]; then
      echo "==> No Hyprland config found; mini position binds not added"
      return 0
    fi
    hypr_binds_add "$target" "$bindir" || return 1
    echo "==> Added SUPER+Z / SUPER+SHIFT+Z mini position binds to $target"
  fi
}

usage() {
  cat <<'USAGE'
Usage: ./install.sh [--prefix DIR] [--build-dir DIR] [--enable] [--no-hypr-binds]

  --prefix DIR      Install prefix (default: ~/.local)
  --build-dir DIR   CMake build directory (default: ./build)
  --enable          Enable and start cielinux.service in the user session
  --no-hypr-binds   Do not add the SUPER+Z / SUPER+SHIFT+Z binds to the Hyprland config
  -h, --help        Show this help
USAGE
}

main() {
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
prefix="$HOME/.local"
build="$root/build"
enable=0
hypr_binds=1

while (($#)); do
  case $1 in
    --prefix) [[ $# -ge 2 && -n $2 ]] || { usage >&2; exit 2; }; prefix=$2; shift 2 ;;
    --build-dir) [[ $# -ge 2 && -n $2 ]] || { usage >&2; exit 2; }; build=$2; shift 2 ;;
    --enable) enable=1; shift ;;
    --no-hypr-binds) hypr_binds=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "install.sh: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if ((EUID == 0)); then
  echo "install.sh: run as your user, not root" >&2
  exit 1
fi
[[ $prefix == /* ]] || prefix="$PWD/$prefix"
for tool in cmake c++; do
  command -v "$tool" >/dev/null || { echo "install.sh: missing $tool" >&2; exit 1; }
done

echo "==> Building into $build"
cmake -S "$root" -B "$build" -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$prefix"
cmake --build "$build" -j

echo "==> Installing to $prefix"
cmake --install "$build"

unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
unit="$unit_dir/cielinux.service"
install -d -m 0755 "$unit_dir"
tmp=$(mktemp "$unit_dir/.cielinux.service.XXXXXX")
trap 'rm -f -- "$tmp"' EXIT
# Escape sed replacement metacharacters in the path.
bindir=$(printf '%s' "$prefix/bin" | sed 's/[\\&|]/\\&/g')
sed "s|@BINDIR@|$bindir|g" "$root/systemd/cielinux.service.in" >"$tmp"
chmod 0644 "$tmp"
mv -f -- "$tmp" "$unit"
trap - EXIT
echo "==> Installed $unit"

if command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
  systemctl --user daemon-reload
  if ((enable)); then
    systemctl --user enable --now cielinux.service
    echo "==> cielinux.service enabled and started"
  else
    echo "==> Start it with: systemctl --user enable --now cielinux.service"
  fi
elif ((enable)); then
  echo "install.sh: no systemd user session; cannot enable cielinux.service" >&2
  exit 1
fi

if ((hypr_binds)); then
  if ! hypr_binds_install "${XDG_CONFIG_HOME:-$HOME/.config}/hypr" "$prefix/bin"; then
    echo "install.sh: mini position binds not added" >&2
  fi
fi
}

# Sourcing this file (tests) defines the functions without installing anything.
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
