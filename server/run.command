#!/bin/zsh
set -e

SCRIPT_DIR="${0:A:h}"
cd "$SCRIPT_DIR"

if ! venv/bin/python -c 'import fastapi, uvicorn, multipart, google.genai' >/dev/null 2>&1; then
  echo "The server environment is not ready. Running the v1 installer…"
  "$SCRIPT_DIR/../install.sh"
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

echo "Starting Hinglish SRT Server at http://127.0.0.1:8765"
exec venv/bin/python app.py
