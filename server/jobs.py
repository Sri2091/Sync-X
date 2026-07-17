"""Single-worker in-memory job manager for the localhost prototype."""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from pipeline import JobCancelled, PipelineError, RuntimePaths, process_audio


TERMINAL_STATES = {"complete", "failed", "cancelled"}
ACTIVE_STATES = {
    "queued",
    "converting",
    "transcribing",
    "cleaning",
    "converting_hinglish",
    "writing",
}


@dataclass
class Job:
    job_id: str
    work_dir: Path
    input_path: Path
    metadata: dict[str, Any]
    state: str = "queued"
    phase: str = "queued"
    progress: int = 0
    logs: list[str] = field(default_factory=list)
    result_path: Path | None = None
    result_filename: str | None = None
    caption_count: int | None = None
    audio_duration_seconds: float | None = None
    error: str | None = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    downloaded: bool = False
    cancel_event: threading.Event = field(default_factory=threading.Event)
    _process: subprocess.Popen[str] | None = None
    _lock: threading.RLock = field(default_factory=threading.RLock)

    def add_log(self, message: str) -> None:
        message = str(message).strip()
        if not message:
            return
        with self._lock:
            stamp = time.strftime("%H:%M:%S")
            self.logs.append(f"[{stamp}] {message}")
            self.logs = self.logs[-500:]
            self.updated_at = time.time()

    def update(self, phase: str, progress: int, message: str) -> None:
        with self._lock:
            self.phase = phase
            self.state = phase
            self.progress = max(0, min(100, int(progress)))
            self.updated_at = time.time()
        self.add_log(message)

    def attach_process(self, process: subprocess.Popen[str] | None) -> None:
        with self._lock:
            self._process = process
            should_cancel = self.cancel_event.is_set() and process is not None
        if should_cancel:
            self._terminate_process(process)

    @staticmethod
    def _terminate_process(process: subprocess.Popen[str]) -> None:
        if process.poll() is not None:
            return
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            try:
                process.terminate()
            except ProcessLookupError:
                pass

    def request_cancel(self) -> None:
        self.cancel_event.set()
        self.add_log("Cancellation requested")
        with self._lock:
            process = self._process
        if process is not None:
            self._terminate_process(process)

    def public_status(self) -> dict[str, Any]:
        with self._lock:
            return {
                "job_id": self.job_id,
                "state": self.state,
                "phase": self.phase,
                "progress": self.progress,
                "logs": list(self.logs),
                "result_ready": self.result_path is not None and self.result_path.is_file(),
                "result_filename": self.result_filename,
                "caption_count": self.caption_count,
                "audio_duration_seconds": self.audio_duration_seconds,
                "error": self.error,
                "metadata": dict(self.metadata),
                "created_at": self.created_at,
                "updated_at": self.updated_at,
            }


class JobManager:
    def __init__(self, jobs_root: Path, runtime: RuntimePaths):
        self.jobs_root = jobs_root
        self.runtime = runtime
        self.jobs_root.mkdir(parents=True, exist_ok=True)
        self._jobs: dict[str, Job] = {}
        self._lock = threading.RLock()

    @property
    def busy(self) -> bool:
        with self._lock:
            return any(job.state in ACTIVE_STATES for job in self._jobs.values())

    def reserve(self, input_filename: str, metadata: dict[str, Any]) -> Job:
        with self._lock:
            if self.busy:
                raise PipelineError("The server already has an active job.")
            job_id = uuid.uuid4().hex
            work_dir = self.jobs_root / job_id
            work_dir.mkdir(parents=True, exist_ok=False)
            input_path = work_dir / input_filename
            job = Job(job_id=job_id, work_dir=work_dir, input_path=input_path, metadata=metadata)
            job.add_log("Job accepted")
            self._jobs[job_id] = job
            return job

    def abandon(self, job_id: str) -> None:
        with self._lock:
            job = self._jobs.pop(job_id, None)
        if job:
            shutil.rmtree(job.work_dir, ignore_errors=True)

    def start(self, job: Job, pipeline_args: dict[str, Any], gemini_api_key: str) -> None:
        thread = threading.Thread(
            target=self._run,
            args=(job, pipeline_args, gemini_api_key),
            name=f"hinglish-job-{job.job_id[:8]}",
            daemon=True,
        )
        thread.start()

    def _run(self, job: Job, pipeline_args: dict[str, Any], gemini_api_key: str) -> None:
        try:
            output_path, count, duration = process_audio(
                input_path=job.input_path,
                work_dir=job.work_dir,
                gemini_api_key=gemini_api_key,
                cancel_event=job.cancel_event,
                progress=job.update,
                attach_process=job.attach_process,
                runtime=self.runtime,
                **pipeline_args,
            )
            if job.cancel_event.is_set():
                raise JobCancelled("Job cancelled.")
            with job._lock:
                job.result_path = output_path
                job.result_filename = output_path.name
                job.caption_count = count
                job.audio_duration_seconds = duration
                job.state = "complete"
                job.phase = "complete"
                job.progress = 100
                job.updated_at = time.time()
            job.add_log(f"Complete — {count} captions ready")
            self._remove_intermediates(job)
        except JobCancelled:
            with job._lock:
                job.state = "cancelled"
                job.phase = "cancelled"
                job.error = None
                job.updated_at = time.time()
            job.add_log("Job cancelled")
            shutil.rmtree(job.work_dir, ignore_errors=True)
        except Exception as exc:
            message = str(exc) if isinstance(exc, PipelineError) else f"Unexpected error: {exc}"
            with job._lock:
                job.state = "failed"
                job.phase = "failed"
                job.error = message
                job.updated_at = time.time()
            job.add_log(f"Error: {message}")
            self._remove_intermediates(job, keep_result=False)
        finally:
            gemini_api_key = ""
            job.attach_process(None)

    @staticmethod
    def _remove_intermediates(job: Job, keep_result: bool = True) -> None:
        result = job.result_path.resolve() if keep_result and job.result_path else None
        for child in list(job.work_dir.iterdir()) if job.work_dir.exists() else []:
            if result and child.resolve() == result:
                continue
            if child.is_dir():
                shutil.rmtree(child, ignore_errors=True)
            else:
                child.unlink(missing_ok=True)

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def cancel_or_delete(self, job_id: str) -> str:
        job = self.get(job_id)
        if not job:
            raise KeyError(job_id)
        if job.state in ACTIVE_STATES:
            job.request_cancel()
            return "cancellation_requested"
        self.abandon(job_id)
        return "deleted"

    def cleanup_stale(self, ttl_seconds: int = 3600) -> int:
        cutoff = time.time() - ttl_seconds
        stale: list[str] = []
        with self._lock:
            for job_id, job in self._jobs.items():
                if job.state in TERMINAL_STATES and job.updated_at < cutoff:
                    stale.append(job_id)
        for job_id in stale:
            self.abandon(job_id)

        known = set(self._jobs)
        for directory in self.jobs_root.iterdir() if self.jobs_root.exists() else []:
            if not directory.is_dir() or directory.name in known:
                continue
            try:
                if directory.stat().st_mtime < cutoff:
                    shutil.rmtree(directory, ignore_errors=True)
            except FileNotFoundError:
                pass
        return len(stale)

