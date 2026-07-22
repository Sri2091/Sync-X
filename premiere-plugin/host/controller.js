(() => {
  "use strict";

  const PROTOCOL_VERSION = 1;
  const ACTIVE_JOB_KEY = "syncXActiveJobId";
  const MAX_SEEN_REQUESTS = 250;
  const WEBVIEW_READY_TIMEOUT_MS = 8000;

  const webview = document.getElementById("syncXWebView");
  const shellError = document.getElementById("shellError");
  const shellErrorMessage = document.getElementById("shellErrorMessage");

  const DEFAULT_OPTIONS = Object.freeze({
    languages: ["Hindi", "English"],
    geminiModels: [],
    defaultGeminiModel: "",
    defaultVocabulary: "",
    maxWords: { minimum: 2, maximum: 20, default: 6 },
    maxDurationSeconds: SyncXState.MAX_DURATION_SECONDS,
  });

  function storageGet(key) {
    try { return localStorage.getItem(key) || ""; } catch { return ""; }
  }

  function storageSet(key, value) {
    try { localStorage.setItem(key, value); } catch {}
  }

  function storageRemove(key) {
    try { localStorage.removeItem(key); } catch {}
  }

  const state = {
    initialized: false,
    webviewReady: false,
    context: null,
    language: "Hindi",
    selectedTrackIndex: null,
    options: DEFAULT_OPTIONS,
    optionsLoaded: false,
    serverHealth: null,
    serverReady: false,
    serverBusy: false,
    busy: false,
    finalizing: false,
    refreshPending: false,
    retryPending: false,
    recoveryBlocked: false,
    recoveryRunning: false,
    recoveryMessage: "",
    recoverySequenceName: "",
    cancelRequested: false,
    cancelAfterRender: false,
    uploadAbort: null,
    phase: "Idle",
    progress: 0,
    jobId: storageGet(ACTIVE_JOB_KEY),
    localLogs: [],
    serverLogs: [],
    lastSaved: null,
    result: null,
    lastTerminalState: "",
    fatal: null,
  };

  const seenRequestIds = new Set();
  const seenRequestOrder = [];
  let hostRequestCounter = 0;
  let bridgeReadyTimer = null;

  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  function safeString(value) {
    return value === null || value === undefined ? "" : String(value);
  }

  function now() {
    return new Date().toLocaleTimeString();
  }

  function clampNumber(value, minimum, maximum, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(minimum, Math.min(maximum, Math.round(number)));
  }

  function formatTime(totalSeconds) {
    if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "—";
    const whole = Math.floor(totalSeconds);
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor((whole % 3600) / 60);
    const seconds = whole % 60;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  function formatDuration(totalSeconds) {
    if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "—";
    const whole = Math.floor(totalSeconds);
    if (whole >= 3600) return formatTime(whole);
    const minutes = Math.floor(whole / 60);
    const seconds = whole % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  function normalizeOptions(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const limits = source.max_words && typeof source.max_words === "object"
      ? source.max_words
      : {};
    const minimum = clampNumber(limits.minimum, 1, 100, 2);
    const maximum = clampNumber(limits.maximum, minimum, 100, 20);
    return {
      languages: Array.isArray(source.languages) && source.languages.length
        ? source.languages.map(safeString)
        : [...DEFAULT_OPTIONS.languages],
      geminiModels: Array.isArray(source.gemini_models)
        ? source.gemini_models.map(safeString).filter(Boolean)
        : [],
      defaultGeminiModel: safeString(source.default_gemini_model),
      defaultVocabulary: safeString(source.default_vocabulary),
      maxWords: {
        minimum,
        maximum,
        default: clampNumber(limits.default, minimum, maximum, 6),
      },
      maxDurationSeconds: clampNumber(
        source.max_duration_seconds,
        1,
        SyncXState.MAX_DURATION_SECONDS,
        SyncXState.MAX_DURATION_SECONDS
      ),
    };
  }

  function serializedContext() {
    const context = state.context;
    if (!context) return null;
    let sequenceInfo = `${context.projectName} · ${context.sequenceName} · ${context.tracks.length} audio track(s)`;
    if (!context.rangeIsValid || context.durationSeconds <= 0) {
      sequenceInfo = "Set valid sequence In and Out points.";
    } else if (context.durationSeconds > SyncXState.MAX_DURATION_SECONDS) {
      sequenceInfo = "The sequence In/Out range exceeds 30 minutes.";
    }
    return {
      projectName: context.projectName,
      sequenceName: context.sequenceName,
      sequenceGuid: context.sequenceGuid,
      inSeconds: context.inSeconds,
      outSeconds: context.outSeconds,
      durationSeconds: context.durationSeconds,
      rangeIsValid: context.rangeIsValid,
      inTime: formatTime(context.inSeconds),
      outTime: formatTime(context.outSeconds),
      durationTime: context.rangeIsValid ? formatDuration(context.durationSeconds) : "—",
      sequenceInfo,
      tracks: (context.tracks || []).map((track) => ({
        index: Number(track.index),
        id: safeString(track.id),
        name: safeString(track.name),
        clipCount: Number(track.clipCount) || 0,
        muted: Boolean(track.muted),
        disabled: Number(track.clipCount) < 1,
        label: `A${Number(track.index) + 1} — ${track.name} · ${track.clipCount} clip${track.clipCount === 1 ? "" : "s"}${track.muted ? " · muted" : ""}`,
      })),
    };
  }

  function serverSnapshot() {
    let status = "offline";
    let label = "Offline";
    if (state.serverHealth && !state.serverReady) {
      status = "needs_setup";
      label = "Needs setup";
    } else if (state.serverReady && state.serverBusy) {
      status = "busy";
      label = "Busy";
    } else if (state.serverReady) {
      status = "ready";
      label = "Ready";
    }
    return {
      status,
      label,
      ready: state.serverReady,
      busy: state.serverBusy,
      raw: state.serverHealth,
    };
  }

  function allLogs() {
    return [...state.localLogs, ...state.serverLogs].slice(-120);
  }

  function snapshot() {
    const controls = SyncXState.deriveControls(state);
    return {
      version: PROTOCOL_VERSION,
      uiState: SyncXState.deriveUiState(state),
      server: serverSnapshot(),
      context: serializedContext(),
      form: {
        language: state.language,
        selectedTrackIndex: state.selectedTrackIndex,
        options: state.options,
        optionsLoaded: state.optionsLoaded,
      },
      controls,
      progress: {
        phase: state.phase,
        label: state.phase.toLowerCase() === "idle" ? "Ready to generate" : state.phase,
        value: state.progress,
      },
      recovery: {
        blocked: state.recoveryBlocked,
        running: state.recoveryRunning,
        message: state.recoveryMessage,
        sequenceName: state.recoverySequenceName,
      },
      result: state.result,
      logs: allLogs(),
      fatal: state.fatal,
    };
  }

  function nextHostRequestId() {
    hostRequestCounter += 1;
    return `host-${Date.now()}-${hostRequestCounter}`;
  }

  function post(type, payload, responseRequestId = "") {
    if (!state.webviewReady || !webview || typeof webview.postMessage !== "function") return;
    try {
      webview.postMessage({
        version: PROTOCOL_VERSION,
        type,
        requestId: safeString(responseRequestId) || nextHostRequestId(),
        payload,
      });
    } catch (error) {
      showShellError(`The Sync-X interface stopped responding. ${safeString(error.message)}`);
    }
  }

  function publishState() {
    post("STATE", snapshot());
  }

  function publishOptions() {
    post("OPTIONS", {
      options: state.options,
      optionsLoaded: state.optionsLoaded,
    });
  }

  function publishContext() {
    post("CONTEXT", { context: serializedContext() });
  }

  function publishProgress() {
    post("PROGRESS", {
      progress: {
        phase: state.phase,
        label: state.phase.toLowerCase() === "idle" ? "Ready to generate" : state.phase,
        value: state.progress,
      },
    });
  }

  function publishLogs(reveal = false) {
    post("LOGS", { logs: allLogs(), reveal: Boolean(reveal) });
  }

  function publishResult() {
    post("RESULT", { result: state.result });
  }

  function setProgress(phase, value) {
    state.phase = safeString(phase) || "Idle";
    state.progress = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    publishProgress();
    publishState();
  }

  function addLog(message, kind = "", reveal = false) {
    if (!message) return;
    state.localLogs.push(`[${now()}]${kind ? ` ${kind}` : ""} ${message}`);
    state.localLogs = state.localLogs.slice(-200);
    publishLogs(reveal || kind === "✕");
    publishState();
  }

  function clearLogs() {
    state.localLogs = [];
    state.serverLogs = [];
    publishLogs(false);
    publishState();
  }

  async function pasteApiKeyFromClipboard(requestId) {
    let clipboardText = "";
    let error = "";
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.getContent !== "function") {
        throw new Error("Clipboard API unavailable");
      }
      const clipboardData = await navigator.clipboard.getContent();
      clipboardText = safeString(clipboardData && clipboardData["text/plain"]);
      if (!clipboardText) error = "The clipboard does not contain text.";
    } catch {
      error = "Cmd+V is unavailable. Use right-click Paste.";
    }

    post("CLIPBOARD_TEXT", {
      text: clipboardText,
      error,
    }, requestId);
    clipboardText = "";
  }

  function showShellError(message) {
    if (shellErrorMessage) {
      shellErrorMessage.textContent = safeString(message)
        || "Reload the plugin from UXP Developer Tool. Sync-X requires Premiere Pro 25.6 or newer.";
    }
    if (shellError) shellError.classList.add("visible");
  }

  function hideShellError() {
    if (shellError) shellError.classList.remove("visible");
  }

  function clearBridgeTimer() {
    if (bridgeReadyTimer != null) {
      clearTimeout(bridgeReadyTimer);
      bridgeReadyTimer = null;
    }
  }

  function armBridgeTimer() {
    clearBridgeTimer();
    bridgeReadyTimer = setTimeout(() => {
      if (!state.webviewReady) {
        showShellError("The local Sync-X interface did not finish loading. Reload the plugin from UXP Developer Tool.");
      }
    }, WEBVIEW_READY_TIMEOUT_MS);
  }

  function setFatal(message) {
    state.fatal = safeString(message) || "Sync-X could not start.";
    post("FATAL_ERROR", { message: state.fatal });
    publishState();
    if (!state.webviewReady) showShellError(state.fatal);
  }

  function rememberRequest(requestId) {
    if (seenRequestIds.has(requestId)) return false;
    seenRequestIds.add(requestId);
    seenRequestOrder.push(requestId);
    if (seenRequestOrder.length > MAX_SEEN_REQUESTS) {
      const oldest = seenRequestOrder.shift();
      seenRequestIds.delete(oldest);
    }
    return true;
  }

  function parseMessage(data) {
    let parsed = data;
    if (typeof parsed === "string") {
      try { parsed = JSON.parse(parsed); } catch { return null; }
    }
    if (!parsed || typeof parsed !== "object") return null;
    if (Number(parsed.version) !== PROTOCOL_VERSION) return null;
    if (!safeString(parsed.type)) return null;
    const requestId = safeString(parsed.requestId);
    if (!requestId || requestId.length > 160) return null;
    return {
      type: safeString(parsed.type).toUpperCase(),
      requestId,
      payload: parsed.payload && typeof parsed.payload === "object" ? parsed.payload : {},
    };
  }

  function absorbNonSecretForm(payload) {
    const source = payload && payload.form && typeof payload.form === "object"
      ? payload.form
      : payload;
    if (!source || typeof source !== "object") return;
    if (source.language === "English" || source.language === "Hindi") {
      state.language = source.language;
    }
    if (source.selectedTrackIndex != null || source.trackIndex != null) {
      const number = Number(source.selectedTrackIndex ?? source.trackIndex);
      if (Number.isInteger(number) && number >= 0) state.selectedTrackIndex = number;
    }
  }

  async function refreshServer(logFailure = true) {
    const wasAvailable = Boolean(state.serverHealth);
    try {
      const [health, options] = await Promise.all([
        SyncXServer.health(),
        SyncXServer.options(),
      ]);
      state.serverHealth = health;
      state.serverReady = Boolean(health && health.status === "ready");
      state.serverBusy = Boolean(health && health.busy);
      state.options = normalizeOptions(options);
      state.optionsLoaded = true;
      publishOptions();
      publishState();
      return health;
    } catch (error) {
      state.serverHealth = null;
      state.serverReady = false;
      state.serverBusy = false;
      if (logFailure && (wasAvailable || state.localLogs.length === 0)) {
        addLog(`Server unavailable at ${SyncXServer.BASE_URL}: ${error.message}`, "⚠");
      } else {
        publishState();
      }
      return null;
    }
  }

  async function refreshPremiere() {
    try {
      const previous = state.selectedTrackIndex;
      const context = await SyncXPremiere.getContext();
      state.context = context;
      const previousTrack = context.tracks.find(
        (track) => Number(track.index) === Number(previous) && track.clipCount > 0
      );
      const firstTrack = context.tracks.find((track) => track.clipCount > 0);
      state.selectedTrackIndex = previousTrack
        ? previousTrack.index
        : (firstTrack ? firstTrack.index : null);

      if (!context.rangeIsValid || context.durationSeconds <= 0) {
        addLog("Set valid sequence In and Out points.", "⚠");
      } else if (context.durationSeconds > SyncXState.MAX_DURATION_SECONDS) {
        addLog("The sequence In/Out range exceeds 30 minutes.", "⚠");
      }
      publishContext();
      publishState();
      return context;
    } catch (error) {
      state.context = null;
      state.selectedTrackIndex = null;
      addLog(error.message, "⚠");
      publishContext();
      publishState();
      return null;
    }
  }

  async function attemptRecovery(showSuccess) {
    const pending = await SyncXPremiere.readRecovery();
    if (!pending) {
      state.recoveryBlocked = false;
      state.recoveryMessage = "";
      state.recoverySequenceName = "";
      publishState();
      return;
    }

    state.recoverySequenceName = safeString(pending.sequenceName);
    try {
      const result = await SyncXPremiere.restoreCurrentSequence();
      if (result.status === "restored") {
        await SyncXPremiere.deleteTempRender(result.tempPath);
        state.recoveryBlocked = false;
        state.recoveryMessage = "";
        state.recoverySequenceName = "";
        if (showSuccess) {
          addLog(`Restored audio-track states for ${result.sequenceName}.`, "✓");
        }
      } else if (result.status === "wrong_sequence") {
        state.recoveryBlocked = true;
        state.recoverySequenceName = safeString(result.sequenceName);
        state.recoveryMessage = `Open sequence “${result.sequenceName}”, then restore its interrupted render state.`;
      }
    } catch (error) {
      state.recoveryBlocked = true;
      state.recoveryMessage = error.message || String(error);
    }
    publishState();
  }

  async function refreshAll(payload = {}, initial = false) {
    if (state.refreshPending || state.busy || state.recoveryRunning || state.retryPending) return;
    absorbNonSecretForm(payload);
    state.refreshPending = true;
    publishState();
    try {
      await attemptRecovery(false);
      await Promise.all([refreshServer(true), refreshPremiere()]);
    } finally {
      state.refreshPending = false;
      if (initial) state.initialized = true;
      publishState();
    }
    if (!initial && state.jobId && !state.busy) await resumeActiveJob();
  }

  async function recover() {
    if (state.recoveryRunning || state.busy || state.refreshPending) return;
    state.recoveryRunning = true;
    publishState();
    try {
      await attemptRecovery(true);
      await refreshPremiere();
    } finally {
      state.recoveryRunning = false;
      publishState();
    }
  }

  function normalizeJobInput(payload) {
    const source = payload && payload.form && typeof payload.form === "object"
      ? payload.form
      : payload;
    const language = source.language === "English" ? "English" : "Hindi";
    const limits = state.options.maxWords || DEFAULT_OPTIONS.maxWords;
    const publicForm = Object.freeze({
      trackIndex: Number(source.trackIndex ?? source.selectedTrackIndex),
      language,
      geminiModel: safeString(source.geminiModel) || state.options.defaultGeminiModel,
      vocabPrompt: safeString(source.vocabPrompt),
      maxWords: clampNumber(source.maxWords, limits.minimum, limits.maximum, limits.default),
    });
    return {
      form: publicForm,
      geminiKey: language === "Hindi" ? safeString(source.geminiKey).trim() : "",
    };
  }

  function validateJob(context, track, form, geminiKey) {
    if (!context) throw new Error("Refresh the active sequence first.");
    if (!Number.isInteger(form.trackIndex) || !track || track.clipCount < 1) {
      throw new Error("Choose a non-empty audio track.");
    }
    if (!context.rangeIsValid || context.durationSeconds <= 0) {
      throw new Error("Set valid sequence In and Out points.");
    }
    if (context.durationSeconds > SyncXState.MAX_DURATION_SECONDS) {
      throw new Error("The selected range exceeds 30 minutes.");
    }
    if (form.language === "Hindi" && !geminiKey) {
      throw new Error("Enter a Gemini API key for Hindi mode.");
    }
  }

  function clearActiveJob() {
    state.jobId = "";
    storageRemove(ACTIVE_JOB_KEY);
  }

  function isMissingJobError(error) {
    const message = safeString(error && error.message ? error.message : error);
    return /\b404\b|not found|unknown job|job[^.]*missing/i.test(message);
  }

  async function bestEffortDeleteJob(jobId) {
    if (!jobId) return;
    try { await SyncXServer.cancelOrDelete(jobId); } catch {}
  }

  function showResult(saved, job, imported, errorMessage = "") {
    state.result = {
      title: imported ? "SRT imported" : "SRT saved",
      summary: imported
        ? `${job.caption_count} captions added to the Sync-X project bin.`
        : `${job.caption_count} captions saved. ${errorMessage}`,
      path: saved.nativePath,
      retry: !imported,
      imported: Boolean(imported),
      captionCount: Number(job.caption_count) || 0,
    };
    publishResult();
    publishState();
  }

  async function finalizeJob(job) {
    state.finalizing = true;
    publishState();
    setProgress("Saving SRT", 96);
    const srtText = await SyncXServer.getResult(job.job_id);
    const api = require("premierepro");
    const project = await api.Project.getActiveProject();
    const existingNames = project ? await SyncXPremiere.listResultBinNames(project) : [];
    const saved = await SyncXStorage.saveResult(srtText, job.metadata, existingNames);
    state.lastSaved = {
      ...saved,
      metadata: job.metadata,
      captionCount: job.caption_count,
      jobId: job.job_id,
    };
    addLog(`Saved ${saved.filename}.`, "✓");
    try {
      await SyncXPremiere.importSrt(saved.nativePath, job.metadata.project_name);
      addLog("Imported SRT into the Sync-X project bin.", "✓");
      await bestEffortDeleteJob(job.job_id);
      clearActiveJob();
      showResult(saved, job, true);
      state.lastTerminalState = "";
      setProgress("Complete", 100);
    } catch (error) {
      showResult(saved, job, false, error.message);
      setProgress("Saved — import needs retry", 100);
      addLog(`Import failed: ${error.message}`, "⚠", true);
    }
  }

  async function monitorJob(jobId) {
    state.busy = true;
    publishState();
    while (state.jobId === jobId) {
      const job = await SyncXServer.getJob(jobId);
      state.serverLogs = Array.isArray(job.logs) ? job.logs.map(safeString) : [];
      publishLogs(false);
      const phase = safeString(job.phase || job.state || "processing").replace(/_/g, " ");
      setProgress(phase, 45 + (Number(job.progress || 0) * 0.5));
      if (job.state === "complete") {
        await finalizeJob(job);
        return;
      }
      if (job.state === "failed") {
        const message = job.error || "Server processing failed.";
        await bestEffortDeleteJob(jobId);
        clearActiveJob();
        throw new Error(message);
      }
      if (job.state === "cancelled") {
        clearActiveJob();
        state.lastTerminalState = "cancelled";
        addLog("Server job cancelled.", "⚠");
        setProgress("Cancelled", 0);
        return;
      }
      await sleep(1000);
    }
  }

  async function generate(payload) {
    if (state.busy || state.refreshPending || state.recoveryRunning || state.retryPending) return;

    const normalized = normalizeJobInput(payload);
    const form = normalized.form;
    let geminiKey = normalized.geminiKey;
    normalized.geminiKey = "";
    try {
      if (payload && typeof payload === "object") {
        if (Object.prototype.hasOwnProperty.call(payload, "geminiKey")) payload.geminiKey = "";
        if (payload.form && typeof payload.form === "object"
          && Object.prototype.hasOwnProperty.call(payload.form, "geminiKey")) {
          payload.form.geminiKey = "";
        }
      }
    } catch {}
    state.language = form.language;
    state.selectedTrackIndex = form.trackIndex;

    const controls = SyncXState.deriveControls(state);
    if (!controls.generateBaseEnabled) {
      geminiKey = "";
      addLog("Sync-X is not ready to generate. Refresh the server and sequence, then check the selected range.", "✕", true);
      return;
    }
    if (form.language === "Hindi" && !geminiKey) {
      addLog("Enter a Gemini API key for Hindi mode.", "✕", true);
      return;
    }

    state.result = null;
    state.lastSaved = null;
    state.localLogs = [];
    state.serverLogs = [];
    state.cancelRequested = false;
    state.cancelAfterRender = false;
    state.lastTerminalState = "";
    state.busy = true;
    publishResult();
    publishLogs(false);
    publishState();

    let temp = null;
    let context = null;
    let renderSnapshot = null;
    try {
      await refreshServer(false);
      if (!state.serverReady) throw new Error("Start the localhost server before generating.");
      if (state.serverBusy) throw new Error("The localhost server is already processing another job.");

      context = await SyncXPremiere.getContext();
      state.context = context;
      const selected = context.tracks.find((track) => track.index === form.trackIndex);
      validateJob(context, selected, form, geminiKey);
      publishContext();

      setProgress("Preparing Premiere render", 5);
      addLog(`Selected A${form.trackIndex + 1} — ${selected.name}`);
      addLog(`Range ${formatTime(context.inSeconds)} to ${formatTime(context.outSeconds)}`);
      temp = await SyncXPremiere.createTempRender();
      renderSnapshot = await SyncXPremiere.isolateSelectedTrack(context, form.trackIndex, temp.nativePath);
      addLog("Other audio tracks muted for isolated render.");

      try {
        setProgress("Rendering selected track", 15);
        await SyncXPremiere.renderSelectedRange(context, temp, (size) => {
          setProgress("Rendering selected track", Math.min(35, 15 + size / 1024 / 1024));
        });
        addLog("Premiere audio render complete.", "✓");
      } finally {
        if (renderSnapshot) {
          await SyncXPremiere.restoreSnapshotWithContext(context, renderSnapshot);
          renderSnapshot = null;
          addLog("Original audio-track mute states restored.", "✓");
        }
      }

      if (state.cancelAfterRender || state.cancelRequested) {
        state.lastTerminalState = "cancelled";
        addLog("Cancelled after Premiere render.", "⚠");
        setProgress("Cancelled", 0);
        return;
      }

      setProgress("Reading rendered audio", 38);
      const bytes = await SyncXPremiere.readRenderedFile(temp);
      if (state.cancelAfterRender || state.cancelRequested) {
        state.lastTerminalState = "cancelled";
        addLog("Cancelled before upload.", "⚠");
        setProgress("Cancelled", 0);
        return;
      }

      state.uploadAbort = new AbortController();
      setProgress("Uploading to localhost", 42);
      const sourceFilename = `${SyncXStorage.safeSegment(context.sequenceName, "Sequence")}_${SyncXStorage.safeSegment(selected.name, `A${form.trackIndex + 1}`)}.mp3`;
      let created;
      try {
        created = await SyncXServer.createJob(
          bytes,
          sourceFilename,
          {
            language: form.language,
            gemini_model: form.geminiModel,
            vocab_prompt: form.vocabPrompt,
            max_words: form.maxWords,
            timeline_offset_ms: Math.round(context.inSeconds * 1000),
            project_name: context.projectName,
            sequence_name: context.sequenceName,
            track_name: `A${form.trackIndex + 1} ${selected.name}`,
            source_filename: sourceFilename,
          },
          geminiKey,
          state.uploadAbort.signal
        );
      } finally {
        geminiKey = "";
      }
      state.uploadAbort = null;
      state.jobId = created.job_id;
      storageSet(ACTIVE_JOB_KEY, state.jobId);
      addLog(`Server job ${state.jobId.slice(0, 8)} accepted.`, "✓");
      await SyncXPremiere.deleteTempRender(temp);
      temp = null;
      await monitorJob(state.jobId);
    } catch (error) {
      if (isMissingJobError(error)) clearActiveJob();
      const cancelled = state.cancelRequested || (error && error.name === "AbortError");
      state.lastTerminalState = cancelled ? "cancelled" : "failed";
      if (cancelled) {
        addLog(error && error.name === "AbortError" ? "Upload cancelled." : "Cancelled.", "⚠");
        setProgress("Cancelled", 0);
      } else {
        addLog(error.message || String(error), "✕", true);
        setProgress("Failed", 0);
      }
    } finally {
      geminiKey = "";
      state.uploadAbort = null;
      state.finalizing = false;
      if (renderSnapshot && context) {
        try {
          await SyncXPremiere.restoreSnapshotWithContext(context, renderSnapshot);
          addLog("Original audio-track mute states restored after error.", "✓");
        } catch (restoreError) {
          state.recoveryBlocked = true;
          state.recoveryMessage = restoreError.message;
          state.recoverySequenceName = context.sequenceName;
          addLog(`Recovery required: ${restoreError.message}`, "✕", true);
        }
      }
      if (temp) await SyncXPremiere.deleteTempRender(temp);
      try {
        const pendingRecovery = await SyncXPremiere.readRecovery();
        if (pendingRecovery) {
          state.recoveryBlocked = true;
          state.recoverySequenceName = safeString(pendingRecovery.sequenceName);
          state.recoveryMessage = `Open sequence “${pendingRecovery.sequenceName}”, then restore its interrupted render state.`;
        }
      } catch {}
      state.busy = false;
      state.cancelRequested = false;
      state.cancelAfterRender = false;
      publishState();
      await refreshServer(false);
    }
  }

  async function cancel() {
    if (!state.busy || state.cancelRequested || state.finalizing) return;
    state.cancelRequested = true;
    publishState();

    const phase = state.phase.toLowerCase();
    if (phase.includes("render") || phase.includes("preparing") || phase.includes("reading")) {
      state.cancelAfterRender = true;
      addLog("Cancel requested. Premiere will finish this render, restore tracks, then stop.", "⚠");
      return;
    }
    if (state.uploadAbort) {
      addLog("Cancelling upload…", "⚠");
      state.uploadAbort.abort();
      return;
    }
    if (state.jobId) {
      try {
        await SyncXServer.cancelOrDelete(state.jobId);
        addLog("Cancellation sent to server…", "⚠");
      } catch (error) {
        state.cancelRequested = false;
        addLog(`Cancellation failed: ${error.message}`, "✕", true);
        publishState();
      }
      return;
    }

    state.cancelAfterRender = true;
    addLog("Cancellation requested.", "⚠");
  }

  async function retryImport() {
    if (!state.lastSaved || state.retryPending || state.busy) return;
    state.retryPending = true;
    publishState();
    try {
      await SyncXPremiere.importSrt(
        state.lastSaved.nativePath,
        state.lastSaved.metadata.project_name
      );
      addLog("Imported saved SRT into the Sync-X project bin.", "✓");
      if (state.lastSaved.jobId) await bestEffortDeleteJob(state.lastSaved.jobId);
      clearActiveJob();
      state.result = {
        title: "SRT imported",
        summary: `${state.lastSaved.captionCount} captions added to the Sync-X project bin.`,
        path: state.lastSaved.nativePath,
        retry: false,
        imported: true,
        captionCount: Number(state.lastSaved.captionCount) || 0,
      };
      state.lastTerminalState = "";
      setProgress("Complete", 100);
      publishResult();
    } catch (error) {
      addLog(`Retry failed: ${error.message}`, "✕", true);
    } finally {
      state.retryPending = false;
      publishState();
    }
  }

  async function resumeActiveJob() {
    if (!state.jobId || state.busy) return;
    const jobId = state.jobId;
    addLog(`Reconnecting to server job ${jobId.slice(0, 8)}…`);
    state.busy = true;
    state.lastTerminalState = "";
    publishState();
    try {
      await monitorJob(jobId);
    } catch (error) {
      if (isMissingJobError(error)) {
        clearActiveJob();
        addLog("The previous server job no longer exists. Its saved job reference was cleared.", "⚠");
      }
      state.lastTerminalState = "failed";
      addLog(`Could not resume job: ${error.message}`, "✕", true);
    } finally {
      state.finalizing = false;
      state.busy = false;
      state.cancelRequested = false;
      publishState();
      await refreshServer(false);
    }
  }

  function sendFullHydration() {
    publishState();
    publishOptions();
    publishContext();
    publishProgress();
    publishLogs(false);
    if (state.result) publishResult();
    if (state.fatal) post("FATAL_ERROR", { message: state.fatal });
  }

  async function dispatchCommand(message) {
    switch (message.type) {
      case "WEB_READY":
        state.webviewReady = true;
        clearBridgeTimer();
        hideShellError();
        sendFullHydration();
        return;
      case "REFRESH":
        await refreshAll(message.payload, false);
        return;
      case "GENERATE":
        await generate(message.payload);
        return;
      case "CANCEL":
        await cancel();
        return;
      case "RECOVER":
        await recover();
        return;
      case "RETRY_IMPORT":
        await retryImport();
        return;
      case "CLEAR_LOGS":
        clearLogs();
        return;
      case "PASTE_API_KEY":
        await pasteApiKeyFromClipboard(message.requestId);
        return;
      default:
        return;
    }
  }

  function handleMessage(event) {
    if (!webview || event.source !== webview) return;
    const message = parseMessage(event.data);
    if (!message || !rememberRequest(message.requestId)) return;
    dispatchCommand(message).catch((error) => {
      addLog(`Command failed: ${error.message || String(error)}`, "✕", true);
    });
  }

  function bindShell() {
    if (!webview) {
      showShellError("Sync-X is missing its WebView shell. Reload the complete plugin folder.");
      return false;
    }
    window.addEventListener("message", handleMessage);
    webview.addEventListener("loadstart", () => {
      state.webviewReady = false;
      hideShellError();
      armBridgeTimer();
    });
    webview.addEventListener("loadstop", () => {
      hideShellError();
      armBridgeTimer();
    });
    webview.addEventListener("loaderror", (event) => {
      state.webviewReady = false;
      clearBridgeTimer();
      const detail = safeString(event && event.message);
      showShellError(`The local Sync-X interface failed to load${detail ? `: ${detail}` : "."}`);
    });
    armBridgeTimer();
    return true;
  }

  async function initialize() {
    if (!bindShell()) return;
    setProgress("Idle", 0);
    try {
      await refreshAll({}, true);
      await resumeActiveJob();
    } catch (error) {
      state.initialized = true;
      setFatal(error.message || String(error));
    } finally {
      state.initialized = true;
      publishState();
    }
  }

  initialize().catch((error) => setFatal(error.message || String(error)));
})();
