#!/bin/zsh

set -euo pipefail

ROOT_DIR="${0:A:h}"
SCRIPT_NAME="${SYNCX_INSTALLER_NAME:-${0:t}}"
SERVER_DIR="$ROOT_DIR/server"
SERVER_LAUNCHER_NAME="Sync-X_v2.1_run.command"
SERVER_LAUNCHER="$SERVER_DIR/$SERVER_LAUNCHER_NAME"
PLUGIN_DIR="$ROOT_DIR/premiere-plugin"
CCX_FILE="$ROOT_DIR/syncx_v2.1_premierepro.ccx"
PLUGIN_INSTALL_ROOT="${HOME}/Library/Application Support/Adobe/UXP/Plugins/External"
PLUGIN_INSTALL_DIR="$PLUGIN_INSTALL_ROOT/com.sridhar.syncx_2.1.0"
REQUIREMENTS_FILE="$SERVER_DIR/requirements.txt"
VENV_DIR="$SERVER_DIR/venv"
DESKTOP_SHORTCUT="${HOME}/Desktop/$SERVER_LAUNCHER_NAME"

MODEL_DIR="${HOME}/.cache/whisper-cpp"
WHISPER_MODEL="$MODEL_DIR/ggml-large-v3.bin"
VAD_MODEL="$MODEL_DIR/ggml-silero-v6.2.0.bin"
WHISPER_MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin?download=true"
VAD_MODEL_URL="https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin?download=true"
VAD_MODEL_SHA256="2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987"

CHECK_ONLY=0
FORCE_PYTHON=0

usage() {
  echo "Usage: ./$SCRIPT_NAME [--check] [--force-python]"
  echo "  --check         Report readiness without installing anything."
  echo "  --force-python  Reinstall the Premiere server Python requirements."
}

for argument in "$@"; do
  case "$argument" in
    --check)
      CHECK_ONLY=1
      ;;
    --force-python)
      FORCE_PYTHON=1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $argument"
      usage
      exit 2
      ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Sync-X v2.1 for Premiere Pro currently supports macOS only."
  exit 1
fi

if [[ ! -f "$REQUIREMENTS_FILE" || ! -f "$SERVER_DIR/app.py" ]]; then
  echo "The Sync-X Premiere server folder is incomplete."
  echo "Expected server files under: $SERVER_DIR"
  exit 1
fi

if [[ ! -f "$SERVER_LAUNCHER" ]]; then
  echo "The Sync-X server launcher is missing."
  echo "Expected launcher at: $SERVER_LAUNCHER"
  exit 1
fi

if [[ ! -f "$PLUGIN_DIR/manifest.json" ]]; then
  echo "The Sync-X Premiere plugin folder is incomplete."
  echo "Expected plugin files under: $PLUGIN_DIR"
  exit 1
fi

print_status() {
  local label="$1"
  local state="$2"
  printf "%-34s %s\n" "$label" "$state"
}

python_is_usable() {
  local candidate="$1"
  [[ -n "$candidate" && -x "$candidate" ]] || return 1
  "$candidate" -c '
import os
import ssl
import sys

verify = ssl.get_default_verify_paths()
has_ca = bool(verify.cafile and os.path.isfile(verify.cafile))
raise SystemExit(0 if sys.version_info >= (3, 10) and has_ca else 1)
' >/dev/null 2>&1
}

