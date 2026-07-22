(function () {
  "use strict";

  var BRIDGE_VERSION = 1;
  var HOST_EVENT_TYPES = [
    "STATE",
    "OPTIONS",
    "CONTEXT",
    "PROGRESS",
    "LOGS",
    "RESULT",
    "CLIPBOARD_TEXT",
    "FATAL_ERROR",
  ];
  var BUSY_STATES = [
    "rendering",
    "uploading",
    "processing",
    "cancelling",
    "recovering",
    "retrying_import",
  ];
  var TERMINAL_STATES = ["ready", "imported", "saved_not_imported", "failed", "cancelled"];
  var refs = {};
  var requestCounter = 0;
  var pendingCommands = new Map();
  var pendingTimers = new Map();
  var previousUiState = "booting";
  var readyRetryTimer = 0;
  var hostHydrated = false;

  var snapshot = {
    version: BRIDGE_VERSION,
    uiState: "booting",
    server: {
      status: "checking",
      label: "Checking…",
      ready: false,
      busy: false,
    },
    context: null,
    form: {
      language: "Hindi",
      selectedTrackIndex: null,
      options: null,
      optionsLoaded: false,
    },
    controls: {
      formLocked: true,
      generateBaseEnabled: false,
      keyRequired: true,
      cancelVisible: false,
      cancelEnabled: false,
      cancelLabel: "Cancel",
      refreshEnabled: false,
      refreshSpinning: false,
      recoveryVisible: false,
      recoveryEnabled: false,
      recoveryLabel: "Restore Track States",
      retryVisible: false,
      retryEnabled: false,
      retryLabel: "Retry Import",
    },
    progress: {
      phase: "idle",
      label: "Ready to generate",
      value: 0,
    },
    recovery: {
      blocked: false,
      running: false,
      message: "",
      sequenceName: "",
    },
    result: null,
    logs: [],
    fatal: null,
  };

  var local = {
    advancedOpen: false,
    logsOpen: false,
    formHydrated: false,
    optionsHydrated: false,
    formDirty: false,
    dirtyFields: {
      language: false,
      selectedTrackIndex: false,
      geminiModel: false,
      vocabPrompt: false,
      maxWords: false,
    },
    geminiKey: "",
    pendingPaste: null,
    pasteNoticeTimer: 0,
    form: {
      language: "Hindi",
      selectedTrackIndex: null,
      geminiModel: "",
      vocabPrompt: "",
      maxWords: 6,
    },
  };

  function requiredElement(id) {
    var element = document.getElementById(id);
    if (!element) throw new Error("Missing WebView element: " + id);
    return element;
  }

  function cacheElements() {
    [
      "app",
      "scrollArea",
      "refreshBtn",
      "serverBadge",
      "serverBadgeLabel",
      "fatalPanel",
      "fatalText",
      "recoveryCard",
      "recoveryText",
      "recoverBtn",
      "sequenceTitle",
      "sequenceMeta",
      "resultLine",
      "resultSummary",
      "resultCard",
      "resultTitle",
      "resultDetail",
      "resultPath",
      "retryImportBtn",
      "trackSelect",
      "inTime",
      "outTime",
      "durationTime",
      "languageGroup",
      "languageHindi",
      "languageEnglish",
      "maxWords",
      "maxWordsValue",
      "advancedToggle",
      "advancedPanel",
      "geminiKeyField",
      "geminiKey",
      "geminiKeyNote",
      "geminiModelField",
      "geminiModel",
      "vocabPrompt",
      "logState",
      "logsToggle",
      "logsPanel",
      "logs",
      "clearLogsBtn",
      "progressRow",
      "footerSpinner",
      "phaseLabel",
      "progressValue",
      "generateBtn",
      "cancelBtn",
    ].forEach(function (id) {
      refs[id] = requiredElement(id);
    });
  }

  function safeString(value) {
    return value === null || value === undefined ? "" : String(value);
  }

  function finiteNumber(value, fallback) {
    var number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function clamp(value, minimum, maximum, fallback) {
    var number = finiteNumber(value, fallback);
    return Math.max(minimum, Math.min(maximum, number));
  }

  function hasOwn(object, key) {
    return Boolean(object) && Object.prototype.hasOwnProperty.call(object, key);
  }

  function setText(element, value) {
    element.textContent = safeString(value);
  }

  function setHidden(element, hidden) {
    element.classList.toggle("hidden", Boolean(hidden));
  }

  function normalizeUiState(value) {
    var normalized = safeString(value || "booting")
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_");
    var aliases = {
      busy: "processing",
      generating: "processing",
      transcribing: "processing",
      complete: "imported",
      completed: "imported",
      done: "imported",
      import_failed: "saved_not_imported",
      failed_import: "saved_not_imported",
      recovery: "recovery_required",
      recovery_blocked: "recovery_required",
      recovery_running: "recovering",
      retry_import: "retrying_import",
      retrying: "retrying_import",
    };
    return aliases[normalized] || normalized || "booting";
  }

  function isBusyState(uiState) {
    return BUSY_STATES.indexOf(uiState) >= 0;
  }

  function isTerminalState(uiState) {
    return TERMINAL_STATES.indexOf(uiState) >= 0;
  }

  function mergeSnapshot(next) {
    if (!next || typeof next !== "object") return;
    if (hasOwn(next, "uiState")) snapshot.uiState = normalizeUiState(next.uiState);
    if (next.server && typeof next.server === "object") {
      snapshot.server = Object.assign({}, snapshot.server, next.server);
    }
    if (hasOwn(next, "context")) snapshot.context = next.context || null;
    if (next.form && typeof next.form === "object") {
      snapshot.form = Object.assign({}, snapshot.form, next.form);
    }
    if (next.controls && typeof next.controls === "object") {
      snapshot.controls = Object.assign({}, snapshot.controls, next.controls);
    }
    if (next.progress && typeof next.progress === "object") {
      snapshot.progress = Object.assign({}, snapshot.progress, next.progress);
    }
    if (next.recovery && typeof next.recovery === "object") {
      snapshot.recovery = Object.assign({}, snapshot.recovery, next.recovery);
    }
    if (hasOwn(next, "result")) snapshot.result = next.result || null;
    if (Array.isArray(next.logs)) snapshot.logs = next.logs.slice();
    if (hasOwn(next, "fatal")) snapshot.fatal = next.fatal || null;
  }

  function hydrateLocalForm() {
    var options = snapshot.form.options || {};
    var words = options.maxWords || {};
    var models = Array.isArray(options.geminiModels) ? options.geminiModels : [];

    if (!local.formHydrated) {
      local.form.language = snapshot.form.language === "English" ? "English" : "Hindi";
      local.form.selectedTrackIndex = hasOwn(snapshot.form, "selectedTrackIndex")
        ? finiteNumber(snapshot.form.selectedTrackIndex, null)
        : null;
      local.formHydrated = true;
    }

    if (snapshot.form.optionsLoaded && !local.optionsHydrated) {
      if (!local.dirtyFields.geminiModel) {
        local.form.geminiModel = safeString(options.defaultGeminiModel || models[0] || "");
      }
      if (!local.dirtyFields.vocabPrompt) {
        local.form.vocabPrompt = safeString(options.defaultVocabulary || "");
      }
      if (!local.dirtyFields.maxWords) {
        local.form.maxWords = Math.round(
          clamp(words.default, finiteNumber(words.minimum, 2), finiteNumber(words.maximum, 20), 6)
        );
      }
      local.optionsHydrated = true;
    }

    var tracks = snapshot.context && Array.isArray(snapshot.context.tracks)
      ? snapshot.context.tracks
      : [];
    var selectedExists = tracks.some(function (track) {
      return finiteNumber(track.index, -1) === local.form.selectedTrackIndex && !track.disabled;
    });
    if (!selectedExists) {
      var hostSelected = finiteNumber(snapshot.form.selectedTrackIndex, null);
      var hostTrack = tracks.find(function (track) {
        return finiteNumber(track.index, -1) === hostSelected && !track.disabled;
      });
      var firstTrack = tracks.find(function (track) {
        return !track.disabled && finiteNumber(track.clipCount, 0) > 0;
      });
      local.form.selectedTrackIndex = hostTrack
        ? finiteNumber(hostTrack.index, null)
        : firstTrack
          ? finiteNumber(firstTrack.index, null)
          : null;
    }

    if (models.length && models.indexOf(local.form.geminiModel) < 0) {
      local.form.geminiModel = safeString(options.defaultGeminiModel || models[0]);
    }
  }

  function renderServer() {
    var server = snapshot.server || {};
    var ready = Boolean(server.ready);
    var busy = Boolean(server.busy);
    var status = safeString(server.status).toLowerCase();
    refs.serverBadge.classList.remove("is-ready", "is-busy", "is-offline", "is-error", "is-checking");

    if (busy || status === "busy") {
      refs.serverBadge.classList.add("is-busy");
    } else if (ready || status === "ready") {
      refs.serverBadge.classList.add("is-ready");
    } else if (status === "checking" || status === "booting") {
      refs.serverBadge.classList.add("is-checking");
    } else if (status === "error" || status === "needs_setup") {
      refs.serverBadge.classList.add("is-error");
    } else {
      refs.serverBadge.classList.add("is-offline");
    }

    var fallbackLabel = busy ? "Busy" : ready ? "Ready" : status === "checking" ? "Checking…" : "Offline";
    setText(refs.serverBadgeLabel, server.label || fallbackLabel);
  }

  function shortTime(value) {
    var text = safeString(value);
    return /^00:\d{2}:\d{2}$/.test(text) ? text.slice(3) : text;
  }

  function selectedTrack() {
    var context = snapshot.context;
    if (!context || !Array.isArray(context.tracks)) return null;
    return context.tracks.find(function (track) {
      return finiteNumber(track.index, -1) === local.form.selectedTrackIndex;
    }) || null;
  }

  function renderContext() {
    var context = snapshot.context;
    var track = selectedTrack();
    var existing = safeString(refs.trackSelect.value);
    refs.trackSelect.textContent = "";

    if (!context || !Array.isArray(context.tracks) || !context.tracks.length) {
      var emptyOption = document.createElement("option");
      emptyOption.value = "";
      emptyOption.textContent = "Open a sequence and refresh";
      refs.trackSelect.appendChild(emptyOption);
      setText(refs.sequenceTitle, "No active sequence detected.");
      setText(refs.sequenceMeta, "Open a project and set sequence In and Out points.");
      setText(refs.inTime, "—");
      setText(refs.outTime, "—");
      setText(refs.durationTime, "—");
      return;
    }

    context.tracks.forEach(function (item) {
      var index = finiteNumber(item.index, 0);
      var clipCount = finiteNumber(item.clipCount, 0);
      var option = document.createElement("option");
      option.value = safeString(index);
      option.disabled = Boolean(item.disabled) || clipCount < 1;
      option.textContent = safeString(
        item.label ||
          "A" +
            (index + 1) +
            " — " +
            (item.name || "Audio " + (index + 1)) +
            " · " +
            clipCount +
            " clip" +
            (clipCount === 1 ? "" : "s")
      );
      refs.trackSelect.appendChild(option);
    });

    var selectedValue = local.form.selectedTrackIndex === null
      ? existing
      : safeString(local.form.selectedTrackIndex);
    refs.trackSelect.value = selectedValue;
    if (refs.trackSelect.value === "" && refs.trackSelect.options.length) {
      var firstEnabled = Array.from(refs.trackSelect.options).find(function (option) {
        return !option.disabled;
      });
      if (firstEnabled) {
        refs.trackSelect.value = firstEnabled.value;
        local.form.selectedTrackIndex = finiteNumber(firstEnabled.value, null);
        track = selectedTrack();
      }
    }

    var sequenceName = safeString(context.sequenceName || context.sequenceInfo || "Active sequence");
    var inTime = safeString(context.inTime || "—");
    var outTime = safeString(context.outTime || "—");
    var durationTime = safeString(context.durationTime || "—");
    setText(refs.sequenceTitle, sequenceName);
    setText(refs.inTime, inTime);
    setText(refs.outTime, outTime);
    setText(refs.durationTime, durationTime);

    if (track) {
      var trackIndex = finiteNumber(track.index, 0);
      setText(
        refs.sequenceMeta,
        "A" +
          (trackIndex + 1) +
          " · " +
          safeString(track.name || "Audio " + (trackIndex + 1)) +
          " · " +
          shortTime(inTime) +
          "–" +
          shortTime(outTime)
      );
    } else {
      setText(refs.sequenceMeta, shortTime(inTime) + "–" + shortTime(outTime));
    }
  }

  function renderOptions() {
    var options = snapshot.form.options || {};
    var words = options.maxWords || {};
    var minimum = Math.round(finiteNumber(words.minimum, 2));
    var maximum = Math.round(finiteNumber(words.maximum, 20));
    if (maximum < minimum) maximum = minimum;
    local.form.maxWords = Math.round(clamp(local.form.maxWords, minimum, maximum, 6));

    refs.maxWords.min = safeString(minimum);
    refs.maxWords.max = safeString(maximum);
    refs.maxWords.value = safeString(local.form.maxWords);
    setText(refs.maxWordsValue, local.form.maxWords);
    updateRangeFill();

    var models = Array.isArray(options.geminiModels) ? options.geminiModels : [];
    refs.geminiModel.textContent = "";
    if (!models.length) {
      var placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "No Gemini models available";
      refs.geminiModel.appendChild(placeholder);
    } else {
      models.forEach(function (model) {
        var option = document.createElement("option");
        option.value = safeString(model);
        option.textContent = safeString(model);
        refs.geminiModel.appendChild(option);
      });
    }
    refs.geminiModel.value = local.form.geminiModel;
    if (models.length && refs.geminiModel.value === "") {
      refs.geminiModel.value = safeString(options.defaultGeminiModel || models[0]);
      local.form.geminiModel = refs.geminiModel.value;
    }

    refs.vocabPrompt.value = local.form.vocabPrompt;
  }

  function renderLanguage() {
    var isHindi = local.form.language !== "English";
    refs.languageHindi.classList.toggle("is-selected", isHindi);
    refs.languageEnglish.classList.toggle("is-selected", !isHindi);
    refs.languageHindi.setAttribute("aria-checked", isHindi ? "true" : "false");
    refs.languageEnglish.setAttribute("aria-checked", isHindi ? "false" : "true");
    setHidden(refs.geminiKeyField, !isHindi);
    setHidden(refs.geminiModelField, !isHindi);
  }

  function renderDisclosure() {
    setHidden(refs.advancedPanel, !local.advancedOpen);
    refs.advancedToggle.setAttribute("aria-expanded", local.advancedOpen ? "true" : "false");
    setHidden(refs.logsPanel, !local.logsOpen);
    refs.logsToggle.setAttribute("aria-expanded", local.logsOpen ? "true" : "false");
    setText(refs.logsToggle, local.logsOpen ? "Hide log" : "Show log");
  }

  function renderScrollMode() {
    var recovery = snapshot.recovery || {};
    var controls = snapshot.controls || {};
    var result = snapshot.result;
    var needsScroll =
      local.advancedOpen ||
      Boolean(snapshot.fatal) ||
      Boolean(controls.recoveryVisible || recovery.blocked) ||
      Boolean(result && (result.title || result.summary || result.path));

    refs.app.classList.toggle("is-scrollable", needsScroll);
    if (!needsScroll && refs.scrollArea.scrollTop !== 0) {
      refs.scrollArea.scrollTop = 0;
    }
  }

  function renderRecovery() {
    var controls = snapshot.controls || {};
    var recovery = snapshot.recovery || {};
    var visible = Boolean(controls.recoveryVisible || recovery.blocked);
    setHidden(refs.recoveryCard, !visible);
    setText(
      refs.recoveryText,
      recovery.message ||
        (recovery.sequenceName
          ? "Open “" + recovery.sequenceName + "”, then restore its saved audio-track states."
          : "Open the interrupted sequence, then restore its saved audio-track states.")
    );
    setText(refs.recoverBtn, controls.recoveryLabel || (recovery.running ? "Restoring…" : "Restore Track States"));
    refs.recoverBtn.disabled =
      !Boolean(controls.recoveryEnabled) ||
      Boolean(recovery.running) ||
      pendingCommands.has("RECOVER");
  }

  function resultCaption(result) {
    var count = finiteNumber(result && result.captionCount, 0);
    if (count > 0) {
      return count + " caption" + (count === 1 ? "" : "s");
    }
    return "SRT";
  }

  function renderResult() {
    var result = snapshot.result;
    var imported = Boolean(result && result.imported);
    var hasResult = Boolean(result && (result.title || result.summary || result.path));
    setHidden(refs.resultLine, !imported);
    setHidden(refs.resultCard, !hasResult || imported);

    if (!result) return;
    setText(
      refs.resultSummary,
      result.summary || resultCaption(result) + " imported into the “Sync-X” bin."
    );
    setText(refs.resultTitle, result.title || (imported ? "SRT imported" : "SRT saved"));
    setText(refs.resultDetail, result.summary || "");
    setText(refs.resultPath, result.path || "");

    var retryVisible = Boolean(snapshot.controls.retryVisible || result.retry) && !imported;
    setHidden(refs.retryImportBtn, !retryVisible);
    setText(refs.retryImportBtn, snapshot.controls.retryLabel || "Retry Import");
    refs.retryImportBtn.disabled =
      !Boolean(snapshot.controls.retryEnabled) ||
      pendingCommands.has("RETRY_IMPORT");
  }

  function renderLogs() {
    var lines = Array.isArray(snapshot.logs) ? snapshot.logs : [];
    var visibleLines = lines.slice(-120);
    setText(
      refs.logs,
      visibleLines.length ? visibleLines.join("\n") : "Job updates will appear here."
    );
    var phase = safeString(snapshot.progress.phase || snapshot.uiState || "idle")
      .toLowerCase()
      .replace(/_/g, " ");
    setText(refs.logState, "— " + phase);
    refs.clearLogsBtn.disabled = pendingCommands.has("CLEAR_LOGS") || lines.length === 0;
  }

  function renderFatal() {
    var fatal = snapshot.fatal;
    setHidden(refs.fatalPanel, !fatal);
    if (fatal) {
      var message = typeof fatal === "string" ? fatal : fatal.message;
      setText(
        refs.fatalText,
        message || "Reload the panel. If this message remains, reinstall the Sync-X plugin."
      );
    }
  }

  function renderProgress() {
    var uiState = normalizeUiState(snapshot.uiState);
    var progress = snapshot.progress || {};
    var busy = isBusyState(uiState);
    var value = Math.round(clamp(progress.value, 0, 100, 0));
    var accessibleLabel = safeString(progress.label || "Processing").replace(/…/g, "");

    setHidden(refs.progressRow, !busy);
    setHidden(refs.footerSpinner, !busy);
    setText(refs.phaseLabel, progress.label || "Processing…");
    setText(refs.progressValue, busy ? value + "%" : "");
    refs.progressRow.setAttribute(
      "aria-label",
      busy ? accessibleLabel + ", " + value + " percent" : ""
    );
  }

  function readControlBoolean(name, fallback) {
    return hasOwn(snapshot.controls, name) ? Boolean(snapshot.controls[name]) : fallback;
  }

  function localGenerateValidity() {
    var context = snapshot.context;
    var track = selectedTrack();
    var options = snapshot.form.options || {};
    var maxDuration = finiteNumber(options.maxDurationSeconds, 1800);
    if (!snapshot.server.ready || snapshot.server.busy) return false;
    if (!context || !context.rangeIsValid) return false;
    if (finiteNumber(context.durationSeconds, 0) <= 0) return false;
    if (finiteNumber(context.durationSeconds, 0) > maxDuration) return false;
    if (!track || Boolean(track.disabled) || finiteNumber(track.clipCount, 0) < 1) return false;
    if (snapshot.recovery && snapshot.recovery.blocked) return false;
    if (snapshot.fatal) return false;
    return true;
  }

  function renderControls() {
    var uiState = normalizeUiState(snapshot.uiState);
    var controls = snapshot.controls || {};
    var busy = isBusyState(uiState);
    var formLocked = readControlBoolean("formLocked", busy);
    var cancelVisible = readControlBoolean("cancelVisible", busy);
    var baseEnabled = readControlBoolean("generateBaseEnabled", localGenerateValidity());
    var keyRequired = local.form.language === "Hindi";
    var hasRequiredKey = !keyRequired || Boolean(local.geminiKey.trim());
    var selected = selectedTrack();
    var selectedValid = Boolean(selected) && !selected.disabled && finiteNumber(selected.clipCount, 0) > 0;
    var generateEnabled =
      baseEnabled &&
      localGenerateValidity() &&
      selectedValid &&
      hasRequiredKey &&
      !formLocked &&
      !cancelVisible &&
      !pendingCommands.has("GENERATE");

    refs.app.dataset.state = uiState;
    refs.refreshBtn.disabled =
      !readControlBoolean("refreshEnabled", uiState !== "booting" && !busy) ||
      pendingCommands.has("REFRESH");
    refs.refreshBtn.classList.toggle(
      "is-spinning",
      Boolean(controls.refreshSpinning) || pendingCommands.has("REFRESH")
    );

    refs.trackSelect.disabled = formLocked || !snapshot.context;
    refs.languageHindi.disabled = formLocked;
    refs.languageEnglish.disabled = formLocked;
    refs.maxWords.disabled = formLocked;
    refs.geminiKey.disabled = formLocked || local.form.language !== "Hindi";
    refs.geminiModel.disabled = formLocked || local.form.language !== "Hindi";
    refs.vocabPrompt.disabled = formLocked;

    setHidden(refs.generateBtn, cancelVisible);
    setHidden(refs.cancelBtn, !cancelVisible);
    refs.generateBtn.disabled = !generateEnabled;
    refs.cancelBtn.disabled =
      !readControlBoolean("cancelEnabled", busy) ||
      pendingCommands.has("CANCEL");
    setText(
      refs.cancelBtn.querySelector("span"),
      controls.cancelLabel || (uiState === "cancelling" ? "Cancelling…" : "Cancel")
    );

    if (snapshot.fatal) {
      refs.refreshBtn.disabled = true;
      refs.generateBtn.disabled = true;
      refs.cancelBtn.disabled = true;
      refs.recoverBtn.disabled = true;
      refs.retryImportBtn.disabled = true;
    }
  }

  function render() {
    hydrateLocalForm();
    renderServer();
    renderContext();
    renderOptions();
    renderLanguage();
    renderRecovery();
    renderResult();
    renderLogs();
    renderFatal();
    renderProgress();
    renderDisclosure();
    renderScrollMode();
    renderControls();
    previousUiState = normalizeUiState(snapshot.uiState);
  }

  function updateRangeFill() {
    var minimum = finiteNumber(refs.maxWords.min, 2);
    var maximum = finiteNumber(refs.maxWords.max, 20);
    var value = clamp(refs.maxWords.value, minimum, maximum, 6);
    var position = maximum === minimum ? 0 : ((value - minimum) / (maximum - minimum)) * 100;
    refs.maxWords.style.setProperty("--range-position", position + "%");
  }

  function makeRequestId(type) {
    requestCounter += 1;
    return (
      safeString(type).toLowerCase().replace(/_/g, "-") +
      "-" +
      Date.now().toString(36) +
      "-" +
      requestCounter.toString(36)
    );
  }

  function clearPending(type) {
    if (!pendingCommands.has(type)) return;
    pendingCommands.delete(type);
    var timer = pendingTimers.get(type);
    if (timer) window.clearTimeout(timer);
    pendingTimers.delete(type);
  }

  function releasePendingForMessage(message) {
    if (message.requestId) {
      pendingCommands.forEach(function (requestId, type) {
        if (requestId === message.requestId) clearPending(type);
      });
    }

    if (message.type === "STATE") {
      clearPending("REFRESH");
      var uiState = normalizeUiState(snapshot.uiState);
      if (isBusyState(uiState)) clearPending("GENERATE");
      if (uiState === "cancelling" || isTerminalState(uiState)) clearPending("CANCEL");
      if (uiState === "recovering" || !(snapshot.recovery && snapshot.recovery.blocked)) {
        clearPending("RECOVER");
      }
      if (uiState === "retrying_import" || uiState === "imported" || uiState === "saved_not_imported") {
        clearPending("RETRY_IMPORT");
      }
      if (!snapshot.logs.length) clearPending("CLEAR_LOGS");
    }
    if (message.type === "LOGS") clearPending("CLEAR_LOGS");
    if (message.type === "RESULT") clearPending("RETRY_IMPORT");
    if (message.type === "FATAL_ERROR") {
      Array.from(pendingCommands.keys()).forEach(clearPending);
    }
  }

  function sendCommand(type, payload) {
    if (pendingCommands.has(type)) return false;
    var requestId = makeRequestId(type);
    var envelope = {
      version: BRIDGE_VERSION,
      type: type,
      requestId: requestId,
      payload: payload || {},
    };
    pendingCommands.set(type, requestId);
    pendingTimers.set(
      type,
      window.setTimeout(function () {
        clearPending(type);
        renderControls();
      }, type === "WEB_READY" ? 8000 : 15000)
    );

    try {
      if (window.uxpHost && typeof window.uxpHost.postMessage === "function") {
        window.uxpHost.postMessage(JSON.stringify(envelope));
      } else {
        mockHost.receive(envelope);
      }
      return true;
    } catch (error) {
      clearPending(type);
      snapshot.fatal = "The WebView could not communicate with Premiere. " + safeString(error.message);
      snapshot.uiState = "failed";
      render();
      return false;
    }
  }

  function parseHostMessage(data) {
    var value = data;
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch (_error) {
        return null;
      }
    }
    if (!value || typeof value !== "object") return null;
    if (finiteNumber(value.version, -1) !== BRIDGE_VERSION) return null;
    if (HOST_EVENT_TYPES.indexOf(value.type) < 0) return null;
    return value;
  }

  function applyHostEvent(message) {
    if (!hostHydrated) {
      hostHydrated = true;
      if (readyRetryTimer) window.clearTimeout(readyRetryTimer);
      readyRetryTimer = 0;
    }
    var payload = message.payload && typeof message.payload === "object" ? message.payload : {};
    if (message.type === "STATE") {
      mergeSnapshot(payload);
    } else if (message.type === "OPTIONS") {
      snapshot.form.options = payload.options || null;
      snapshot.form.optionsLoaded = hasOwn(payload, "optionsLoaded")
        ? Boolean(payload.optionsLoaded)
        : true;
    } else if (message.type === "CONTEXT") {
      snapshot.context = payload.context || null;
    } else if (message.type === "PROGRESS") {
      snapshot.progress = Object.assign({}, snapshot.progress, payload.progress || {});
    } else if (message.type === "LOGS") {
      snapshot.logs = Array.isArray(payload.logs) ? payload.logs.slice() : [];
      if (payload.reveal) {
        local.advancedOpen = true;
        local.logsOpen = true;
      }
    } else if (message.type === "RESULT") {
      snapshot.result = payload.result || null;
    } else if (message.type === "CLIPBOARD_TEXT") {
      var pasteContext = local.pendingPaste;
      var currentPasteRequest = pendingCommands.get("PASTE_API_KEY");
      var matchesPendingPaste =
        pasteContext &&
        pasteContext.requestId === message.requestId &&
        currentPasteRequest === message.requestId;
      if (matchesPendingPaste) {
        if (payload.text) {
          insertGeminiKeyText(payload.text, pasteContext);
        } else if (payload.error) {
          showGeminiKeyNotice(payload.error, true);
        }
        local.pendingPaste = null;
      }
    } else if (message.type === "FATAL_ERROR") {
      snapshot.fatal = payload.message || "The Sync-X host reported an unrecoverable error.";
      snapshot.uiState = "failed";
    }

    var currentUiState = normalizeUiState(snapshot.uiState);
    if (
      currentUiState === "failed" ||
      currentUiState === "saved_not_imported" ||
      snapshot.fatal
    ) {
      local.advancedOpen = true;
      local.logsOpen = true;
    }
    releasePendingForMessage(message);
    render();
  }

  function handleMessage(event) {
    if (
      window.uxpHost &&
      typeof window.uxpHost.postMessage === "function" &&
      event.source !== window.uxpHost
    ) {
      return;
    }
    var message = parseHostMessage(event.data);
    if (!message) return;
    applyHostEvent(message);
  }

  function chooseLanguage(language) {
    if (snapshot.controls.formLocked) return;
    local.form.language = language === "English" ? "English" : "Hindi";
    local.formDirty = true;
    local.dirtyFields.language = true;
    renderLanguage();
    renderControls();
  }

  function captureJobSnapshot() {
    var language = local.form.language === "English" ? "English" : "Hindi";
    return Object.freeze({
      trackIndex: finiteNumber(refs.trackSelect.value, null),
      language: language,
      geminiModel: language === "Hindi" ? safeString(refs.geminiModel.value) : "",
      vocabPrompt: safeString(refs.vocabPrompt.value),
      maxWords: Math.round(finiteNumber(refs.maxWords.value, 6)),
      geminiKey: language === "Hindi" ? local.geminiKey.trim() : "",
    });
  }

  function showGeminiKeyNotice(message, isError) {
    if (local.pasteNoticeTimer) window.clearTimeout(local.pasteNoticeTimer);
    setText(refs.geminiKeyNote, message || "Session only");
    refs.geminiKeyNote.classList.toggle("is-error", Boolean(isError));
    local.pasteNoticeTimer = window.setTimeout(function () {
      setText(refs.geminiKeyNote, "Session only");
      refs.geminiKeyNote.classList.remove("is-error");
      local.pasteNoticeTimer = 0;
    }, 4000);
  }

  function insertGeminiKeyText(text, pasteContext) {
    var pastedText = safeString(text);
    if (
      !pastedText ||
      !pasteContext ||
      refs.geminiKey.disabled ||
      local.form.language !== "Hindi" ||
      document.activeElement !== refs.geminiKey ||
      safeString(refs.geminiKey.value) !== pasteContext.value
    ) {
      return;
    }

    var currentValue = safeString(refs.geminiKey.value);
    var start = finiteNumber(pasteContext.selectionStart, currentValue.length);
    var end = finiteNumber(pasteContext.selectionEnd, start);
    start = Math.max(0, Math.min(currentValue.length, start));
    end = Math.max(start, Math.min(currentValue.length, end));

    refs.geminiKey.value =
      currentValue.slice(0, start) + pastedText + currentValue.slice(end);
    local.geminiKey = refs.geminiKey.value;
    refs.geminiKey.focus();
    try {
      var cursor = start + pastedText.length;
      refs.geminiKey.setSelectionRange(cursor, cursor);
    } catch (_error) {}
    showGeminiKeyNotice("Pasted", false);
    renderControls();
  }

  function wireEvents() {
    window.addEventListener("message", handleMessage);

    refs.refreshBtn.addEventListener("click", function () {
      if (refs.refreshBtn.disabled) return;
      sendCommand("REFRESH", {});
      renderControls();
    });

    refs.recoverBtn.addEventListener("click", function () {
      if (refs.recoverBtn.disabled) return;
      sendCommand("RECOVER", {});
      renderControls();
    });

    refs.retryImportBtn.addEventListener("click", function () {
      if (refs.retryImportBtn.disabled) return;
      sendCommand("RETRY_IMPORT", {});
      renderControls();
    });

    refs.trackSelect.addEventListener("change", function () {
      local.form.selectedTrackIndex = finiteNumber(refs.trackSelect.value, null);
      local.formDirty = true;
      local.dirtyFields.selectedTrackIndex = true;
      renderContext();
      renderControls();
    });

    refs.languageHindi.addEventListener("click", function () {
      chooseLanguage("Hindi");
    });
    refs.languageEnglish.addEventListener("click", function () {
      chooseLanguage("English");
    });

    refs.maxWords.addEventListener("input", function () {
      local.form.maxWords = Math.round(finiteNumber(refs.maxWords.value, 6));
      local.formDirty = true;
      local.dirtyFields.maxWords = true;
      setText(refs.maxWordsValue, local.form.maxWords);
      updateRangeFill();
    });

    refs.geminiKey.addEventListener("input", function () {
      local.geminiKey = safeString(refs.geminiKey.value);
      renderControls();
    });

    document.addEventListener("keydown", function (event) {
      var isPasteShortcut =
        (event.metaKey || event.ctrlKey) &&
        (
          safeString(event.key).toLowerCase() === "v" ||
          safeString(event.code) === "KeyV"
        );
      var hasUxpBridge =
        window.uxpHost && typeof window.uxpHost.postMessage === "function";
      if (
        event.target !== refs.geminiKey ||
        refs.geminiKey.disabled ||
        !isPasteShortcut ||
        !hasUxpBridge
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      var valueAtPaste = safeString(refs.geminiKey.value);
      var selectionStart = finiteNumber(
        refs.geminiKey.selectionStart,
        valueAtPaste.length
      );
      var selectionEnd = finiteNumber(
        refs.geminiKey.selectionEnd,
        selectionStart
      );
      if (sendCommand("PASTE_API_KEY", {})) {
        local.pendingPaste = {
          requestId: pendingCommands.get("PASTE_API_KEY"),
          value: valueAtPaste,
          selectionStart: selectionStart,
          selectionEnd: selectionEnd,
        };
      }
    }, true);

    refs.geminiModel.addEventListener("change", function () {
      local.form.geminiModel = safeString(refs.geminiModel.value);
      local.formDirty = true;
      local.dirtyFields.geminiModel = true;
    });

    refs.vocabPrompt.addEventListener("input", function () {
      local.form.vocabPrompt = safeString(refs.vocabPrompt.value);
      local.formDirty = true;
      local.dirtyFields.vocabPrompt = true;
    });

    refs.advancedToggle.addEventListener("click", function () {
      local.advancedOpen = !local.advancedOpen;
      renderDisclosure();
      renderScrollMode();
    });

    refs.logsToggle.addEventListener("click", function () {
      local.logsOpen = !local.logsOpen;
      renderDisclosure();
      renderScrollMode();
    });

    refs.clearLogsBtn.addEventListener("click", function () {
      if (refs.clearLogsBtn.disabled) return;
      sendCommand("CLEAR_LOGS", {});
      renderControls();
    });

    refs.generateBtn.addEventListener("click", function () {
      if (refs.generateBtn.disabled) return;
      var jobSnapshot = captureJobSnapshot();
      sendCommand("GENERATE", jobSnapshot);
      renderControls();
    });

    refs.cancelBtn.addEventListener("click", function () {
      if (refs.cancelBtn.disabled) return;
      sendCommand("CANCEL", {});
      renderControls();
    });
  }

  function mockSnapshot(stateName) {
    var state = normalizeUiState(stateName || "ready");
    var base = {
      version: BRIDGE_VERSION,
      uiState: state,
      server: {
        status: "ready",
        label: "Ready",
        ready: true,
        busy: false,
        raw: null,
      },
      context: {
        projectName: "Web Platform",
        sequenceName: "1x1 Web Platform",
        sequenceGuid: "mock-sequence",
        inSeconds: 0,
        outSeconds: 38,
        durationSeconds: 38,
        rangeIsValid: true,
        inTime: "00:00:00",
        outTime: "00:00:38",
        durationTime: "0:38",
        sequenceInfo: "1x1 Web Platform",
        tracks: [
          {
            index: 0,
            id: "mock-a1",
            name: "Dialogue",
            clipCount: 12,
            muted: false,
            label: "A1 — Dialogue · 12 clips",
            disabled: false,
          },
          {
            index: 1,
            id: "mock-a2",
            name: "Music",
            clipCount: 4,
            muted: false,
            label: "A2 — Music · 4 clips",
            disabled: false,
          },
        ],
      },
      form: {
        language: "Hindi",
        selectedTrackIndex: 0,
        optionsLoaded: true,
        options: {
          languages: ["Hindi", "English"],
          geminiModels: ["gemini-2.5-flash", "gemini-2.5-pro"],
          defaultGeminiModel: "gemini-2.5-flash",
          defaultVocabulary: "CapMint, Sync-X, Premiere Pro",
          maxWords: {
            minimum: 2,
            maximum: 20,
            default: 6,
          },
          maxDurationSeconds: 1800,
        },
      },
      controls: {
        formLocked: false,
        generateBaseEnabled: true,
        keyRequired: true,
        cancelVisible: false,
        cancelEnabled: false,
        cancelLabel: "Cancel",
        refreshEnabled: true,
        refreshSpinning: false,
        recoveryVisible: false,
        recoveryEnabled: false,
        recoveryLabel: "Restore Track States",
        retryVisible: false,
        retryEnabled: false,
        retryLabel: "Retry Import",
      },
      progress: {
        phase: "idle",
        label: "Ready to generate",
        value: 0,
      },
      recovery: {
        blocked: false,
        running: false,
        message: "",
        sequenceName: "",
      },
      result: null,
      logs: [],
      fatal: null,
    };

    if (state === "booting") {
      base.server = {
        status: "checking",
        label: "Checking…",
        ready: false,
        busy: false,
      };
      base.controls.formLocked = true;
      base.controls.generateBaseEnabled = false;
      base.controls.refreshEnabled = false;
      base.progress.label = "Starting Sync-X…";
    } else if (state === "offline") {
      base.server = {
        status: "offline",
        label: "Offline",
        ready: false,
        busy: false,
      };
      base.controls.generateBaseEnabled = false;
      base.progress.label = "Start the localhost server";
    } else if (state === "invalid") {
      base.context.rangeIsValid = false;
      base.context.outSeconds = 0;
      base.context.durationSeconds = 0;
      base.context.outTime = "—";
      base.context.durationTime = "—";
      base.controls.generateBaseEnabled = false;
      base.progress.label = "Set valid In and Out points";
    } else if (state === "processing" || state === "rendering" || state === "uploading") {
      base.uiState = state;
      base.server.busy = state === "processing";
      base.server.status = state === "processing" ? "busy" : "ready";
      base.server.label = state === "processing" ? "Busy" : "Ready";
      base.controls.formLocked = true;
      base.controls.generateBaseEnabled = false;
      base.controls.refreshEnabled = false;
      base.controls.cancelVisible = true;
      base.controls.cancelEnabled = true;
      base.progress.phase = state;
      base.progress.label =
        state === "rendering"
          ? "Rendering selected track…"
          : state === "uploading"
            ? "Uploading audio…"
            : "Transcribing…";
      base.progress.value = state === "rendering" ? 18 : state === "uploading" ? 38 : 50;
      base.logs = ["Selected A1 — Dialogue", "Original mute states saved.", base.progress.label];
    } else if (state === "imported") {
      base.progress = {
        phase: "complete",
        label: "Imported · 37 captions",
        value: 100,
      };
      base.result = {
        title: "SRT imported",
        summary: "37 captions imported into the “Sync-X” bin.",
        path: "/Users/demo/Documents/Sync-X Outputs/Web Platform/1x1 Web Platform/1x1_Web_Platform_A1_HINGLISH_1.srt",
        retry: false,
        imported: true,
        captionCount: 37,
      };
      base.logs = ["Transcription complete.", "Saved SRT.", "Imported 37 captions."];
    } else if (state === "recovery_required") {
      base.controls.formLocked = true;
      base.controls.generateBaseEnabled = false;
      base.controls.recoveryVisible = true;
      base.controls.recoveryEnabled = true;
      base.recovery = {
        blocked: true,
        running: false,
        message: "Open “1x1 Web Platform”, then restore its saved audio-track states.",
        sequenceName: "1x1 Web Platform",
      };
    } else if (state === "saved_not_imported") {
      base.controls.generateBaseEnabled = false;
      base.controls.retryVisible = true;
      base.controls.retryEnabled = true;
      base.progress = {
        phase: "import failed",
        label: "SRT saved · import failed",
        value: 100,
      };
      base.result = {
        title: "SRT saved",
        summary: "Premiere could not import the file. The SRT is safe on disk.",
        path: "/Users/demo/Documents/Sync-X Outputs/Web Platform/1x1 Web Platform/1x1_Web_Platform_A1_HINGLISH_1.srt",
        retry: true,
        imported: false,
        captionCount: 37,
      };
      base.logs = ["SRT saved.", "Import failed. Retry when the project is available."];
    } else if (state === "cancelled") {
      base.progress = {
        phase: "cancelled",
        label: "Cancelled",
        value: 0,
      };
      base.logs = ["Generation cancelled.", "Original audio-track states restored."];
    }
    return base;
  }

  var mockHost = (function () {
    var enabled = !(window.uxpHost && typeof window.uxpHost.postMessage === "function");
    var params = new URLSearchParams(window.location.search);
    var initialName = params.get("state") || "ready";
    var current = mockSnapshot(initialName);
    var processTimer = 0;

    function emit(type, payload, requestId) {
      var envelope = {
        version: BRIDGE_VERSION,
        type: type,
        requestId: requestId || makeRequestId("mock"),
        payload: payload,
      };
      window.setTimeout(function () {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify(envelope),
          })
        );
      }, 0);
    }

    function emitState(requestId) {
      emit("STATE", current, requestId);
    }

    function startMockJob(requestId) {
      if (processTimer) window.clearInterval(processTimer);
      current = mockSnapshot("processing");
      current.progress.value = 8;
      current.progress.label = "Preparing Premiere render…";
      current.logs = ["Selected A1 — Dialogue", "Saving original audio-track states…"];
      emitState(requestId);
      processTimer = window.setInterval(function () {
        current.progress.value += 14;
        if (current.progress.value < 40) {
          current.progress.label = "Rendering selected track…";
        } else if (current.progress.value < 55) {
          current.progress.label = "Uploading audio…";
        } else {
          current.progress.label = "Transcribing…";
        }
        if (current.progress.value >= 100) {
          window.clearInterval(processTimer);
          processTimer = 0;
          current = mockSnapshot("imported");
        }
        emitState();
      }, 340);
    }

    function receive(envelope) {
      if (!enabled) return;
      if (envelope.type === "WEB_READY") {
        emitState(envelope.requestId);
      } else if (envelope.type === "REFRESH") {
        current.controls.refreshEnabled = false;
        current.controls.refreshSpinning = true;
        emitState(envelope.requestId);
        window.setTimeout(function () {
          current.controls.refreshEnabled = true;
          current.controls.refreshSpinning = false;
          emitState();
        }, 420);
      } else if (envelope.type === "GENERATE") {
        startMockJob(envelope.requestId);
      } else if (envelope.type === "CANCEL") {
        if (processTimer) window.clearInterval(processTimer);
        processTimer = 0;
        current.uiState = "cancelling";
        current.controls.cancelEnabled = false;
        current.controls.cancelLabel = "Cancelling…";
        current.progress.label = "Cancelling…";
        emitState(envelope.requestId);
        window.setTimeout(function () {
          current = mockSnapshot("cancelled");
          emitState();
        }, 450);
      } else if (envelope.type === "RECOVER") {
        current.uiState = "recovering";
        current.recovery.running = true;
        current.controls.recoveryEnabled = false;
        current.controls.recoveryLabel = "Restoring…";
        emitState(envelope.requestId);
        window.setTimeout(function () {
          current = mockSnapshot("ready");
          current.logs = ["Original audio-track states restored."];
          emitState();
        }, 550);
      } else if (envelope.type === "RETRY_IMPORT") {
        current.uiState = "retrying_import";
        current.controls.retryEnabled = false;
        current.controls.retryLabel = "Importing…";
        emitState(envelope.requestId);
        window.setTimeout(function () {
          current = mockSnapshot("imported");
          emitState();
        }, 550);
      } else if (envelope.type === "CLEAR_LOGS") {
        current.logs = [];
        emit("LOGS", { logs: [], reveal: false }, envelope.requestId);
      }
    }

    function setState(name) {
      if (!enabled) return;
      if (processTimer) window.clearInterval(processTimer);
      processTimer = 0;
      current = mockSnapshot(name);
      emitState();
    }

    return {
      enabled: enabled,
      receive: receive,
      setState: setState,
    };
  })();

  function announceReady() {
    if (hostHydrated) return;
    clearPending("WEB_READY");
    sendCommand("WEB_READY", {
      capabilities: {
        version: BRIDGE_VERSION,
        localWebView: true,
      },
    });
    if (readyRetryTimer) window.clearTimeout(readyRetryTimer);
    readyRetryTimer = window.setTimeout(announceReady, 750);
  }

  function initialize() {
    try {
      cacheElements();
      wireEvents();
      if (mockHost.enabled) {
        local.geminiKey = "mock-session-key";
        refs.geminiKey.value = local.geminiKey;
        window.__SYNCX_MOCK__ = Object.freeze({
          setState: mockHost.setState,
        });
      }
      render();
      announceReady();
    } catch (error) {
      document.body.textContent = "";
      var fallback = document.createElement("div");
      fallback.className = "fatal-panel";
      var title = document.createElement("strong");
      title.textContent = "Sync-X could not start";
      var detail = document.createElement("p");
      detail.textContent =
        safeString(error.message) ||
        "Reload the panel. If this message remains, reinstall the Sync-X plugin.";
      fallback.appendChild(title);
      fallback.appendChild(detail);
      document.body.appendChild(fallback);
    }
  }

  initialize();
})();
