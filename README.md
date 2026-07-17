# Hinglish SRT v1

Local Hinglish/English subtitle generation for Adobe Premiere Pro 25.6+.

This repository contains:

- `server/` — the FastAPI localhost processing server.
- `premiere-plugin/` — the Premiere Pro UXP panel.
- `install.sh` — macOS dependency checker and in-place server installer.
- `PLUGIN_INSTALL.md` — where to keep and how to load the panel.

The server binds only to `127.0.0.1:8765`. Audio is rendered by Premiere,
processed locally by Whisper large-v3, and returned as an SRT. Hindi jobs send
subtitle text to the selected Gemini model for Hinglish conversion. The Gemini
key is entered in the panel and is never saved in this repository.

## Requirements

- macOS
- Adobe Premiere Pro 25.6 or newer
- Adobe UXP Developer Tool
- Approximately 4 GB of free space for the Whisper model and local environment
- Internet access for the first installation

## Install the server

Open Terminal in this repository and run:

```sh
chmod +x install.sh
./install.sh
```

The installer checks and installs Homebrew (when absent), Python 3, FFmpeg,
whisper.cpp, the Python packages, Whisper large-v3, and the Silero VAD model.
It creates `server/venv` and leaves the server installed inside this repository.
Existing valid dependencies and model files are reused.

To inspect without changing the machine:

```sh
./install.sh --check
```

To reinstall Python packages:

```sh
./install.sh --force-python
```

## Start the server

Double-click `server/run.command`, or run:

```sh
./server/run.command
```

Leave its Terminal window open while using the panel. Confirm it is ready at:

```text
http://127.0.0.1:8765/api/v1/health
```

## Install the Premiere panel

Follow `PLUGIN_INSTALL.md`. In short: keep `premiere-plugin/` in a stable
location, enable Premiere Developer Mode, then use UXP Developer Tool's
**Add Plugin** command and select `premiere-plugin/manifest.json`.

## Update or publish

This folder is a local Git repository ready for you to connect to a remote:

```sh
git remote add origin YOUR_REPOSITORY_URL
git push -u origin main
```

No API keys, virtual environments, downloaded models, rendered audio, or
generated SRT files should be committed.
