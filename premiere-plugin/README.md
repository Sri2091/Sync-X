# Hinglish SRT — Premiere Pro UXP Prototype

Fresh UXP panel for Premiere Pro 25.6+ that renders one sequence audio track over the current In/Out range, sends it to the local Hinglish SRT Server, and imports the returned SRT into the project.

## Prototype setup

1. Start the packaged server with `../server/run.command`.
2. Enable **Developer Mode** in Premiere Pro settings under Plugins.
3. In Adobe UXP Developer Tool, choose **Add Plugin** and select this folder's `manifest.json`.
4. Load the plugin, then open **Window → UXP Plugins → Hinglish SRT**.

## Workflow

1. Open a project and sequence.
2. Set sequence In and Out points (maximum 30 minutes).
3. Clear all track Solo buttons.
4. Refresh the panel and select one non-empty standard audio track.
5. Choose Hindi or English and set the transcription options.
6. For Hindi, enter the Gemini key. It remains only in panel memory and clears when the panel reloads.
7. Click **Generate & Import**.

The result is saved under `~/Documents/Hinglish SRT Outputs/<project>/<sequence>/` and imported into a project bin named `Hinglish SRT`. It is not placed on the timeline.

## Safety and prototype boundaries

- The panel snapshots every audio-track mute state before isolation and restores it after render, including after handled failures.
- If Premiere or the panel stops mid-render, reopen the same sequence and use **Restore Track States**.
- A render-phase Cancel finishes the current Premiere render, restores mute states, and stops before upload.
- Standard audio tracks are supported. Submix routing is not guaranteed.
- Master-bus effects remain baked into the audio sent for transcription.
- Do not change track mute states while the panel is rendering.
- Premiere UXP on this macOS build rejects plain-HTTP loopback requests when the manifest uses a host-specific domain list. The manifest therefore uses the same `network.domains: "all"` setting as the working reference panel; application code remains hardcoded to `http://127.0.0.1:8765` and sends no requests to any other host.
