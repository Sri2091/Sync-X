(() => {
  const REQUIRED_IDS = [
    "serverBadge", "serverBadgeLabel", "recoveryCard", "recoveryText", "recoverBtn",
    "refreshBtn", "trackSelect", "trackMenu", "sequenceInfo", "inTime", "outTime",
    "durationTime", "languageGroup", "languageHindi", "languageEnglish", "maxWords",
    "maxWordsValue", "maxWordsValueSmall", "geminiKeyField", "geminiKey",
    "advancedToggle", "advancedPanel", "geminiModelField", "geminiModel",
    "geminiModelMenu", "vocabPrompt", "resultCard", "resultTitle", "resultSummary",
    "resultPath", "retryImportBtn", "logsToggle", "logsPanel", "logs", "clearLogsBtn",
    "phaseLabel", "progressValue", "progressBar", "generateBtn", "cancelBtn",
  ];

  const refs = {};
  const state = {
    initialized: false,
    handlers: {},
    language: "Hindi",
    geminiKey: "",
    trackItems: [],
    modelItems: [],
    advancedOpen: false,
    logsOpen: false,
    formLocked: false,
    trackAvailable: false,
  };

  function safeString(value) {
    return value === null || value === undefined ? "" : String(value);
  }

  function setText(target, value) {
    if (target) target.textContent = safeString(value);
  }

  function setVisible(target, visible) {
    if (target) target.classList.toggle("hidden", !visible);
  }

  function clampNumber(value, minimum, maximum, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(minimum, Math.min(maximum, Math.round(number)));
  }

  function cacheRequiredElements() {
    const missing = [];
    REQUIRED_IDS.forEach((id) => {
      const element = document.getElementById(id);
      if (!element) missing.push(id);
      else refs[id] = element;
    });
    if (missing.length) {
      throw new Error(`Panel UI is missing: ${missing.join(", ")}`);
    }
  }

  function removeAllChildren(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function setDropdownItems(dropdown, menu, items, selectedValue) {
    removeAllChildren(menu);
    let selectedIndex = -1;
    items.forEach((item, index) => {
      const menuItem = document.createElement("sp-menu-item");
      menuItem.textContent = item.label;
      if (item.disabled) {
        menuItem.disabled = true;
        menuItem.setAttribute("disabled", "");
      }
      menu.appendChild(menuItem);
      if (safeString(item.value) === safeString(selectedValue)) selectedIndex = index;
    });
    if (selectedIndex < 0) selectedIndex = items.findIndex((item) => !item.disabled);
    dropdown.selectedIndex = selectedIndex;
    return selectedIndex >= 0 ? items[selectedIndex] : null;
  }

  function getSelectedItem(dropdown, items) {
    const selectedIndex = Number(dropdown.selectedIndex);
    if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= items.length) return null;
    return items[selectedIndex];
  }

  function setAdvancedOpen(open) {
    state.advancedOpen = Boolean(open);
    setVisible(refs.advancedPanel, state.advancedOpen);
    setText(refs.advancedToggle, state.advancedOpen ? "Hide" : "Show");
  }

  function setLogsOpen(open) {
    state.logsOpen = Boolean(open);
    setVisible(refs.logsPanel, state.logsOpen);
    setText(refs.logsToggle, state.logsOpen ? "Hide log" : "Show log");
  }

  function updateLanguageControls() {
    const hindi = state.language === "Hindi";
    refs.languageGroup.value = state.language;
    refs.languageHindi.checked = hindi;
    refs.languageEnglish.checked = !hindi;
    setVisible(refs.geminiKeyField, hindi);
    setVisible(refs.geminiModelField, hindi);
    refs.geminiKey.disabled = state.formLocked || !hindi;
    refs.geminiModel.disabled = state.formLocked || !hindi || state.modelItems.length === 0;
  }

  function chooseLanguage(language, notify) {
    const next = language === "English" ? "English" : "Hindi";
    const changed = state.language !== next;
    state.language = next;
    updateLanguageControls();
    if (notify && changed && state.handlers.onLanguageChange) {
      state.handlers.onLanguageChange(next);
    }
  }

  function updateWordsValue(value) {
    const minimum = clampNumber(refs.maxWords.min, 1, 100, 2);
    const maximum = clampNumber(refs.maxWords.max, minimum, 100, 20);
    const normalized = clampNumber(value, minimum, maximum, 6);
    refs.maxWords.value = normalized;
    setText(refs.maxWordsValue, normalized);
    setText(refs.maxWordsValueSmall, normalized);
    return normalized;
  }

  function captureGeminiKey() {
    const current = safeString(refs.geminiKey.value);
    if (current) state.geminiKey = current;
    else if (!refs.geminiKey.value) state.geminiKey = "";
    if (state.handlers.onGeminiKeyChange) {
      state.handlers.onGeminiKeyChange(Boolean(state.geminiKey.trim()));
    }
  }

  function updateFormLock() {
    refs.refreshBtn.disabled = state.formLocked;
    refs.trackSelect.disabled = state.formLocked || !state.trackAvailable;
    refs.languageGroup.disabled = state.formLocked;
    refs.languageHindi.disabled = state.formLocked;
    refs.languageEnglish.disabled = state.formLocked;
    refs.maxWords.disabled = state.formLocked;
    refs.vocabPrompt.disabled = state.formLocked;
    updateLanguageControls();
  }

  function wireEvents() {
    refs.refreshBtn.addEventListener("click", () => {
      if (state.handlers.onRefresh) state.handlers.onRefresh();
    });
    refs.recoverBtn.addEventListener("click", () => {
      if (state.handlers.onRecover) state.handlers.onRecover();
    });
    refs.trackSelect.addEventListener("change", () => {
      const selected = getSelectedItem(refs.trackSelect, state.trackItems);
      if (selected && !selected.disabled && state.handlers.onTrackChange) {
        state.handlers.onTrackChange(Number(selected.value));
      }
    });
    refs.languageGroup.addEventListener("change", (event) => {
      chooseLanguage(safeString(event.target.value || refs.languageGroup.value), true);
    });
    refs.languageHindi.addEventListener("click", () => chooseLanguage("Hindi", true));
    refs.languageEnglish.addEventListener("click", () => chooseLanguage("English", true));
    refs.maxWords.addEventListener("input", (event) => updateWordsValue(event.target.value));
    refs.geminiKey.addEventListener("focus", () => {
      refs.geminiKey.type = "text";
      if (state.geminiKey && !safeString(refs.geminiKey.value)) refs.geminiKey.value = state.geminiKey;
    });
    refs.geminiKey.addEventListener("input", captureGeminiKey);
    refs.geminiKey.addEventListener("blur", () => {
      captureGeminiKey();
      refs.geminiKey.type = "password";
    });
    refs.advancedToggle.addEventListener("click", () => setAdvancedOpen(!state.advancedOpen));
    refs.logsToggle.addEventListener("click", () => setLogsOpen(!state.logsOpen));
    refs.generateBtn.addEventListener("click", () => {
      if (state.handlers.onGenerate) state.handlers.onGenerate();
    });
    refs.cancelBtn.addEventListener("click", () => {
      if (state.handlers.onCancel) state.handlers.onCancel();
    });
    refs.retryImportBtn.addEventListener("click", () => {
      if (state.handlers.onRetryImport) state.handlers.onRetryImport();
    });
    refs.clearLogsBtn.addEventListener("click", () => {
      if (state.handlers.onClearLogs) state.handlers.onClearLogs();
    });
  }

  function initialize(handlers) {
    if (state.initialized) return;
    cacheRequiredElements();
    state.handlers = handlers || {};
    wireEvents();
    setAdvancedOpen(false);
    setLogsOpen(false);
    chooseLanguage("Hindi", false);
    updateWordsValue(6);
    updateFormLock();
    state.initialized = true;
  }

  function setServerHealth(health) {
    refs.serverBadge.classList.remove("online");
    refs.serverBadge.classList.remove("offline");
    refs.serverBadge.classList.remove("busy");
    if (!health) {
      refs.serverBadge.classList.add("offline");
      setText(refs.serverBadgeLabel, "Offline");
    } else if (health.status !== "ready") {
      refs.serverBadge.classList.add("offline");
      setText(refs.serverBadgeLabel, "Needs setup");
    } else if (health.busy) {
      refs.serverBadge.classList.add("busy");
      setText(refs.serverBadgeLabel, "Busy");
    } else {
      refs.serverBadge.classList.add("online");
      setText(refs.serverBadgeLabel, "Ready");
    }
  }

  function setOptions(options) {
    state.modelItems = (options.gemini_models || []).map((model) => ({
      value: model,
      label: model,
      disabled: false,
    }));
    setDropdownItems(
      refs.geminiModel,
      refs.geminiModelMenu,
      state.modelItems,
      options.default_gemini_model
    );
    refs.vocabPrompt.value = safeString(options.default_vocabulary);
    refs.maxWords.min = Number(options.max_words.minimum);
    refs.maxWords.max = Number(options.max_words.maximum);
    updateWordsValue(options.max_words.default);
    updateFormLock();
  }

  function setPremiereContext(context, selectedTrackIndex, display) {
    state.trackItems = (context.tracks || []).map((track) => ({
      value: Number(track.index),
      disabled: Number(track.clipCount) < 1,
      label: `A${Number(track.index) + 1} — ${track.name} · ${track.clipCount} clip${track.clipCount === 1 ? "" : "s"}${track.muted ? " · muted" : ""}`,
    }));
    const selected = setDropdownItems(
      refs.trackSelect,
      refs.trackMenu,
      state.trackItems,
      selectedTrackIndex
    );
    state.trackAvailable = state.trackItems.some((track) => !track.disabled);
    refs.trackSelect.disabled = state.formLocked || !state.trackAvailable;
    setText(refs.inTime, display.inTime);
    setText(refs.outTime, display.outTime);
    setText(refs.durationTime, display.durationTime);
    setText(refs.sequenceInfo, display.sequenceInfo);
    return selected && !selected.disabled ? Number(selected.value) : null;
  }

  function setPremiereError(message) {
    state.trackItems = [];
    state.trackAvailable = false;
    removeAllChildren(refs.trackMenu);
    refs.trackSelect.selectedIndex = -1;
    refs.trackSelect.disabled = true;
    setText(refs.inTime, "—");
    setText(refs.outTime, "—");
    setText(refs.durationTime, "—");
    setText(refs.sequenceInfo, message);
  }

  function setLanguage(language) {
    chooseLanguage(language, false);
  }

  function getJobInputSnapshot() {
    const track = getSelectedItem(refs.trackSelect, state.trackItems);
    const model = getSelectedItem(refs.geminiModel, state.modelItems);
    return Object.freeze({
      trackIndex: track && !track.disabled ? Number(track.value) : null,
      language: state.language,
      geminiModel: model ? safeString(model.value) : "",
      vocabPrompt: safeString(refs.vocabPrompt.value),
      maxWords: updateWordsValue(refs.maxWords.value),
      geminiKey: state.geminiKey.trim(),
    });
  }

  function setRecovery(visible, message) {
    if (message) setText(refs.recoveryText, message);
    setVisible(refs.recoveryCard, visible);
  }

  function setProgress(phase, progress) {
    const bounded = Math.max(0, Math.min(100, Math.round(Number(progress) || 0)));
    const idle = safeString(phase).toLowerCase() === "idle";
    setText(refs.phaseLabel, idle ? "Ready to generate" : phase);
    setText(refs.progressValue, idle ? "—" : `${bounded}%`);
    refs.progressBar.max = 100;
    refs.progressBar.value = bounded;
  }

  function setBusy(busy) {
    state.formLocked = Boolean(busy);
    updateFormLock();
    refs.cancelBtn.disabled = !busy;
  }

  function setGenerateEnabled(enabled) {
    refs.generateBtn.disabled = !enabled;
  }

  function setCancelEnabled(enabled) {
    refs.cancelBtn.disabled = !enabled;
  }

  function renderLogs(lines, reveal) {
    const values = Array.isArray(lines) ? lines : [];
    const visibleLines = values.slice(-120);
    setText(refs.logs, visibleLines.length ? visibleLines.join("\n") : "Job updates will appear here.");
    if (reveal) setLogsOpen(true);
  }

  function hideResult() {
    setVisible(refs.resultCard, false);
  }

  function setResult(result) {
    setText(refs.resultTitle, result.title);
    setText(refs.resultSummary, result.summary);
    setText(refs.resultPath, result.path);
    setVisible(refs.retryImportBtn, Boolean(result.retry));
    setVisible(refs.resultCard, true);
  }

  function setImportComplete(summary) {
    setText(refs.resultTitle, "SRT imported");
    setText(refs.resultSummary, summary);
    setVisible(refs.retryImportBtn, false);
  }

  function showFatal(message) {
    document.body.textContent = "";
    const card = document.createElement("div");
    card.className = "fatal-panel";
    const title = document.createElement("strong");
    title.textContent = "Hinglish SRT could not start";
    const detail = document.createElement("p");
    detail.textContent = safeString(message) || "The panel UI is incomplete. Reload the plugin after restoring its UI files.";
    card.appendChild(title);
    card.appendChild(detail);
    document.body.appendChild(card);
  }

  window.HinglishView = Object.freeze({
    initialize,
    setServerHealth,
    setOptions,
    setPremiereContext,
    setPremiereError,
    setLanguage,
    getJobInputSnapshot,
    setRecovery,
    setProgress,
    setBusy,
    setGenerateEnabled,
    setCancelEnabled,
    renderLogs,
    hideResult,
    setResult,
    setImportComplete,
    showFatal,
  });
})();
