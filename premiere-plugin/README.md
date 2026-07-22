# Sync-X v2.1 — Premiere Pro UXP Plugin

Sync-X renders one selected audio track over the active sequence In/Out range,
sends the render to the local Sync-X server, saves the returned SRT, and imports
it into a root Premiere project bin named `Sync-X`.

## Requirements

- macOS
- Adobe Premiere Pro 25.6 or newer
- The Sync-X v2.1 server running at `http://127.0.0.1:8765`
- UXP Developer Tool for loading this unpackaged release folder

## Load this release

1. Stop and unload any earlier Sync-X plugin that uses the same production ID.
2. Enable Developer Mode in Premiere Pro.
3. In UXP Developer Tool, add this folder's `manifest.json`.
4. Load the plugin.
5. In Premiere, open **Window → UXP Plugins → Sync-X**.

This is a production-identity replacement build:

- Plugin ID: `com.sridhar.syncx`
- Panel ID: `syncXPanel`
- Version: `2.1.0`

It intentionally cannot run beside another build with the same plugin ID.

## Localhost permission note

On the tested Premiere Pro 26.0.2 macOS build, restricting the manifest to one
plain-HTTP loopback origin blocked requests. The manifest therefore uses
Adobe's `network.domains: "all"` compatibility setting. Runtime requests remain
hard-coded to `http://127.0.0.1:8765`; the panel exposes no configurable or
remote server destination.

## Workflow and storage

1. Open a project and active sequence, then set valid In and Out points.
2. Clear all audio-track Solo buttons.
3. Select one non-empty standard audio track.
4. For Hinglish, enter a Gemini key for the current panel session.
5. Choose the maximum words per caption and select **Generate & Import**.

Results are saved under:

`~/Documents/Sync-X Outputs/<project>/<sequence>/`

The SRT is imported into the root project bin `Sync-X`; it is not placed on the
timeline.

## Safety and privacy

- The panel records all audio-track mute states before isolation and restores
  them after success, failure, or cancellation.
- A panel reload during render is recovered through the private
  `syncx-render-recovery.json` snapshot.
- Cancel waits safely during Premiere rendering, aborts an active upload, or
  requests cancellation from the server during processing.
- Only the active server job ID is persisted under `syncXActiveJobId`.
- The Gemini key remains session-only and is never persisted or logged.

## Packaging note

This folder is ready for UXP Developer Tool loading. A signed CCX installer is
not included and must be created separately with the owner's Adobe signing and
distribution workflow.