find_python() {
  local candidate
  local path_python="$(command -v python3 2>/dev/null || true)"
  local candidates=(
    "${SYNCX_PYTHON:-}"
    /opt/homebrew/bin/python3.13
    /opt/homebrew/bin/python3.12
    /opt/homebrew/bin/python3.11
    /opt/homebrew/bin/python3.10
    /opt/homebrew/bin/python3
    /opt/homebrew/opt/python@3.13/bin/python3.13
    /opt/homebrew/opt/python@3.12/bin/python3.12
    /opt/homebrew/opt/python@3.11/bin/python3.11
    /opt/homebrew/opt/python@3.10/bin/python3.10
    /usr/local/bin/python3.13
    /usr/local/bin/python3.12
    /usr/local/bin/python3.11
    /usr/local/bin/python3.10
    /usr/local/bin/python3
    "$path_python"
  )

  for candidate in "${candidates[@]}"; do
    if python_is_usable "$candidate"; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

activate_homebrew() {
  if [[ -x "/opt/homebrew/bin/brew" ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x "/usr/local/bin/brew" ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
}

check_command() {
  local label="$1"
  local command_name="$2"
  if command -v "$command_name" >/dev/null 2>&1; then
    print_status "$label" "ready: $(command -v "$command_name")"
    return 0
  fi
  print_status "$label" "missing"
  return 1
}

server_packages_ready() {
  [[ -x "$VENV_DIR/bin/python" ]] || return 1
  "$VENV_DIR/bin/python" -c \
    'import sys; assert sys.version_info >= (3, 10); import fastapi, uvicorn, multipart, google.genai' \
    >/dev/null 2>&1
}

plugin_is_installed() {
  local installed_manifest="$PLUGIN_INSTALL_DIR/manifest.json"
  [[ -f "$installed_manifest" ]] || return 1
  grep -Eq '"id"[[:space:]]*:[[:space:]]*"com\.sridhar\.syncx"' "$installed_manifest" && \
    grep -Eq '"version"[[:space:]]*:[[:space:]]*"2\.1\.0"' "$installed_manifest"
}

desktop_shortcut_ready() {
  [[ -L "$DESKTOP_SHORTCUT" ]] || return 1
  [[ "$(readlink "$DESKTOP_SHORTCUT")" == "$SERVER_LAUNCHER" ]]
}

install_desktop_shortcut() {
  local desktop_dir="${DESKTOP_SHORTCUT:h}"

  mkdir -p "$desktop_dir"
  chmod +x "$SERVER_LAUNCHER"

  if [[ -L "$DESKTOP_SHORTCUT" ]]; then
    rm -f "$DESKTOP_SHORTCUT"
  elif [[ -e "$DESKTOP_SHORTCUT" ]]; then
    echo "A file or folder already uses the Desktop shortcut name:"
    echo "  $DESKTOP_SHORTCUT"
    return 1
  fi

  ln -s "$SERVER_LAUNCHER" "$DESKTOP_SHORTCUT"
  desktop_shortcut_ready
}

install_premiere_plugin() {
  local staging_dir="${PLUGIN_INSTALL_DIR}.installing.$$"
  local backup_dir="${PLUGIN_INSTALL_DIR}.previous.$$"

  if [[ -L "$PLUGIN_INSTALL_DIR" ]]; then
    echo "Refusing to replace a symbolic link at: $PLUGIN_INSTALL_DIR"
    return 1
  fi

  mkdir -p "$PLUGIN_INSTALL_ROOT"
  rm -rf "$staging_dir" "$backup_dir"
  /usr/bin/ditto "$PLUGIN_DIR" "$staging_dir"

  if [[ -e "$PLUGIN_INSTALL_DIR" ]]; then
    mv "$PLUGIN_INSTALL_DIR" "$backup_dir"
  fi

  if mv "$staging_dir" "$PLUGIN_INSTALL_DIR"; then
    rm -rf "$backup_dir"
  else
    rm -rf "$staging_dir"
    if [[ -e "$backup_dir" ]]; then
      mv "$backup_dir" "$PLUGIN_INSTALL_DIR"
    fi
    return 1
  fi

  plugin_is_installed
}

download_file() {
  local label="$1"
  local url="$2"
  local destination="$3"
  local partial="${destination}.part"
  mkdir -p "$(dirname "$destination")"
  echo "Downloading $label. This can take some time…"
  curl --fail --location --continue-at - --progress-bar \
    --output "$partial" "$url"
  mv "$partial" "$destination"
}

verify_vad_model() {
  [[ -f "$VAD_MODEL" ]] || return 1
  local checksum
  checksum="$(shasum -a 256 "$VAD_MODEL" | awk '{print $1}')"
  [[ "$checksum" == "$VAD_MODEL_SHA256" ]]
}

activate_homebrew

echo
echo "Sync-X v2.1 Premiere Pro dependency check"
echo "Package folder: $ROOT_DIR"
echo "Server requirements: $REQUIREMENTS_FILE"
echo "Plugin destination: $PLUGIN_INSTALL_DIR"
echo

MISSING=0
check_command "Homebrew" brew || MISSING=1

PYTHON_BIN=""
if PYTHON_BIN="$(find_python)"; then
  print_status "Python 3.10+ with HTTPS" "ready: $PYTHON_BIN"
else
  print_status "Python 3.10+ with HTTPS" "missing"
  MISSING=1
fi

check_command "FFmpeg" ffmpeg || MISSING=1
check_command "FFprobe" ffprobe || MISSING=1
check_command "Whisper CLI" whisper-cli || MISSING=1
check_command "curl" curl || MISSING=1

if [[ -f "$WHISPER_MODEL" ]]; then
  print_status "Whisper large-v3 model" "ready: $WHISPER_MODEL"
else
  print_status "Whisper large-v3 model" "missing"
  MISSING=1
fi

if verify_vad_model; then
  print_status "Silero VAD model" "ready: $VAD_MODEL"
else
  print_status "Silero VAD model" "missing or invalid"
  MISSING=1
fi

if server_packages_ready; then
  print_status "Premiere server requirements" "ready"
else
  print_status "Premiere server requirements" "missing"
  MISSING=1
fi

if plugin_is_installed; then
  print_status "Premiere UXP plugin" "ready: $PLUGIN_INSTALL_DIR"
else
  print_status "Premiere UXP plugin" "missing"
  MISSING=1
fi

if desktop_shortcut_ready; then
  print_status "Desktop server shortcut" "ready: $DESKTOP_SHORTCUT"
else
  print_status "Desktop server shortcut" "missing"
  MISSING=1
fi

if (( CHECK_ONLY )); then
  echo
  if (( MISSING )); then
    echo "One or more dependencies are missing. Double-click install.command to install them."
    exit 1
  fi
  echo "All Premiere Pro dependencies are ready."
  exit 0
fi

if ! command -v brew >/dev/null 2>&1; then
  echo
  echo "Homebrew is required to install Python, FFmpeg, and whisper.cpp."
  echo "The official Homebrew installer may request your macOS password."
  /bin/bash -c "$(curl --fail --location https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  activate_homebrew
fi

typeset -a BREW_PACKAGES
BREW_PACKAGES=()
if ! find_python >/dev/null 2>&1; then
  BREW_PACKAGES+=(python@3.11)
fi
if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
  BREW_PACKAGES+=(ffmpeg)
fi
if ! command -v whisper-cli >/dev/null 2>&1; then
  BREW_PACKAGES+=(whisper-cpp)
fi

if (( ${#BREW_PACKAGES[@]} )); then
  echo
  echo "Installing system dependencies: ${BREW_PACKAGES[*]}"
  brew install "${BREW_PACKAGES[@]}"
fi

PYTHON_BIN="$(find_python || true)"
if [[ -z "$PYTHON_BIN" ]]; then
  echo "Python 3.10 or newer with working HTTPS certificates was not found."
  echo "Install Homebrew Python with: brew install python@3.11"
  exit 1
fi

if [[ ! -x "$VENV_DIR/bin/python" ]]; then
  echo
  echo "Creating the private Premiere server environment…"
  "$PYTHON_BIN" -m venv "$VENV_DIR"
elif ! server_packages_ready; then
  VENV_BASE="$($VENV_DIR/bin/python -c 'import os, sys; print(os.path.realpath(sys._base_executable))' 2>/dev/null || true)"
  SELECTED_BASE="$($PYTHON_BIN -c 'import os, sys; print(os.path.realpath(sys.executable))')"
  if [[ "$VENV_BASE" != "$SELECTED_BASE" ]]; then
    echo
    echo "Rebuilding the incomplete server environment with $PYTHON_BIN…"
    "$PYTHON_BIN" -m venv --clear "$VENV_DIR"
  fi
fi

if (( FORCE_PYTHON )) || ! server_packages_ready; then
  echo
  echo "Installing Premiere server requirements from:"
  echo "  $REQUIREMENTS_FILE"
  if ! "$VENV_DIR/bin/python" -m pip install -r "$REQUIREMENTS_FILE"; then
    echo
    echo "Dependency installation failed. Check the internet connection and"
    echo "the Python certificate setup, then run install.command again."
    exit 1
  fi
fi

if ! server_packages_ready; then
  echo "The Premiere server requirements could not be verified."
  exit 1
fi

if [[ ! -f "$WHISPER_MODEL" ]]; then
  download_file "Whisper large-v3 (about 3 GB)" "$WHISPER_MODEL_URL" "$WHISPER_MODEL"
fi

if ! verify_vad_model; then
  rm -f "$VAD_MODEL" "${VAD_MODEL}.part"
  download_file "Silero VAD model" "$VAD_MODEL_URL" "$VAD_MODEL"
  if ! verify_vad_model; then
    rm -f "$VAD_MODEL"
    echo "The Silero VAD model failed checksum verification."
    exit 1
  fi
fi

echo
echo "Installing the Premiere plugin…"
if ! install_premiere_plugin; then
  echo "The Premiere plugin could not be installed at:"
  echo "  $PLUGIN_INSTALL_DIR"
  exit 1
fi

echo
echo "Creating the Desktop server shortcut…"
if ! install_desktop_shortcut; then
  echo "The Desktop shortcut could not be created at:"
  echo "  $DESKTOP_SHORTCUT"
  exit 1
fi

if [[ -f "$ROOT_DIR/install.sh" ]]; then
  chmod +x "$ROOT_DIR/install.sh"
fi
if [[ -f "$ROOT_DIR/install.command" ]]; then
  chmod +x "$ROOT_DIR/install.command"
fi
if [[ -f "$SERVER_LAUNCHER" ]]; then
  chmod +x "$SERVER_LAUNCHER"
fi

echo
echo "Installation complete."
echo "Start the Sync-X server from your Desktop: $DESKTOP_SHORTCUT"
echo "Server launcher: $SERVER_LAUNCHER"
echo "Premiere plugin installed at: $PLUGIN_INSTALL_DIR"
if [[ -f "$CCX_FILE" ]]; then
  echo "Packaged CCX: $CCX_FILE"
fi
