#!/bin/zsh
set -e

SCRIPT_DIR="${0:A:h}"
cd "$SCRIPT_DIR"

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

select_python() {
  local candidate
  local path_python="$(command -v python3 2>/dev/null || true)"
  local candidates=(
    "${SYNCX_PYTHON:-}"
    /opt/homebrew/bin/python3.13
    /opt/homebrew/bin/python3.12
    /opt/homebrew/bin/python3.11
    /opt/homebrew/bin/python3.10
    /opt/homebrew/bin/python3
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

PYTHON_BIN="$(select_python || true)"
if [[ -z "$PYTHON_BIN" ]]; then
  echo "Sync-X needs Python 3.10 or newer with working HTTPS certificates."
  echo "Install Homebrew Python (brew install python@3.11), or run the"
  echo "'Install Certificates.command' supplied with Python.org Python."
  echo "You can also set SYNCX_PYTHON to a compatible Python executable."
  exit 1
fi

create_environment() {
  local mode="$1"
  if [[ "$mode" == "rebuild" ]]; then
    echo "Rebuilding the incomplete Sync-X server environment with $PYTHON_BIN…"
    "$PYTHON_BIN" -m venv --clear venv
  else
    echo "Creating the Sync-X server environment with $PYTHON_BIN…"
    "$PYTHON_BIN" -m venv venv
  fi
}

if [[ ! -x venv/bin/python ]]; then
  create_environment create
elif ! venv/bin/python -c 'import fastapi, uvicorn, multipart, google.genai' >/dev/null 2>&1; then
  VENV_BASE="$(venv/bin/python -c 'import os, sys; print(os.path.realpath(sys._base_executable))' 2>/dev/null || true)"
  SELECTED_BASE="$("$PYTHON_BIN" -c 'import os, sys; print(os.path.realpath(sys.executable))')"
  if [[ "$VENV_BASE" != "$SELECTED_BASE" ]]; then
    create_environment rebuild
  fi
fi

if ! venv/bin/python -c 'import fastapi, uvicorn, multipart, google.genai' >/dev/null 2>&1; then
  echo "Installing the Sync-X server dependencies…"
  if ! venv/bin/python -m pip install -r requirements.txt; then
    echo
    echo "Dependency installation failed. Check the internet connection and"
    echo "the Python certificate setup, then run this launcher again."
    exit 1
  fi
fi

DEFAULT_VAD_MODEL="${HOME}/.cache/whisper-cpp/ggml-silero-v6.2.0.bin"
VAD_MODEL_PATH="${HINGLISH_WHISPER_VAD_MODEL:-$DEFAULT_VAD_MODEL}"
VAD_MODEL_SHA256="2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987"

if [[ ! -f "$VAD_MODEL_PATH" ]]; then
  echo "Downloading the Whisper silence-detection model…"
  mkdir -p "$(dirname "$VAD_MODEL_PATH")"
  curl --fail --location --silent --show-error \
    --output "${VAD_MODEL_PATH}.part" \
    "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin?download=true"
  DOWNLOADED_SHA256="$(shasum -a 256 "${VAD_MODEL_PATH}.part" | awk '{print $1}')"
  if [[ "$DOWNLOADED_SHA256" != "$VAD_MODEL_SHA256" ]]; then
    rm -f "${VAD_MODEL_PATH}.part"
    echo "The downloaded silence-detection model failed verification."
    exit 1
  fi
  mv "${VAD_MODEL_PATH}.part" "$VAD_MODEL_PATH"
fi

if [[ "$VAD_MODEL_PATH" == "$DEFAULT_VAD_MODEL" ]]; then
  INSTALLED_SHA256="$(shasum -a 256 "$VAD_MODEL_PATH" | awk '{print $1}')"
  if [[ "$INSTALLED_SHA256" != "$VAD_MODEL_SHA256" ]]; then
    echo "The installed silence-detection model failed verification."
    exit 1
  fi
fi

echo "Starting Sync-X Server at http://127.0.0.1:8765"
exec venv/bin/python app.py
