"""FastAPI entry point for the local Hinglish SRT processing service."""

from __future__ import annotations

import asyncio
import threading
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from jobs import JobManager
from pipeline import (
    ALLOWED_EXTENSIONS,
    APP_VERSION,
    DEFAULT_VOCAB,
    GEMINI_MODELS,
    MAX_DURATION_SECONDS,
    MAX_UPLOAD_BYTES,
    PipelineError,
    discover_runtime_paths,
    normalize_language,
    normalize_max_words,
    sanitize_label,
    sanitize_stem,
)


BASE_DIR = Path(__file__).resolve().parent
JOBS_ROOT = BASE_DIR / "runtime" / "jobs"
RUNTIME = discover_runtime_paths()
MANAGER = JobManager(JOBS_ROOT, RUNTIME)
_cleanup_stop = threading.Event()


def _cleanup_loop() -> None:
    while not _cleanup_stop.wait(60):
        MANAGER.cleanup_stale(ttl_seconds=3600)


@asynccontextmanager
async def lifespan(_: FastAPI):
    MANAGER.cleanup_stale(ttl_seconds=3600)
    _cleanup_stop.clear()
    thread = threading.Thread(target=_cleanup_loop, name="job-cleanup", daemon=True)
    thread.start()
    yield
    _cleanup_stop.set()


app = FastAPI(
    title="Hinglish SRT Server",
    version=APP_VERSION,
    docs_url="/docs",
    redoc_url=None,
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/api/v1/health")
def health() -> dict[str, object]:
    dependencies = RUNTIME.readiness()
    return {
        "status": "ready" if all(item["ready"] for item in dependencies.values()) else "degraded",
        "version": APP_VERSION,
        "busy": MANAGER.busy,
        "dependencies": dependencies,
    }


@app.get("/api/v1/options")
def options() -> dict[str, object]:
    return {
        "languages": ["Hindi", "English"],
        "gemini_models": GEMINI_MODELS,
        "default_gemini_model": GEMINI_MODELS[0],
        "default_vocabulary": DEFAULT_VOCAB,
        "max_words": {"minimum": 2, "maximum": 20, "default": 6},
        "max_duration_seconds": MAX_DURATION_SECONDS,
        "max_upload_bytes": MAX_UPLOAD_BYTES,
    }


@app.post("/api/v1/jobs", status_code=202)
async def create_job(
    audio: UploadFile = File(...),
    language: str = Form(...),
    gemini_model: str = Form(GEMINI_MODELS[0]),
    vocab_prompt: str = Form(DEFAULT_VOCAB),
    max_words: int = Form(6),
    timeline_offset_ms: int = Form(0),
    project_name: str = Form("Untitled Project"),
    sequence_name: str = Form("Untitled Sequence"),
    track_name: str = Form("A1"),
    source_filename: str = Form("premiere_audio.mp3"),
    x_gemini_api_key: str | None = Header(default=None, alias="X-Gemini-API-Key"),
) -> dict[str, str]:
    try:
        normalized_language = normalize_language(language)
    except PipelineError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if normalized_language == "hi" and not (x_gemini_api_key or "").strip():
        raise HTTPException(status_code=422, detail="Gemini API key is required for Hindi mode.")
    if gemini_model not in GEMINI_MODELS:
        raise HTTPException(status_code=422, detail="Unsupported Gemini model.")
    if timeline_offset_ms < 0:
        raise HTTPException(status_code=422, detail="Timeline offset cannot be negative.")
    # Premiere UXP currently serializes a Blob upload with the literal filename
    # "blob", even when FormData.append receives a filename argument. Prefer the
    # multipart filename when it is usable, then fall back to the separately
    # supplied source filename from the panel.
    upload_name = audio.filename or ""
    source_name = source_filename or ""
    upload_extension = Path(upload_name).suffix.lower()
    source_extension = Path(source_name).suffix.lower()
    if upload_extension in ALLOWED_EXTENSIONS:
        original_name = upload_name
        extension = upload_extension
    elif upload_name.lower() in {"", "blob"} and source_extension in ALLOWED_EXTENSIONS:
        original_name = source_name
        extension = source_extension
    else:
        original_name = upload_name or source_name or "premiere_audio"
        extension = Path(original_name).suffix.lower()
    if extension not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=415, detail="Unsupported audio or media file type.")

    metadata = {
        "project_name": sanitize_label(project_name, "Untitled Project"),
        "sequence_name": sanitize_label(sequence_name, "Untitled Sequence"),
        "track_name": sanitize_label(track_name, "A1"),
        "language": "Hindi" if normalized_language == "hi" else "English",
        "timeline_offset_ms": int(timeline_offset_ms),
    }
    safe_input_name = f"rendered_input{extension}"
    try:
        job = MANAGER.reserve(safe_input_name, metadata)
    except PipelineError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    total = 0
    try:
        with job.input_path.open("wb") as destination:
            while True:
                chunk = await audio.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="Upload exceeds the 64 MB limit.")
                destination.write(chunk)
        if total == 0:
            raise HTTPException(status_code=422, detail="Uploaded audio file is empty.")
        job.add_log(f"Received {total / 1024 / 1024:.1f} MB")
        MANAGER.start(
            job,
            {
                "source_filename": source_filename or original_name,
                "language_value": normalized_language,
                "gemini_model": gemini_model,
                "vocab_prompt": vocab_prompt,
                "max_words": normalize_max_words(max_words),
                "timeline_offset_ms": int(timeline_offset_ms),
            },
            gemini_api_key=(x_gemini_api_key or ""),
        )
        return {"job_id": job.job_id, "state": "queued"}
    except HTTPException:
        MANAGER.abandon(job.job_id)
        raise
    except Exception as exc:
        MANAGER.abandon(job.job_id)
        raise HTTPException(status_code=500, detail=f"Could not store upload: {exc}") from exc
    finally:
        await audio.close()


@app.get("/api/v1/jobs/{job_id}")
def job_status(job_id: str) -> dict[str, object]:
    job = MANAGER.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    return job.public_status()


@app.get("/api/v1/jobs/{job_id}/result")
def job_result(job_id: str) -> FileResponse:
    job = MANAGER.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    if job.state != "complete" or not job.result_path or not job.result_path.is_file():
        raise HTTPException(status_code=409, detail="Job result is not ready.")
    job.downloaded = True
    job.updated_at = __import__("time").time()
    return FileResponse(
        path=job.result_path,
        media_type="application/x-subrip; charset=utf-8",
        filename=job.result_filename or "captions.srt",
    )


@app.delete("/api/v1/jobs/{job_id}")
async def cancel_or_delete_job(job_id: str) -> dict[str, str]:
    try:
        action = MANAGER.cancel_or_delete(job_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Job not found.") from exc
    if action == "cancellation_requested":
        for _ in range(50):
            job = MANAGER.get(job_id)
            if not job or job.state == "cancelled":
                break
            await asyncio.sleep(0.1)
    return {"job_id": job_id, "status": action}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="127.0.0.1", port=8765, reload=False)
