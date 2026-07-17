const HinglishPremiere = (() => {
  const uxp = require("uxp");
  const fs = uxp.storage.localFileSystem;
  const RECOVERY_FILE = "hinglish-render-recovery.json";
  const TICKS_PER_SECOND = 254016000000;

  let _ppro = null;
  function ppro() {
    if (!_ppro) _ppro = require("premierepro");
    return _ppro;
  }

  function seconds(value) {
    if (!value) return 0;
    if (Number.isFinite(value.seconds)) return Number(value.seconds);
    if (Number.isFinite(value.ticks)) return Number(value.ticks) / TICKS_PER_SECOND;
    return 0;
  }

  function guidString(value) {
    if (!value) return "";
    try { return typeof value.toString === "function" ? value.toString() : String(value); }
    catch { return String(value); }
  }

  async function getContext() {
    const api = ppro();
    const project = await api.Project.getActiveProject();
    if (!project) throw new Error("No Premiere project is open.");
    const sequence = await project.getActiveSequence();
    if (!sequence) throw new Error("Open a sequence before using Hinglish SRT.");

    const inPoint = await sequence.getInPoint();
    const outPoint = await sequence.getOutPoint();
    const inSeconds = seconds(inPoint);
    const outSeconds = seconds(outPoint);
    const rangeIsValid = inSeconds >= 0 && outSeconds > inSeconds;
    const count = await sequence.getAudioTrackCount();
    const tracks = [];
    const clipType = api.Constants?.TrackItemType?.CLIP ?? 1;
    for (let index = 0; index < count; index++) {
      const track = await sequence.getAudioTrack(index);
      let items = [];
      try { items = await track.getTrackItems(clipType, false); } catch {}
      let muted = false;
      try { muted = await track.isMuted(); } catch {}
      tracks.push({
        index,
        id: track.id == null ? String(index) : String(track.id),
        name: track.name || `Audio ${index + 1}`,
        clipCount: (items || []).length,
        muted: Boolean(muted),
        track,
      });
    }
    return {
      api,
      project,
      sequence,
      projectName: project.name || "Untitled Project",
      sequenceName: sequence.name || "Untitled Sequence",
      sequenceGuid: guidString(sequence.guid),
      inSeconds,
      outSeconds,
      rangeIsValid,
      durationSeconds: rangeIsValid ? outSeconds - inSeconds : 0,
      tracks,
    };
  }

  async function dataFolder() {
    return fs.getDataFolder();
  }

  async function readRecovery() {
    try {
      const folder = await dataFolder();
      const file = await folder.getEntry(RECOVERY_FILE);
      return JSON.parse(await file.read());
    } catch { return null; }
  }

  async function writeRecovery(snapshot) {
    const folder = await dataFolder();
    const file = await folder.createFile(RECOVERY_FILE, { overwrite: true });
    await file.write(JSON.stringify(snapshot, null, 2));
  }

  async function clearRecovery() {
    try {
      const folder = await dataFolder();
      const file = await folder.getEntry(RECOVERY_FILE);
      await file.delete();
    } catch {}
  }

  async function isolateSelectedTrack(context, selectedIndex, tempPath) {
    const selected = context.tracks.find((item) => item.index === selectedIndex);
    if (!selected) throw new Error("The selected audio track no longer exists.");
    const snapshot = {
      version: 1,
      sequenceGuid: context.sequenceGuid,
      sequenceName: context.sequenceName,
      selectedIndex,
      tempPath,
      createdAt: Date.now(),
      tracks: context.tracks.map((item) => ({
        index: item.index,
        id: item.id,
        muted: item.muted,
      })),
    };
    await writeRecovery(snapshot);
    for (const item of context.tracks) {
      const shouldMute = item.index !== selectedIndex;
      const ok = await item.track.setMute(shouldMute);
      if (ok === false) throw new Error(`Could not set mute state for A${item.index + 1}.`);
    }
    return snapshot;
  }

  async function restoreSnapshotWithContext(context, snapshot) {
    let failed = 0;
    for (const state of snapshot.tracks || []) {
      try {
        const track = await context.sequence.getAudioTrack(state.index);
        if (!track) { failed++; continue; }
        const currentId = track.id == null ? String(state.index) : String(track.id);
        if (state.id != null && currentId !== String(state.id)) { failed++; continue; }
        const ok = await track.setMute(Boolean(state.muted));
        if (ok === false) failed++;
      } catch { failed++; }
    }
    if (failed) throw new Error(`Could not restore ${failed} audio track state(s).`);
    await clearRecovery();
    return snapshot.tempPath || null;
  }

  async function restoreCurrentSequence() {
    const snapshot = await readRecovery();
    if (!snapshot) return { status: "none" };
    const context = await getContext();
    if (context.sequenceGuid !== snapshot.sequenceGuid) {
      return {
        status: "wrong_sequence",
        sequenceName: snapshot.sequenceName,
        tempPath: snapshot.tempPath || null,
      };
    }
    const tempPath = await restoreSnapshotWithContext(context, snapshot);
    return { status: "restored", tempPath, sequenceName: snapshot.sequenceName };
  }

  async function createTempRender() {
    const folder = await fs.getTemporaryFolder();
    const name = `hinglish_track_${Date.now()}_${Math.floor(Math.random() * 100000)}.mp3`;
    return { folder, name, nativePath: `${folder.nativePath}/${name}` };
  }

  async function presetPath() {
    const pluginFolder = await fs.getPluginFolder();
    const preset = await pluginFolder.getEntry("presets/hinglish-audio.epr");
    return preset.nativePath;
  }

  async function waitForStableFile(temp, onProgress, timeoutMs = 15 * 60 * 1000) {
    const started = Date.now();
    let previous = -1;
    let stable = 0;
    while (Date.now() - started < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 750));
      try {
        const file = await temp.folder.getEntry(temp.name);
        const metadata = await file.getMetadata();
        const size = Number(metadata?.size || 0);
        if (size > 0 && size === previous) stable++;
        else stable = 0;
        previous = size;
        if (onProgress && size > 0) onProgress(size);
        if (stable >= 3) return file;
      } catch {}
    }
    throw new Error("Premiere render timed out after 15 minutes.");
  }

  function createEncoderEventWaiter(api, manager) {
    const eventManager = api.EventManager;
    const events = api.Constants?.EncoderEvent;
    if (!eventManager || !events) return null;

    const listeners = [];
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const cleanup = () => {
      for (const [eventName, handler] of listeners) {
        try { eventManager.removeEventListener(manager, eventName, handler); } catch {}
      }
      listeners.length = 0;
    };
    const listen = (eventName, handler) => {
      if (!eventName) return;
      eventManager.addEventListener(manager, eventName, handler, false);
      listeners.push([eventName, handler]);
    };

    try {
      listen(events.RENDER_COMPLETE, () => resolvePromise("complete"));
      listen(events.RENDER_ERROR, () => rejectPromise(new Error("Premiere reported an audio export error.")));
      listen(events.RENDER_CANCEL, () => rejectPromise(new Error("Premiere cancelled the audio export.")));
      if (!listeners.length) return null;
      return { promise, cleanup };
    } catch {
      cleanup();
      return null;
    }
  }

  async function renderSelectedRange(context, temp, onProgress) {
    const api = context.api;
    const manager = await api.EncoderManager.getManager();
    const exportType = api.Constants?.ExportType?.IMMEDIATELY;
    if (exportType == null) throw new Error("Premiere direct export is unavailable on this build.");
    const eventWaiter = createEncoderEventWaiter(api, manager);
    try {
      const accepted = await manager.exportSequence(
        context.sequence,
        exportType,
        temp.nativePath,
        await presetPath(),
        false
      );
      if (accepted === false) throw new Error("Premiere rejected the direct audio export.");

      const stableFile = waitForStableFile(temp, onProgress);
      if (!eventWaiter) return stableFile;
      const firstConfirmation = await Promise.race([
        stableFile.then((file) => ({ type: "stable", file })),
        eventWaiter.promise.then(() => ({ type: "event" })),
      ]);
      return firstConfirmation.type === "stable" ? firstConfirmation.file : stableFile;
    } finally {
      eventWaiter?.cleanup();
    }
  }

  async function readRenderedFile(temp) {
    const file = await temp.folder.getEntry(temp.name);
    const formats = uxp.storage.formats;
    return file.read({ format: formats.binary });
  }

  async function deleteTempRender(tempOrPath) {
    try {
      if (typeof tempOrPath === "string") {
        const file = await fs.getEntryWithUrl("file:" + tempOrPath);
        await file.delete();
      } else if (tempOrPath?.folder && tempOrPath?.name) {
        const file = await tempOrPath.folder.getEntry(tempOrPath.name);
        await file.delete();
      }
    } catch {}
  }

  async function findOrCreateResultBin(project, binName = "Hinglish SRT") {
    const api = ppro();
    const root = await project.getRootItem();
    let items = await root.getItems();
    for (const item of items || []) {
      if (item.name !== binName) continue;
      try { return api.FolderItem.cast(item); } catch {}
    }

    const create = () => {
      const action = root.createBinAction(binName, false);
      const ok = project.executeTransaction((compound) => compound.addAction(action), "Create Hinglish SRT bin");
      if (ok === false) throw new Error("Premiere could not create the Hinglish SRT bin.");
    };
    if (typeof project.lockedAccess === "function") await project.lockedAccess(create);
    else create();

    items = await root.getItems();
    for (const item of items || []) {
      if (item.name !== binName) continue;
      try { return api.FolderItem.cast(item); } catch {}
    }
    throw new Error("Hinglish SRT bin was created but could not be found.");
  }

  async function listResultBinNames(project) {
    try {
      const bin = await findOrCreateResultBin(project);
      const items = await bin.getItems();
      return (items || []).map((item) => item.name).filter(Boolean);
    } catch { return []; }
  }

  async function importSrt(nativePath, expectedProjectName) {
    const api = ppro();
    const project = await api.Project.getActiveProject();
    if (!project) throw new Error("Open the target Premiere project before importing the SRT.");
    const currentName = project.name || "Untitled Project";
    const comparable = (value) => String(value || "")
      .replace(/\.prproj$/i, "")
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/\s+/g, " ")
      .replace(/^[ ._-]+|[ ._-]+$/g, "");
    if (expectedProjectName && comparable(currentName) !== comparable(expectedProjectName)) {
      throw new Error(`Open project “${expectedProjectName}” to import this result.`);
    }
    const bin = await findOrCreateResultBin(project);
    const ok = await project.importFiles([nativePath], true, bin, false);
    if (ok === false) throw new Error("Premiere could not import the SRT file.");
    return { project, bin };
  }

  return {
    seconds,
    getContext,
    readRecovery,
    isolateSelectedTrack,
    restoreSnapshotWithContext,
    restoreCurrentSequence,
    createTempRender,
    renderSelectedRange,
    readRenderedFile,
    deleteTempRender,
    listResultBinNames,
    importSrt,
  };
})();
