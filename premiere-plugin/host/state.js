(function attachSyncXState(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SyncXState = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const MAX_DURATION_SECONDS = 30 * 60;

  function selectedTrack(state) {
    if (!state.context || state.selectedTrackIndex == null) return null;
    return (state.context.tracks || []).find(
      (track) => Number(track.index) === Number(state.selectedTrackIndex)
    ) || null;
  }

  function hasValidRange(context) {
    return Boolean(
      context
      && context.rangeIsValid
      && Number(context.durationSeconds) > 0
      && Number(context.durationSeconds) <= MAX_DURATION_SECONDS
    );
  }

  function deriveControls(state) {
    const track = selectedTrack(state);
    const validTrack = Boolean(track && Number(track.clipCount) > 0);
    const locked = Boolean(
      !state.initialized
      || state.busy
      || state.recoveryRunning
      || state.retryPending
    );
    const retryRequired = Boolean(state.result && state.result.retry);
    const generateBaseEnabled = Boolean(
      !locked
      && !state.refreshPending
      && !state.cancelRequested
      && state.serverReady
      && !state.serverBusy
      && validTrack
      && hasValidRange(state.context)
      && !state.recoveryBlocked
      && !retryRequired
      && !state.jobId
      && !state.fatal
    );

    return {
      formLocked: locked,
      generateBaseEnabled,
      keyRequired: state.language === "Hindi",
      cancelVisible: Boolean(state.busy),
      cancelEnabled: Boolean(
        state.busy
        && !state.cancelRequested
        && !state.finalizing
      ),
      cancelLabel: state.finalizing
        ? "Finishing…"
        : (state.cancelRequested ? "Cancelling…" : "Cancel"),
      refreshEnabled: Boolean(
        state.initialized
        && !state.busy
        && !state.refreshPending
        && !state.recoveryRunning
        && !state.retryPending
        && !state.fatal
      ),
      refreshSpinning: Boolean(state.refreshPending),
      recoveryVisible: Boolean(state.recoveryBlocked),
      recoveryEnabled: Boolean(
        state.recoveryBlocked
        && !state.busy
        && !state.refreshPending
        && !state.recoveryRunning
      ),
      recoveryLabel: state.recoveryRunning ? "Restoring…" : "Restore Track States",
      retryVisible: retryRequired,
      retryEnabled: Boolean(
        retryRequired
        && !state.busy
        && !state.refreshPending
        && !state.retryPending
      ),
      retryLabel: state.retryPending ? "Importing…" : "Retry Import",
    };
  }

  function deriveUiState(state) {
    if (state.fatal) return "fatal";
    if (!state.initialized) return "booting";
    if (state.recoveryRunning) return "recovery_running";
    if (state.recoveryBlocked) return "recovery_required";
    if (state.retryPending) return "retrying_import";
    if (state.cancelRequested) return "cancelling";
    if (state.busy) return "busy";
    if (state.result && state.result.retry) return "saved_not_imported";
    if (state.result && state.result.imported) return "imported";
    if (state.lastTerminalState === "failed") return "failed";
    if (state.lastTerminalState === "cancelled") return "cancelled";
    if (!state.serverReady) return "offline";
    if (state.serverBusy) return "server_busy";
    const controls = deriveControls(state);
    return controls.generateBaseEnabled ? "ready" : "invalid";
  }

  function isGenerateEnabled(state, hasGeminiKey) {
    const controls = deriveControls(state);
    return Boolean(
      controls.generateBaseEnabled
      && (!controls.keyRequired || hasGeminiKey)
    );
  }

  return Object.freeze({
    MAX_DURATION_SECONDS,
    selectedTrack,
    hasValidRange,
    deriveControls,
    deriveUiState,
    isGenerateEnabled,
  });
});
