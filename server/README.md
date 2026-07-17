# Hinglish SRT Server

Local API-only processing service for the **Hinglish SRT** Premiere Pro UXP panel.

## Start

From the repository root, run `./install.sh` once. Then double-click
`run.command`. Keep the Terminal window open while using the Premiere panel.

The server listens only on `127.0.0.1:8765`. On first launch it also downloads
and verifies the small official Silero VAD model used to keep real silence gaps
out of Hindi/Hinglish subtitle timing.

## Required local tools

- `whisper-cli` (auto-detected from `PATH`, then `/opt/homebrew/bin/whisper-cli`)
- `ffmpeg` and `ffprobe`
- Whisper model at `~/.cache/whisper-cpp/ggml-large-v3.bin`
- Whisper Silero VAD model at `~/.cache/whisper-cpp/ggml-silero-v6.2.0.bin`

Override paths when needed with `HINGLISH_WHISPER_CLI`, `HINGLISH_FFMPEG`,
`HINGLISH_FFPROBE`, `HINGLISH_WHISPER_MODEL`, and
`HINGLISH_WHISPER_VAD_MODEL`.

## API

- `GET /api/v1/health`
- `GET /api/v1/options`
- `POST /api/v1/jobs`
- `GET /api/v1/jobs/{job_id}`
- `GET /api/v1/jobs/{job_id}/result`
- `DELETE /api/v1/jobs/{job_id}`

Interactive API documentation is available locally at `http://127.0.0.1:8765/docs`.
