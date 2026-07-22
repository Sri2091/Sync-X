const SyncXStorage = (() => {
  const nodeFs = require("fs");
  const os = require("os");

  function fileUrl(nativePath) {
    return "file://" + nativePath;
  }

  function joinPath(...parts) {
    return parts
      .filter((part) => part != null && String(part) !== "")
      .map((part, index) => {
        const value = String(part);
        return index === 0 ? value.replace(/\/+$/g, "") : value.replace(/^\/+|\/+$/g, "");
      })
      .join("/");
  }

  function safeSegment(value, fallback) {
    const cleaned = String(value || fallback)
      .replace(/\.prproj$/i, "")
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/\s+/g, " ")
      .replace(/^[ ._-]+|[ ._-]+$/g, "")
      .slice(0, 100);
    return cleaned || fallback;
  }

  async function ensureDirectory(nativePath) {
    const url = fileUrl(nativePath);
    try {
      await nodeFs.mkdir(url, { recursive: true });
    } catch (error) {
      try {
        nodeFs.readdirSync(url);
        return;
      } catch {}
      throw error;
    }
  }

  async function readNativeFile(nativePath) {
    return nodeFs.readFile(fileUrl(nativePath));
  }

  async function deleteNativeFile(nativePath) {
    if (!nativePath) return;
    try { await nodeFs.unlink(fileUrl(nativePath)); } catch {}
  }

  function listFiles(nativePath) {
    try { return nodeFs.readdirSync(fileUrl(nativePath)); } catch { return []; }
  }

  function nextResultName(metadata, existingProjectNames, outputDirectory) {
    const sequence = safeSegment(metadata.sequence_name, "Untitled Sequence");
    const track = safeSegment(metadata.track_name, "A1");
    const mode = metadata.language === "Hindi" ? "HINGLISH" : "EN";
    const base = `${sequence}_${track}_${mode}`;
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^${escaped}_(\\d+)\\.srt$`, "i");
    let maximum = 0;
    [...listFiles(outputDirectory), ...(existingProjectNames || [])].forEach((name) => {
      const match = String(name).match(pattern);
      if (match) maximum = Math.max(maximum, Number.parseInt(match[1], 10) || 0);
    });
    return `${base}_${maximum + 1}.srt`;
  }

  async function saveResult(srtText, metadata, existingProjectNames) {
    const project = safeSegment(metadata.project_name, "Untitled Project");
    const sequence = safeSegment(metadata.sequence_name, "Untitled Sequence");
    const directory = joinPath(
      os.homedir(),
      "Documents",
      "Sync-X Outputs",
      project,
      sequence
    );
    await ensureDirectory(directory);
    const filename = nextResultName(metadata, existingProjectNames, directory);
    const nativePath = joinPath(directory, filename);
    await nodeFs.writeFile(fileUrl(nativePath), srtText, { encoding: "utf-8" });
    return { nativePath, filename, directory };
  }

  return Object.freeze({
    safeSegment,
    ensureDirectory,
    readNativeFile,
    deleteNativeFile,
    nextResultName,
    saveResult,
  });
})();
