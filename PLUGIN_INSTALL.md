# Premiere plugin location and loading

## Where the plugin folder goes

Keep or copy the complete `premiere-plugin` folder to a stable location. A
simple recommended location is:

```text
~/Documents/Adobe/UXP/Plugins/HinglishSRT
```

Do not put it in an old CEP `extensions` folder. This v1 package is a UXP source
plugin and is loaded through Adobe UXP Developer Tool.

If you copy it to the recommended location, copy the whole folder so that
`manifest.json`, `index.html`, `ui/`, `lib/`, and `presets/` remain together.

## Load it in Premiere

1. Open Premiere Pro 25.6 or newer.
2. Enable **Developer Mode** in Premiere Pro's Plugins preferences.
3. Open Adobe UXP Developer Tool and connect it to Premiere.
4. Click **Add Plugin**.
5. Select the `manifest.json` inside the stable `premiere-plugin` folder.
6. Click **Load** or **Load & Watch**.
7. In Premiere, open **Window → UXP Plugins → Hinglish SRT**.

Start `server/run.command` before generating subtitles.

For normal distribution later, package the panel as a `.ccx` with UXP
Developer Tool. This v1 repository intentionally keeps the editable source
folder instead.
