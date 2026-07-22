<p align="center">
  <img src="premiere-plugin/webview/assets/syncx-mark.svg" width="72" alt="Sync-X logo">
</p>

<h1 align="center">Sync-X v2.1</h1>

<p align="center">
  Word-aligned Hinglish and English subtitles for Adobe Premiere Pro.
  <br>
  Select a track. Set a range. Generate and import.
</p>

<p align="center">
  <strong>macOS only</strong> · Premiere Pro 25.6+ · Local Whisper processing
</p>

---

## About

Sync-X turns a selected Premiere Pro audio track into a clean, editable SRT in one workflow. It renders the active sequence In/Out range, transcribes it locally with Whisper large-v3, builds captions from real word timestamps, saves the result, and imports it into a `Sync-X` project bin.

- **English mode** keeps transcription fully local.
- **Hinglish mode** transcribes Hindi locally, then sends the recognized text to Gemini for Roman-script conversion.
- **Word-aligned timing** uses actual Whisper word anchors instead of proportional timing.
- **Silence-safe captions** never cross a detected silence of 250 ms or more.
- **Balanced grouping** avoids unnecessary single-word captions while respecting the selected maximum.
- **Track isolation** restores the original Premiere audio-track mute states after rendering.
- **Timeline offset** keeps subtitles aligned when the sequence In point is not zero.

> [!IMPORTANT]
> Sync-X v2.1 currently supports **macOS only**. Windows is not supported by this release.

> [!WARNING]
> The first installation downloads Whisper large-v3, which is approximately **3 GB**. Homebrew packages and the private Python environment require additional space. Keep at least **5 GB free**, use a stable internet connection, and do not close Terminal during the first installation.

## Requirements

- macOS
- Adobe Premiere Pro 25.6 or newer
- Internet access for the first installation
- Internet access and a valid Gemini API key for Hinglish conversion
- At least 5 GB of available disk space
- A writable copy of this complete repository folder

The installer manages Homebrew, Python 3.10+, FFmpeg, FFprobe, whisper.cpp, server packages, and the required Whisper/VAD models when they are missing.

## Repository structure

```text
Sync-X-v2.1/
├── install.command                  # Double-click macOS installer
├── premiere-plugin/                 # Premiere Pro UXP panel source
├── server/                          # Local FastAPI transcription server
│   ├── requirements.txt
│   └── run.command                  # Double-click server launcher
├── syncx_v2.1_premierepro.ccx       # Packaged Premiere plugin
└── README.md
```

Keep `install.command`, `server/`, and `premiere-plugin/` together. The installer resolves every source path relative to its own location, so the repository can be stored in any writable folder.

## Installation

### 1. Prepare the folder

Download or copy the complete repository to a writable location. Stop any older Sync-X or Hinglish SRT server already using port `8765`, and close Premiere Pro before replacing the plugin.

### 2. Run the installer

Double-click:

```text
install.command
```

If macOS blocks the first launch, right-click `install.command`, choose **Open**, and confirm. You can also launch it from Terminal:

```sh
chmod +x install.command
./install.command
```

The installer will:

1. Check or install the required command-line tools.
2. Create a private Python environment inside `server/venv`.
3. Install everything listed in `server/requirements.txt`.
4. Download Whisper large-v3 and the verified Silero VAD model when missing.
5. Install the UXP plugin at:

```text
~/Library/Application Support/Adobe/UXP/Plugins/External/com.sridhar.syncx_2.1.0
```

The `~` automatically resolves to the current macOS user, so no username or source-folder path is hard-coded.

### 3. Start the local server

Double-click:

```text
server/run.command
```

Keep its Terminal window open while using Sync-X. The server runs only on your Mac at:

```text
http://127.0.0.1:8765
```

Confirm readiness in a browser:

```text
http://127.0.0.1:8765/api/v1/health
```

### 4. Open Sync-X in Premiere Pro

Restart Premiere Pro after installation, then open:

**Window → UXP Plugins → Sync-X**

This is an external UXP build. If the panel does not appear, confirm that Premiere Developer Mode is enabled, verify the installed plugin folder above, and restart Premiere.

## Using Sync-X

1. Open a Premiere project and an active sequence.
2. Set valid sequence **In** and **Out** points.
3. Clear any audio-track **Solo** buttons.
4. Select one non-empty standard audio track in Sync-X.
5. Choose **Hinglish** or **English**.
6. For Hinglish, enter your Gemini API key. It is kept only for the current panel session.
7. Choose the maximum words per caption and optionally add vocabulary guidance.
8. Select **Generate & Import**.

Sync-X supports one active job and a maximum selected range of **30 minutes**.

## Output

Generated SRT files are saved under:

```text
~/Documents/Sync-X Outputs/<project>/<sequence>/
```

The saved SRT is imported into a root project bin named `Sync-X`. Sync-X does **not** automatically place the captions on a timeline track.

If Premiere import fails, the SRT remains safely saved on disk and the panel offers **Retry Import**.

## Privacy and local processing

- Audio transcription runs locally through Whisper large-v3.
- The server binds only to `127.0.0.1` and is not exposed to the LAN or internet.
- English jobs do not use Gemini.
- For Hinglish jobs, recognized subtitle text is sent to Gemini for conversion; the rendered audio is not sent to Gemini.
- The Gemini key is held in session memory only and is never saved or written to logs.
- Temporary rendered and intermediate audio files are cleaned up after processing or cancellation.

## Installer checks

Check readiness without changing the machine:

```sh
./install.command --check
```

Reinstall the private server packages:

```sh
./install.command --force-python
```

## Troubleshooting

### Server shows offline

Run `server/run.command`, leave Terminal open, and check `http://127.0.0.1:8765/api/v1/health`. Stop any older application already using port `8765`.

### Python certificate error

Install Homebrew Python with `brew install python@3.11`, or run the `Install Certificates.command` supplied with Python.org Python. Then run the installer again. Sync-X does not disable HTTPS certificate verification.

### Plugin does not appear

Close and reopen Premiere, confirm Developer Mode is enabled, and verify this folder exists:

```text
~/Library/Application Support/Adobe/UXP/Plugins/External/com.sridhar.syncx_2.1.0
```

### First download was interrupted

Run `install.command` again. Existing valid dependencies and model files are reused, and the large Whisper download can resume from its partial file.

### Hinglish conversion fails

Confirm the Gemini key and internet connection, then retry. Free-tier Gemini limits can temporarily reject or delay large requests; English transcription remains independent of Gemini.

## Notes

- Do not commit `server/venv`, API keys, downloaded models, rendered audio, or generated SRT files.
- The Whisper models are stored in `~/.cache/whisper-cpp/` and are shared across compatible Sync-X installations.
- More server details are available in [`server/README.md`](server/README.md).
- More panel details are available in [`premiere-plugin/README.md`](premiere-plugin/README.md).

---

<p align="center"><sub>Vision by Sridhar R · Built by Codex</sub></p>
