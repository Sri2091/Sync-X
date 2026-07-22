# Sync-X v2.1 Server

Local API-only processing service for the Sync-X Premiere Pro panel. Version
2.1 uses Whisper word anchors, balanced caption grouping, and hard 250 ms
silence boundaries.

## Install and start

1. Stop any earlier Sync-X or Hinglish SRT server using port `8765`.
2. Keep this complete folder together in a writable location.
3. Double-click `Sync-X_v2.1_run.command`.
4. Keep the Terminal window open while using the Premiere panel.

The top-level `install.command` also creates a Desktop shortcut named
`Sync-X_v2.1_run.command`. The shortcut points to this launcher, so keep the
complete Sync-X folder in a stable location or rerun the installer after moving
it.

On first launch, `Sync-X_v2.1_run.command` creates a private `venv`, installs
`requirements.txt`, and downloads and verifies the small official Silero VAD
model when it is missing. The server binds only to `127.0.0.1:8765`.

The launcher automatically prefers a Python 3.10+ installation with a valid
certificate bundle. If an earlier installation left an incomplete `venv`, it
rebuilds that environment with the working Python. It never disables HTTPS
certificate verification. If no compatible Python is found, install Homebrew
Python (`brew install python@3.11`) or run the `Install Certificates.command`
included with Python.org Python, then launch Sync-X again. Advanced users may
set `SYNCX_PYTHON` to a specific compatible Python executable.

## Required local tools

Install these before the first real transcription:

- `whisper-cli` (auto-detected from `PATH`, then
  `/opt/homebrew/bin/whisper-cli`)
- `ffmpeg` and `ffprobe`
- Whisper large-v3 model at
  `~/.cache/whisper-cpp/ggml-large-v3.bin`

The VAD model defaults to:

`~/.cache/whisper-cpp/ggml-silero-v6.2.0.bin`

Custom installations may set `HINGLISH_WHISPER_CLI`, `HINGLISH_FFMPEG`,
`HINGLISH_FFPROBE`, `HINGLISH_WHISPER_MODEL`, or
`HINGLISH_WHISPER_VAD_MODEL`.

## Readiness check

After startup, open:

`http://127.0.0.1:8765/api/v1/health`

Every dependency should report `ready: true`. Local interactive API
documentation is available at `http://127.0.0.1:8765/docs`.

## API

- `GET /api/v1/health`
- `GET /api/v1/options`
- `POST /api/v1/jobs`
- `GET /api/v1/jobs/{job_id}`
- `GET /api/v1/jobs/{job_id}/result`
- `DELETE /api/v1/jobs/{job_id}`

The server accepts one active job, stores no Gemini key, removes uploaded and
intermediate media after processing, and keeps an undownloaded SRT for up to one
hour.
