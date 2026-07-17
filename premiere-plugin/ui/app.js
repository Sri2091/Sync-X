(() => {
  const ACTIVE_JOB_KEY = "hinglishSrtActiveJobId";
  const MAX_DURATION_SECONDS = 30 * 60;
  const view = window.HinglishView;

  const state = {
    context: null,
    language: "Hindi",
    selectedTrackIndex: null,
    hasGeminiKey: false,
    optionsLoaded: false,
    serverReady: false,
    serverBusy: false,
    busy: false,
    phase: "idle",
    progress: 0,
    cancelAfterRender: false,
    uploadAbort: null,
    jobId: localStorage.getItem(ACTIVE_JOB_KEY) || "",
    localLogs: [],
    serverLogs: [],
    lastSaved: null,
    recoveryBlocked: false,
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function now() {
    return new Date().toLocaleTimeString();
  }

  function addLog(message, kind = "") {
    if (!message) return;
    state.localLogs.push(`[${now()}]${kind ? ` ${kind}` : ""} ${message}`);
    state.localLogs = state.localLogs.slice(-200);
    renderLogs(kind === "✕");
  }

  function renderLogs(reveal = false) {
    view.renderLogs([...state.localLogs, ...state.serverLogs], reveal);
  }

  function setProgress(phase, progress) {
    state.phase = phase;
    state.progress = Math.max(0, Math.min(100, Math.round(progress)));
    view.setProgress(phase, state.progress);
  }

  function setBusy(value) {
    state.busy = Boolean(value);
    view.setBusy(state.busy);
    updateGenerateEnabled();
  }

  function selectedTrack() {
    if (!state.context || state.selectedTrackIndex === null) return null;
    return state.context.tracks.find((track) => track.index === state.selectedTrackIndex) || null;
  }

  function updateGenerateEnabled() {
    const track = selectedTrack();
    const validRange = state.context
      && state.context.rangeIsValid
      && state.context.durationSeconds > 0
      && state.context.durationSeconds <= MAX_DURATION_SECONDS;
    const keyReady = state.language !== "Hindi" || state.hasGeminiKey;
    const enabled = !state.busy
      && state.serverReady
      && !state.serverBusy
      && track
      && track.clipCount > 0
      && validRange
      && !state.recoveryBlocked
      && keyReady;
    view.setGenerateEnabled(Boolean(enabled));
  }

  function setServerBadge(health) {
    view.setServerHealth(health);
    state.serverReady = Boolean(health && health.status === "ready");
    state.serverBusy = Boolean(health && health.busy);
    updateGenerateEnabled();
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

  async function refreshServer() {
    try {
      const [health, options] = await Promise.all([
        HinglishServer.health(),
        HinglishServer.options(),
      ]);
      setServerBadge(health);
      if (!state.optionsLoaded) {
        view.setOptions(options);
        state.optionsLoaded = true;
      }
      return health;
    } catch (error) {
      setServerBadge(null);
      addLog(`Server unavailable at ${HinglishServer.BASE_URL}: ${error.message}`, "⚠");
      return null;
    }
  }

  async function refreshPremiere() {
    try {
      await attemptRecovery(false);
      const previous = state.selectedTrackIndex;
      const context = await HinglishPremiere.getContext();
      state.context = context;
      const previousTrack = context.tracks.find((track) => track.index === previous && track.clipCount > 0);
      const firstTrack = context.tracks.find((track) => track.clipCount > 0);
      state.selectedTrackIndex = previousTrack
        ? previousTrack.index
        : (firstTrack ? firstTrack.index : null);

      let sequenceInfo = `${context.projectName} · ${context.sequenceName} · ${context.tracks.length} audio track(s)`;
      if (!context.rangeIsValid || context.durationSeconds <= 0) {
        sequenceInfo = "Set valid sequence In and Out points.";
        addLog(sequenceInfo, "⚠");
      } else if (context.durationSeconds > MAX_DURATION_SECONDS) {
        sequenceInfo = "The sequence In/Out range exceeds 30 minutes.";
        addLog(sequenceInfo, "⚠");
      }

      state.selectedTrackIndex = view.setPremiereContext(
        context,
        state.selectedTrackIndex,
        {
          inTime: formatTime(context.inSeconds),
          outTime: formatTime(context.outSeconds),
          durationTime: context.rangeIsValid ? formatDuration(context.durationSeconds) : "—",
          sequenceInfo,
        }
      );
      updateGenerateEnabled();
    } catch (error) {
      state.context = null;
      state.selectedTrackIndex = null;
      view.setPremiereError(error.message);
      updateGenerateEnabled();
      addLog(error.message, "⚠");
    }
  }

  function setLanguage(language) {
    state.language = language === "English" ? "English" : "Hindi";
    view.setLanguage(state.language);
    updateGenerateEnabled();
  }

  async function attemptRecovery(showSuccess) {
    const pending = await HinglishPremiere.readRecovery();
    if (!pending) {
      state.recoveryBlocked = false;
      view.setRecovery(false);
      updateGenerateEnabled();
      return;
    }
    try {
      const result = await HinglishPremiere.restoreCurrentSequence();
      if (result.status === "restored") {
        await HinglishPremiere.deleteTempRender(result.tempPath);
        state.recoveryBlocked = false;
        view.setRecovery(false);
        if (showSuccess) addLog(`Restored audio-track states for ${result.sequenceName}.`, "✓");
      } else if (result.status === "wrong_sequence") {
        state.recoveryBlocked = true;
        view.setRecovery(true, `Open sequence “${result.sequenceName}”, then restore its interrupted render state.`);
      }
    } catch (error) {
      state.recoveryBlocked = true;
      view.setRecovery(true, error.message);
    }
    updateGenerateEnabled();
  }

  function validateJob(context, track, input) {
    if (!context) throw new Error("Refresh the active sequence first.");
    if (!track || track.clipCount < 1) throw new Error("Choose a non-empty audio track.");
    if (!context.rangeIsValid || context.durationSeconds <= 0) throw new Error("Set valid sequence In and Out points.");
    if (context.durationSeconds > MAX_DURATION_SECONDS) throw new Error("The selected range exceeds 30 minutes.");
    if (input.language === "Hindi" && !input.geminiKey) {
      throw new Error("Enter a Gemini API key for Hindi mode.");
    }
  }

  async function generate() {
    if (state.busy) return;
    let jobInput = view.getJobInputSnapshot();
    state.language = jobInput.language;
    state.selectedTrackIndex = jobInput.trackIndex;
    view.hideResult();
    state.localLogs = [];
    state.serverLogs = [];
    state.cancelAfterRender = false;
    state.lastSaved = null;
    renderLogs();
    setBusy(true);
    let temp = null;
    let context = null;
    let snapshot = null;
    try {
      await refreshServer();
      if (!state.serverReady) throw new Error("Start the localhost server before generating.");
      if (state.serverBusy) throw new Error("The localhost server is already processing another job.");
      context = await HinglishPremiere.getContext();
      state.context = context;
      const selectedIndex = Number(jobInput.trackIndex);
      const selected = context.tracks.find((track) => track.index === selectedIndex);
      validateJob(context, selected, jobInput);

      setProgress("Preparing Premiere render", 5);
      addLog(`Selected A${selectedIndex + 1} — ${selected.name}`);
      addLog(`Range ${formatTime(context.inSeconds)} to ${formatTime(context.outSeconds)}`);
      temp = await HinglishPremiere.createTempRender();
      snapshot = await HinglishPremiere.isolateSelectedTrack(context, selectedIndex, temp.nativePath);
      addLog("Other audio tracks muted for isolated render.");

      try {
        setProgress("Rendering selected track", 15);
        await HinglishPremiere.renderSelectedRange(context, temp, (size) => {
          setProgress("Rendering selected track", Math.min(35, 15 + size / 1024 / 1024));
        });
        addLog("Premiere audio render complete.", "✓");
      } finally {
        if (snapshot) {
          await HinglishPremiere.restoreSnapshotWithContext(context, snapshot);
          snapshot = null;
          addLog("Original audio-track mute states restored.", "✓");
        }
      }

      if (state.cancelAfterRender) {
        addLog("Cancelled after Premiere render.", "⚠");
        setProgress("Cancelled", 0);
        return;
      }

      setProgress("Reading rendered audio", 38);
      const bytes = await HinglishPremiere.readRenderedFile(temp);
      state.uploadAbort = new AbortController();
      setProgress("Uploading to localhost", 42);
      const sourceFilename = `${HinglishStorage.safeSegment(context.sequenceName, "Sequence")}_${HinglishStorage.safeSegment(selected.name, `A${selectedIndex + 1}`)}.mp3`;
      const created = await HinglishServer.createJob(
        bytes,
        sourceFilename,
        {
          language: jobInput.language,
          gemini_model: jobInput.geminiModel,
          vocab_prompt: jobInput.vocabPrompt,
          max_words: jobInput.maxWords,
          timeline_offset_ms: Math.round(context.inSeconds * 1000),
          project_name: context.projectName,
          sequence_name: context.sequenceName,
          track_name: `A${selectedIndex + 1} ${selected.name}`,
          source_filename: sourceFilename,
        },
        jobInput.language === "Hindi" ? jobInput.geminiKey : "",
        state.uploadAbort.signal
      );
      jobInput = null;
      state.uploadAbort = null;
      state.jobId = created.job_id;
      localStorage.setItem(ACTIVE_JOB_KEY, state.jobId);
      addLog(`Server job ${state.jobId.slice(0, 8)} accepted.`, "✓");
      await HinglishPremiere.deleteTempRender(temp);
      temp = null;
      await monitorJob(state.jobId);
    } catch (error) {
      if (error && error.name === "AbortError") addLog("Upload cancelled.", "⚠");
      else addLog(error.message || String(error), "✕");
      setProgress("Failed", 0);
    } finally {
      jobInput = null;
      state.uploadAbort = null;
      if (snapshot && context) {
        try {
          await HinglishPremiere.restoreSnapshotWithContext(context, snapshot);
          addLog("Original audio-track mute states restored after error.", "✓");
        } catch (restoreError) {
          state.recoveryBlocked = true;
          view.setRecovery(true, restoreError.message);
          addLog(`Recovery required: ${restoreError.message}`, "✕");
        }
      }
      if (temp) await HinglishPremiere.deleteTempRender(temp);
      setBusy(false);
      await refreshServer();
    }
  }

  async function monitorJob(jobId) {
    setBusy(true);
    while (state.jobId === jobId) {
      const job = await HinglishServer.getJob(jobId);
      state.serverLogs = job.logs || [];
      renderLogs();
      const phase = String(job.phase || job.state || "processing").replaceAll("_", " ");
      setProgress(phase, 45 + (Number(job.progress || 0) * 0.5));
      if (job.state === "complete") {
        await finalizeJob(job);
        return;
      }
      if (job.state === "failed") {
        throw new Error(job.error || "Server processing failed.");
      }
      if (job.state === "cancelled") {
        addLog("Server job cancelled.", "⚠");
        localStorage.removeItem(ACTIVE_JOB_KEY);
        state.jobId = "";
        setProgress("Cancelled", 0);
        return;
      }
      await sleep(1000);
    }
  }

  async function finalizeJob(job) {
    setProgress("Saving SRT", 96);
    const srtText = await HinglishServer.getResult(job.job_id);
    const api = require("premierepro");
    const project = await api.Project.getActiveProject();
    const existingNames = project ? await HinglishPremiere.listResultBinNames(project) : [];
    const saved = await HinglishStorage.saveResult(srtText, job.metadata, existingNames);
    state.lastSaved = {
      ...saved,
      metadata: job.metadata,
      captionCount: job.caption_count,
      jobId: job.job_id,
    };
    addLog(`Saved ${saved.filename}.`, "✓");
    try {
      await HinglishPremiere.importSrt(saved.nativePath, job.metadata.project_name);
      addLog("Imported SRT into the Hinglish SRT project bin.", "✓");
      await HinglishServer.cancelOrDelete(job.job_id);
      state.jobId = "";
      localStorage.removeItem(ACTIVE_JOB_KEY);
      showResult(saved, job, true);
      setProgress("Complete", 100);
    } catch (error) {
      showResult(saved, job, false, error.message);
      setProgress("Saved — import needs retry", 100);
      addLog(`Import failed: ${error.message}`, "⚠");
    }
  }

  function showResult(saved, job, imported, errorMessage = "") {
    view.setResult({
      title: imported ? "SRT imported" : "SRT saved",
      summary: imported
        ? `${job.caption_count} captions added to the Hinglish SRT project bin.`
        : `${job.caption_count} captions saved. ${errorMessage}`,
      path: saved.nativePath,
      retry: !imported,
    });
  }

  async function retryImport() {
    if (!state.lastSaved) return;
    try {
      await HinglishPremiere.importSrt(state.lastSaved.nativePath, state.lastSaved.metadata.project_name);
      addLog("Imported saved SRT into the Hinglish SRT project bin.", "✓");
      if (state.lastSaved.jobId) await HinglishServer.cancelOrDelete(state.lastSaved.jobId);
      state.jobId = "";
      localStorage.removeItem(ACTIVE_JOB_KEY);
      view.setImportComplete(`${state.lastSaved.captionCount} captions added to the Hinglish SRT project bin.`);
    } catch (error) {
      addLog(`Retry failed: ${error.message}`, "✕");
    }
  }

  async function cancel() {
    if (!state.busy) return;
    if (state.phase.toLowerCase().includes("render")) {
      state.cancelAfterRender = true;
      addLog("Cancel requested. Premiere will finish this render, restore tracks, then stop.", "⚠");
      view.setCancelEnabled(false);
      return;
    }
    if (state.uploadAbort) {
      state.uploadAbort.abort();
      addLog("Cancelling upload…", "⚠");
      return;
    }
    if (state.jobId) {
      try {
        await HinglishServer.cancelOrDelete(state.jobId);
        addLog("Cancellation sent to server…", "⚠");
      } catch (error) {
        addLog(`Cancellation failed: ${error.message}`, "✕");
      }
    }
  }

  async function resumeActiveJob() {
    if (!state.jobId) return;
    addLog(`Reconnecting to server job ${state.jobId.slice(0, 8)}…`);
    setBusy(true);
    try {
      await monitorJob(state.jobId);
    } catch (error) {
      addLog(`Could not resume job: ${error.message}`, "✕");
      state.jobId = "";
      localStorage.removeItem(ACTIVE_JOB_KEY);
    } finally {
      setBusy(false);
    }
  }

  function bindView() {
    view.initialize({
      onRefresh: async () => {
        await Promise.all([refreshServer(), refreshPremiere()]);
      },
      onRecover: async () => {
        await attemptRecovery(true);
        await refreshPremiere();
      },
      onTrackChange: (trackIndex) => {
        state.selectedTrackIndex = trackIndex;
        updateGenerateEnabled();
      },
      onLanguageChange: setLanguage,
      onGeminiKeyChange: (present) => {
        state.hasGeminiKey = present;
        updateGenerateEnabled();
      },
      onGenerate: generate,
      onCancel: cancel,
      onRetryImport: retryImport,
      onClearLogs: () => {
        state.localLogs = [];
        state.serverLogs = [];
        renderLogs();
      },
    });
  }

  async function initialize() {
    if (!view) throw new Error("The panel view adapter did not load.");
    bindView();
    setLanguage("Hindi");
    setProgress("Idle", 0);
    await attemptRecovery(false);
    await Promise.all([refreshServer(), refreshPremiere()]);
    await resumeActiveJob();
  }

  initialize().catch((error) => {
    if (view && view.showFatal) view.showFatal(error.message || String(error));
  });
})();
