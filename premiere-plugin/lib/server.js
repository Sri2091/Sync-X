const HinglishServer = (() => {
  const BASE_URL = "http://127.0.0.1:8765";

  async function parseError(response) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const payload = await response.json();
      message = payload.detail || payload.error || message;
    } catch {}
    return new Error(message);
  }

  async function request(path, options = {}) {
    const response = await fetch(BASE_URL + path, options);
    if (!response.ok) throw await parseError(response);
    return response;
  }

  async function health() {
    return (await request("/api/v1/health")).json();
  }

  async function options() {
    return (await request("/api/v1/options")).json();
  }

  async function createJob(audioBytes, filename, fields, geminiKey, signal) {
    const body = new FormData();
    body.append("audio", new Blob([audioBytes], { type: "audio/mpeg" }), filename);
    Object.entries(fields).forEach(([key, value]) => body.append(key, String(value)));
    const headers = {};
    if (geminiKey) headers["X-Gemini-API-Key"] = geminiKey;
    const response = await request("/api/v1/jobs", {
      method: "POST",
      headers,
      body,
      signal,
    });
    return response.json();
  }

  async function getJob(jobId) {
    return (await request(`/api/v1/jobs/${encodeURIComponent(jobId)}`)).json();
  }

  async function getResult(jobId) {
    return (await request(`/api/v1/jobs/${encodeURIComponent(jobId)}/result`)).text();
  }

  async function cancelOrDelete(jobId) {
    return (await request(`/api/v1/jobs/${encodeURIComponent(jobId)}`, {
      method: "DELETE",
    })).json();
  }

  return { BASE_URL, health, options, createJob, getJob, getResult, cancelOrDelete };
})();
