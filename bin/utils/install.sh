#!/usr/bin/env bash
#
# Installs this harness configuration; works when streamed to Bash:
#
#   curl -fsSL https://alexandru.github.io/opencode-config/install.sh | bash
#
# Only bootstraps what the Python deployer needs (Git, Python, Make); the
# deployer and the configuration's `make` handle everything else. Stays
# compatible with macOS's Bash 3.2.

set -euo pipefail

REPOSITORY=https://github.com/alexandru/opencode-config.git
DIRECTORY_VARIABLE=XDG_CONFIG_HOME
DESTINATION=${XDG_CONFIG_HOME:-$HOME/.config}/opencode
PYTHON_MINIMUM=3.10
STAGING=

fail() {
  echo "Error: $*" >&2
  exit 1
}

works() {
  "$@" >/dev/null 2>&1
}

python_sufficient() {
  works python3 -c "import sys; sys.exit(sys.version_info < tuple(map(int, '$PYTHON_MINIMUM'.split('.'))))"
}

missing_requirements() {
  local missing=()
  works git --version || missing+=(git)
  works make --version || missing+=(make)
  python_sufficient || missing+=(python3)
  echo "${missing[@]+"${missing[@]}"}"
}

with_privileges() {
  if [[ $(id -u) == 0 ]]; then
    "$@"
  elif works command -v sudo; then
    sudo "$@"
  else
    fail "sudo is required to run: $*"
  fi
}

load_homebrew() {
  local brew
  for brew in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [[ -x $brew ]]; then
      eval "$("$brew" shellenv)"
      return 0
    fi
  done
  return 1
}

bootstrap_macos() {
  if ! works command -v brew && ! load_homebrew; then
    echo "Installing Homebrew from its official installer..."
    # The installer confirms and asks for sudo on the terminal; stdin is this script.
    local input=/dev/null
    if (: </dev/tty) 2>/dev/null; then input=/dev/tty; fi
    /bin/bash -c \
      "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" <"$input" \
      || fail "Homebrew installation failed"
    load_homebrew || fail "Homebrew installed, but brew was not found"
  fi
  local packages=() requirement
  for requirement in "$@"; do
    case $requirement in
      python3) packages+=(python) ;;
      *) packages+=("$requirement") ;;
    esac
  done
  brew install "${packages[@]}" </dev/null || fail "brew install ${packages[*]} failed"
}

bootstrap_linux() {
  works command -v apt-get \
    || fail "unsupported Linux distribution: apt-get is required to install $*"
  with_privileges apt-get update </dev/null || fail "apt-get update failed"
  with_privileges apt-get install -y --no-install-recommends "$@" </dev/null \
    || fail "apt-get install $* failed"
}

bootstrap() {
  local missing
  missing=$(missing_requirements)
  [[ -z $missing ]] && return 0

  echo "Installing missing requirements: $missing"
  # shellcheck disable=SC2086 # package names are single words
  case $(uname -s) in
    Darwin) bootstrap_macos $missing ;;
    Linux) bootstrap_linux $missing ;;
    *) fail "unsupported platform: $(uname -s)" ;;
  esac

  missing=$(missing_requirements)
  if [[ " $missing " == *" python3 "* ]]; then
    fail "Python $PYTHON_MINIMUM or later is required; installed: $(python3 --version 2>&1 || echo none)"
  elif [[ -n $missing ]]; then
    fail "still missing after installation: $missing"
  fi
}

# A local copy runs from its checkout; a streamed copy has no file to locate.
local_source() {
  local script=${BASH_SOURCE[0]:-}
  [[ -n $script && -f $script ]] || return 1
  local directory
  directory=$(cd -- "$(dirname -- "$script")/../.." && pwd -P) || return 1
  [[ -x $directory/bin/utils/deploy ]] || return 1
  works git -C "$directory" rev-parse --is-inside-work-tree || return 1
  printf '%s\n' "$directory"
}

main() {
  bootstrap

  local repository=${INSTALL_REPOSITORY:-$REPOSITORY}
  local source source_kind=checkout

  if ! source=$(local_source); then
    source_kind=download
    trap 'if [[ -n $STAGING ]]; then rm -rf -- "$STAGING"; fi' EXIT
    trap 'exit 130' INT TERM
    STAGING=$(mktemp -d "${TMPDIR:-/tmp}/config-install.XXXXXX")
    echo "Downloading $repository..."
    git clone --quiet "$repository" "$STAGING/source" </dev/null \
      || fail "cannot download $repository"
    source=$STAGING/source
  fi

  "$source/bin/utils/deploy" \
    --source "$source" \
    --source-kind "$source_kind" \
    --repository "$repository" \
    --destination "$DESTINATION" \
    --directory-variable "$DIRECTORY_VARIABLE" </dev/null
}

main "$@"
