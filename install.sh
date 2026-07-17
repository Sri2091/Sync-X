#!/bin/zsh

set -euo pipefail

ROOT_DIR="${0:A:h}"
SERVER_DIR="$ROOT_DIR/server"
VENV_DIR="$SERVER_DIR/venv"
MODEL_DIR="${HOME}/.cache/whisper-cpp"
WHISPER_MODEL="$MODEL_DIR/ggml-large-v3.bin"
VAD_MODEL="$MODEL_DIR/ggml-silero-v6.2.0.bin"
WHISPER_MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin?download=true"
VAD_MODEL_URL="https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin?download=true"
VAD_MODEL_SHA256="2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987"

CHECK_ONLY=0
FORCE_PYTHON=0

usage() {
  echo "Usage: ./install.sh [--check] [--force-python]"
  echo "  --check         Report dependency status without installing anything."
  echo "  --force-python  Reinstall the server's Python packages."
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
  echo "Hinglish SRT v1 currently supports macOS only."
  exit 1
fi

print_status() {
  local label="$1"
  local state="$2"
  printf "%-30s %s\n" "$label" "$state"
}

find_python() {
  local candidate
  for candidate in \
    /opt/homebrew/bin/python3.13 \
    /opt/homebrew/bin/python3.12 \
    /opt/homebrew/bin/python3.11 \
    /opt/homebrew/opt/python@3.13/bin/python3.13 \
    /opt/homebrew/opt/python@3.12/bin/python3.12 \
    /opt/homebrew/opt/python@3.11/bin/python3.11 \
    /usr/local/bin/python3.13 \
    /usr/local/bin/python3.12 \
    /usr/local/bin/python3.11 \
    python3.13 python3.12 python3.11 python3; do
    if [[ "$candidate" == */* && ! -x "$candidate" ]]; then
      continue
    fi
    if command -v "$candidate" >/dev/null 2>&1; then
      if "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' >/dev/null 2>&1; then
        command -v "$candidate"
        return 0
      fi
    fi
  done
  return 1
}

find_homebrew_python() {
  command -v brew >/dev/null 2>&1 || return 1
  local formula version prefix candidate
  for formula in python@3.13 python@3.12 python@3.11; do
    brew list --versions "$formula" >/dev/null 2>&1 || continue
    version="${formula#python@}"
    prefix="$(brew --prefix "$formula")"
    candidate="$prefix/bin/python${version}"
    if [[ -x "$candidate" ]]; then
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
echo "Hinglish SRT v1 dependency check"
echo "Repository: $ROOT_DIR"
echo

MISSING=0
check_command "Homebrew" brew || MISSING=1

PYTHON_BIN=""
if PYTHON_BIN="$(find_python)"; then
  print_status "Python 3.11+" "ready: $PYTHON_BIN"
else
  print_status "Python 3.11+" "missing"
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

if [[ -x "$VENV_DIR/bin/python" ]] && "$VENV_DIR/bin/python" -c 'import fastapi, uvicorn, multipart, google.genai' >/dev/null 2>&1; then
  print_status "Server Python packages" "ready"
else
  print_status "Server Python packages" "missing"
  MISSING=1
fi

if (( CHECK_ONLY )); then
  echo
  if (( MISSING )); then
    echo "One or more dependencies are missing. Run ./install.sh to install them."
    exit 1
  fi
  echo "All dependencies are ready."
  exit 0
fi

if ! command -v brew >/dev/null 2>&1; then
  echo
  echo "Homebrew is required to install FFmpeg, Python, and whisper.cpp."
  echo "The official Homebrew installer may request your macOS password."
  /bin/bash -c "$(curl --fail --location https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  activate_homebrew
fi

BREW_PACKAGES=()
if ! find_homebrew_python >/dev/null 2>&1; then
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

PYTHON_BIN="$(find_homebrew_python)" || {
  echo "Homebrew Python 3.11 or newer was not found after installation."
  exit 1
}

if [[ ! -x "$VENV_DIR/bin/python" ]] || ! "$VENV_DIR/bin/python" -c 'import fastapi, uvicorn, multipart, google.genai' >/dev/null 2>&1; then
  echo
  echo "Creating the server environment in $VENV_DIR"
  "$PYTHON_BIN" -m venv --clear "$VENV_DIR"
fi

if (( FORCE_PYTHON )) || ! "$VENV_DIR/bin/python" -c 'import fastapi, uvicorn, multipart, google.genai' >/dev/null 2>&1; then
  echo
  echo "Installing server Python packages…"
  "$VENV_DIR/bin/python" -m pip install --upgrade pip
  "$VENV_DIR/bin/python" -m pip install -r "$SERVER_DIR/requirements.txt"
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

chmod +x "$ROOT_DIR/install.sh" "$SERVER_DIR/run.command"

echo
echo "Installation complete."
echo "Start the server with: $SERVER_DIR/run.command"
echo "Premiere plugin instructions: $ROOT_DIR/PLUGIN_INSTALL.md"
echo "Plugin manifest: $ROOT_DIR/premiere-plugin/manifest.json"
