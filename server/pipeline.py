"""Audio-to-SRT processing pipeline for the Hinglish SRT localhost server."""

from __future__ import annotations

import importlib.util
import json
import os
import re
import shutil
import signal
import subprocess
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

from timing import (
    SILENCE_BOUNDARY_MS,
    TimingError,
    build_balanced_captions,
    display_word_count,
    normalize_timed_words as _normalize_timed_words,
)

APP_VERSION = "2.1.0"
MAX_DURATION_SECONDS = 30 * 60
MAX_UPLOAD_BYTES = 64 * 1024 * 1024
VAD_MIN_SILENCE_MS = 250
VAD_SPEECH_PAD_MS = 50
GEMINI_BATCH_SOURCE_WORDS = 50

DEFAULT_VOCAB = (
    "CapMint, CapMint Insights, Scalper Mode, Reverse Mode, Trade Via Charts, "
    "Insights, trading, feedback loop, performance index, brokerage, "
    "bifurcated, directional, improvement, download"
)

GEMINI_MODELS = [
    "gemini-3-flash-preview",
    "gemini-3.1-flash-lite",
    "gemini-2.5-pro",
]

ALLOWED_EXTENSIONS = {
    ".mp3",
    ".wav",
    ".m4a",
    ".aac",
    ".flac",
    ".webm",
    ".mp4",
    ".mov",
}


class PipelineError(RuntimeError):
    """An expected processing failure that is safe to return to the panel."""


class JobCancelled(PipelineError):
    """Raised when a job cancellation request is observed."""


@dataclass(frozen=True)
class RuntimePaths:
    whisper_cli: Path
    ffmpeg: Path
    ffprobe: Path
    whisper_model: Path
    whisper_vad_model: Path

    def readiness(self) -> dict[str, dict[str, object]]:
        return {
            "whisper_cli": {
                "ready": self.whisper_cli.is_file(),
                "path": str(self.whisper_cli),
            },
            "ffmpeg": {
                "ready": self.ffmpeg.is_file(),
                "path": str(self.ffmpeg),
            },
            "ffprobe": {
                "ready": self.ffprobe.is_file(),
                "path": str(self.ffprobe),
            },
            "whisper_model": {
                "ready": self.whisper_model.is_file(),
                "path": str(self.whisper_model),
            },
            "whisper_vad_model": {
                "ready": self.whisper_vad_model.is_file(),
                "path": str(self.whisper_vad_model),
            },
            "google_genai": {
                "ready": importlib.util.find_spec("google.genai") is not None,
                "path": "python package",
            },
        }

    def missing(self, needs_gemini: bool) -> list[str]:
        checks = self.readiness()
        required = ["whisper_cli", "ffmpeg", "ffprobe", "whisper_model"]
        if needs_gemini:
            required.extend(["whisper_vad_model", "google_genai"])
        return [name for name in required if not checks[name]["ready"]]


def _discover_executable(env_name: str, command: str, fallback: str) -> Path:
    configured = os.environ.get(env_name, "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    discovered = shutil.which(command)
    return Path(discovered or fallback).expanduser().resolve()


def discover_runtime_paths() -> RuntimePaths:
    ffmpeg = _discover_executable("HINGLISH_FFMPEG", "ffmpeg", "/opt/homebrew/bin/ffmpeg")
    ffprobe_default = str(ffmpeg.with_name("ffprobe"))
    return RuntimePaths(
        whisper_cli=_discover_executable(
            "HINGLISH_WHISPER_CLI", "whisper-cli", "/opt/homebrew/bin/whisper-cli"
        ),
        ffmpeg=ffmpeg,
        ffprobe=_discover_executable("HINGLISH_FFPROBE", "ffprobe", ffprobe_default),
        whisper_model=Path(
            os.environ.get(
                "HINGLISH_WHISPER_MODEL",
                "~/.cache/whisper-cpp/ggml-large-v3.bin",
            )
        ).expanduser().resolve(),
        whisper_vad_model=Path(
            os.environ.get(
                "HINGLISH_WHISPER_VAD_MODEL",
                "~/.cache/whisper-cpp/ggml-silero-v6.2.0.bin",
            )
        ).expanduser().resolve(),
    )


def sanitize_stem(value: str, fallback: str = "premiere_audio") -> str:
    stem = Path(value or fallback).stem
    stem = re.sub(r"[^A-Za-z0-9._ -]+", "_", stem)
    stem = re.sub(r"\s+", " ", stem).strip(" ._-")
    return (stem or fallback)[:120]


def sanitize_label(value: str, fallback: str) -> str:
    """Sanitize project metadata without treating dots as file extensions."""
    cleaned = re.sub(r"[^A-Za-z0-9._ -]+", "_", str(value or fallback))
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" ._-")
    return (cleaned or fallback)[:120]


def normalize_language(value: str) -> str:
    normalized = (value or "").strip().lower()
    if normalized in {"hi", "hindi"}:
        return "hi"
    if normalized in {"en", "english"}:
        return "en"
    raise PipelineError("Language must be Hindi or English.")


def normalize_max_words(value: object) -> int:
    try:
        parsed = int(float(value))
    except (TypeError, ValueError):
        parsed = 6
    return min(20, max(2, parsed))


def time_to_ms(value: str) -> int:
    hours, minutes, rest = value.split(":")
    seconds, millis = rest.replace(".", ",").split(",")
    return (
        int(hours) * 3_600_000
        + int(minutes) * 60_000
        + int(seconds) * 1_000
        + int(millis)
    )


def ms_to_time(value: int) -> str:
    value = max(0, int(value))
    hours, value = divmod(value, 3_600_000)
    minutes, value = divmod(value, 60_000)
    seconds, millis = divmod(value, 1_000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{millis:03d}"


def parse_srt(filepath: Path) -> list[dict[str, str]]:
    content = filepath.read_text(encoding="utf-8", errors="replace").strip()
    blocks = re.split(r"\r?\n\s*\r?\n+", content)
    entries: list[dict[str, str]] = []
    pattern = re.compile(
        r"(\d{2,}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*"
        r"(\d{2,}:\d{2}:\d{2}[,.]\d{3})"
    )
    for block in blocks:
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        if len(lines) < 2:
            continue
        timestamp_index = next((i for i, line in enumerate(lines) if "-->" in line), -1)
        if timestamp_index < 0 or timestamp_index + 1 >= len(lines):
            continue
        match = pattern.match(lines[timestamp_index])
        if not match:
            continue
        entries.append(
            {
                "start": match.group(1).replace(".", ","),
                "end": match.group(2).replace(".", ","),
                "text": " ".join(lines[timestamp_index + 1 :]).strip(),
            }
        )
    return entries


def normalize_timed_words(
    entries: Iterable[dict[str, object]],
    speech_intervals: list[tuple[int, int]] | None = None,
) -> list[dict[str, object]]:
    """Expose the stable word-normalization layer with this module's parser."""
    try:
        return _normalize_timed_words(
            entries,
            speech_intervals=speech_intervals,
            silence_ms=SILENCE_BOUNDARY_MS,
            time_to_ms=time_to_ms,
        )
    except TimingError as exc:
        raise PipelineError(str(exc)) from exc


def parse_vad_speech_intervals(log_text: str) -> list[tuple[int, int]]:
    """Extract original-audio speech ranges reported by whisper.cpp VAD."""
    pattern = re.compile(
        r"VAD segment\s+\d+:\s*start\s*=\s*([0-9]+(?:\.[0-9]+)?),\s*"
        r"end\s*=\s*([0-9]+(?:\.[0-9]+)?)"
    )
    intervals: list[tuple[int, int]] = []
    for start_value, end_value in pattern.findall(log_text or ""):
        start_ms = round(float(start_value) * 1000)
        end_ms = round(float(end_value) * 1000)
        if end_ms <= start_ms:
            continue
        interval = (start_ms, end_ms)
        if not intervals or interval != intervals[-1]:
            intervals.append(interval)
    return intervals


def _split_word_counts(total_words: int, durations: list[int]) -> list[int]:
    """Allocate words across speech overlaps while keeping their order."""
    if total_words <= 0 or not durations:
        return [0] * len(durations)
    if total_words < len(durations):
        counts = [0] * len(durations)
        counts[max(range(len(durations)), key=durations.__getitem__)] = total_words
        return counts

    counts = [1] * len(durations)
    remaining = total_words - len(durations)
    if remaining <= 0:
        return counts
    duration_total = max(1, sum(durations))
    exact = [remaining * duration / duration_total for duration in durations]
    floors = [int(value) for value in exact]
    for index, value in enumerate(floors):
        counts[index] += value
    leftover = remaining - sum(floors)
    order = sorted(
        range(len(durations)),
        key=lambda index: (exact[index] - floors[index], durations[index]),
        reverse=True,
    )
    for index in order[:leftover]:
        counts[index] += 1
    return counts


def constrain_entries_to_speech(
    entries: Iterable[dict[str, str]],
    speech_intervals: list[tuple[int, int]],
    minimum_overlap_ms: int = 80,
) -> list[dict[str, str]]:
    """Keep subtitle text inside VAD speech ranges and preserve real silences.

    whisper.cpp maps VAD timestamps back to the original audio, but a decoded
    subtitle cue can still straddle two concatenated speech regions. This
    function treats the VAD ranges as hard timing boundaries. A cue dominated
    by one region is moved wholly into that region; genuinely shared cues are
    split word-wise across their speech overlaps.
    """
    if not speech_intervals:
        return [entry.copy() for entry in entries]

    normalized_intervals = sorted(
        (max(0, int(start)), max(0, int(end)))
        for start, end in speech_intervals
        if int(end) > int(start)
    )
    output: list[dict[str, str]] = []
    for entry in entries:
        words = entry["text"].split()
        if not words:
            continue
        entry_start = time_to_ms(entry["start"])
        entry_end = max(entry_start + 1, time_to_ms(entry["end"]))
        overlaps: list[tuple[int, int, int]] = []
        for speech_start, speech_end in normalized_intervals:
            overlap_start = max(entry_start, speech_start)
            overlap_end = min(entry_end, speech_end)
            overlap_duration = overlap_end - overlap_start
            if overlap_duration >= minimum_overlap_ms:
                overlaps.append((overlap_start, overlap_end, overlap_duration))
        if not overlaps:
            continue

        if len(overlaps) == 1:
            overlap_start, overlap_end, _ = overlaps[0]
            output.append(
                {
                    "start": ms_to_time(overlap_start),
                    "end": ms_to_time(overlap_end),
                    "text": entry["text"],
                }
            )
            continue

        durations = [overlap[2] for overlap in overlaps]
        dominant_index = max(range(len(overlaps)), key=durations.__getitem__)
        dominant_duration = durations[dominant_index]
        other_duration = sum(durations) - dominant_duration
        if dominant_duration / max(1, sum(durations)) >= 0.75 or other_duration < 500:
            overlap_start, overlap_end, _ = overlaps[dominant_index]
            output.append(
                {
                    "start": ms_to_time(overlap_start),
                    "end": ms_to_time(overlap_end),
                    "text": entry["text"],
                }
            )
            continue

        counts = _split_word_counts(len(words), durations)
        cursor = 0
        for (overlap_start, overlap_end, _), count in zip(overlaps, counts):
            if count <= 0:
                continue
            chunk = words[cursor : cursor + count]
            cursor += count
            output.append(
                {
                    "start": ms_to_time(overlap_start),
                    "end": ms_to_time(overlap_end),
                    "text": " ".join(chunk),
                }
            )
    return output


def merge_broken_words(
    entries: list[dict[str, str]], max_join_gap_ms: int = 80
) -> list[dict[str, str]]:
    if not entries:
        return []
    merged = [entries[0].copy()]
    for entry in entries[1:]:
        previous = merged[-1]
        previous_text = previous["text"]
        current_text = entry["text"]
        # Whisper runs with --split-on-word, so lowercase segment boundaries
        # are normally real word boundaries. Only join an explicit hyphenated
        # continuation; the legacy lowercase heuristic joined "word" and
        # "next" into "wordnext".
        gap_ms = time_to_ms(entry["start"]) - time_to_ms(previous["end"])
        if (
            previous_text.endswith(("-", "‐", "‑"))
            and current_text
            and 0 <= gap_ms <= max_join_gap_ms
        ):
            previous["text"] = previous_text[:-1] + current_text.lstrip()
            previous["end"] = entry["end"]
            continue
        merged.append(entry.copy())

    for entry in merged:
        entry["text"] = re.sub(r"\s+", " ", entry["text"]).strip()
    return [entry for entry in merged if entry["text"]]


def split_entries(
    entries: Iterable[dict[str, object]], max_words: int, offset_ms: int = 0
) -> list[dict[str, str]]:
    materialized = [dict(entry) for entry in entries]
    if not materialized:
        return []
    if "start_ms" not in materialized[0]:
        materialized = normalize_timed_words(materialized)
    try:
        captions = build_balanced_captions(
            materialized,
            max_words=normalize_max_words(max_words),
            offset_ms=int(offset_ms),
        )
    except TimingError as exc:
        raise PipelineError(str(exc)) from exc
    return [
        {
            "start": ms_to_time(int(caption["start_ms"])),
            "end": ms_to_time(int(caption["end_ms"])),
            "text": str(caption["text"]),
        }
        for caption in captions
    ]


def write_srt(
    entries: Iterable[dict[str, object]],
    output_path: Path,
    max_words: int,
    offset_ms: int = 0,
) -> int:
    final_entries = split_entries(entries, max_words=max_words, offset_ms=offset_ms)
    with output_path.open("w", encoding="utf-8", newline="\n") as handle:
        for index, entry in enumerate(final_entries, 1):
            handle.write(f"{index}\n")
            handle.write(f"{entry['start']} --> {entry['end']}\n")
            handle.write(f"{entry['text']}\n\n")
    return len(final_entries)


def _check_cancel(cancel_event: threading.Event) -> None:
    if cancel_event.is_set():
        raise JobCancelled("Job cancelled.")


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


def run_process(
    command: list[str],
    cancel_event: threading.Event,
    attach_process: Callable[[subprocess.Popen[str] | None], None],
    on_line: Callable[[str], None] | None = None,
) -> str:
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
        start_new_session=True,
    )
    attach_process(process)
    lines: list[str] = []
    try:
        assert process.stdout is not None
        for raw_line in process.stdout:
            line = raw_line.rstrip()
            if line:
                lines.append(line)
                if on_line:
                    on_line(line)
            if cancel_event.is_set():
                _terminate_process(process)
        return_code = process.wait()
        _check_cancel(cancel_event)
        if return_code != 0:
            detail = "\n".join(lines[-20:])
            raise PipelineError(
                f"Command failed with exit code {return_code}."
                + (f"\n{detail}" if detail else "")
            )
        return "\n".join(lines)
    finally:
        attach_process(None)


def probe_duration(
    input_path: Path,
    runtime: RuntimePaths,
    cancel_event: threading.Event,
    attach_process: Callable[[subprocess.Popen[str] | None], None],
) -> float:
    output = run_process(
        [
            str(runtime.ffprobe),
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(input_path),
        ],
        cancel_event,
        attach_process,
    )
    try:
        duration = float(output.strip().splitlines()[-1])
    except (ValueError, IndexError) as exc:
        raise PipelineError("Could not determine the rendered audio duration.") from exc
    if duration <= 0:
        raise PipelineError("The rendered audio has no usable duration.")
    if duration > MAX_DURATION_SECONDS + 1:
        raise PipelineError("The selected range exceeds the 30-minute prototype limit.")
    return duration


def convert_to_wav(
    input_path: Path,
    output_path: Path,
    runtime: RuntimePaths,
    cancel_event: threading.Event,
    attach_process: Callable[[subprocess.Popen[str] | None], None],
) -> None:
    run_process(
        [
            str(runtime.ffmpeg),
            "-y",
            "-i",
            str(input_path),
            "-vn",
            "-ar",
            "16000",
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            str(output_path),
        ],
        cancel_event,
        attach_process,
    )


def run_whisper(
    wav_path: Path,
    output_base: Path,
    runtime: RuntimePaths,
    language: str,
    vocab_prompt: str,
    max_words: int,
    cancel_event: threading.Event,
    attach_process: Callable[[subprocess.Popen[str] | None], None],
    on_line: Callable[[str], None],
) -> tuple[Path, list[tuple[int, int]]]:
    # ``max_words`` is intentionally not used here.  Recognition always emits
    # stable word anchors; the panel setting is applied only by the final
    # balanced caption builder.
    _ = max_words
    command = [
        str(runtime.whisper_cli),
        "-m",
        str(runtime.whisper_model),
        "-l",
        language,
        "--output-srt",
        "--output-file",
        str(output_base),
        "--max-len",
        "1",
        "--split-on-word",
        "--flash-attn",
    ]
    if language == "hi":
        command.extend(
            [
                "--vad",
                "--vad-model",
                str(runtime.whisper_vad_model),
                "--vad-min-silence-duration-ms",
                str(VAD_MIN_SILENCE_MS),
                "--vad-speech-pad-ms",
                str(VAD_SPEECH_PAD_MS),
            ]
        )
        on_line(
            "Silero VAD enabled for Hindi timing "
            f"(minimum silence {VAD_MIN_SILENCE_MS} ms)"
        )
    command.extend(["-f", str(wav_path)])
    if vocab_prompt.strip():
        command.extend(["--prompt", vocab_prompt.strip()])
    process_output = ""
    try:
        process_output = run_process(
            command, cancel_event, attach_process, on_line=on_line
        )
    except PipelineError as exc:
        detail = str(exc).lower()
        gpu_failure = (
            "ggml_metal" in detail
            or "metal buffer" in detail
            or "failed to allocate buffer" in detail
            or "exit code -11" in detail
        )
        if not gpu_failure or cancel_event.is_set():
            raise
        on_line("GPU/Metal model load failed; retrying Whisper once on CPU…")
        cpu_command = command.copy()
        cpu_command.insert(1, "--no-gpu")
        process_output = run_process(
            cpu_command, cancel_event, attach_process, on_line=on_line
        )
    srt_path = output_base.with_suffix(".srt")
    if not srt_path.is_file():
        raise PipelineError("Whisper completed without producing an SRT file.")
    speech_intervals = (
        parse_vad_speech_intervals(process_output) if language == "hi" else []
    )
    if language == "hi" and not speech_intervals:
        on_line(
            "Warning: Silero VAD reported no usable intervals; "
            "using native 250 ms word gaps without dropping recognized text."
        )
    return srt_path, speech_intervals


_GEMINI_RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "units": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "source_ids": {
                        "type": "array",
                        "items": {"type": "string"},
                        "minItems": 1,
                    },
                    "text": {"type": "string", "minLength": 1},
                },
                "required": ["source_ids", "text"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["units"],
    "additionalProperties": False,
}


class _GeminiMappingError(ValueError):
    """A syntactically valid response that fails source-word semantics."""


def _gemini_batches(
    words: list[dict[str, object]],
    maximum_source_words: int = GEMINI_BATCH_SOURCE_WORDS,
) -> list[list[dict[str, object]]]:
    """Batch whole speech blocks; a real silence is never crossed mid-batch."""
    blocks: list[list[dict[str, object]]] = []
    for word in words:
        if not blocks or blocks[-1][-1]["block"] != word["block"]:
            blocks.append([word])
        else:
            blocks[-1].append(word)
    batches: list[list[dict[str, object]]] = []
    current: list[dict[str, object]] = []
    for block in blocks:
        if current and len(current) + len(block) > maximum_source_words:
            batches.append(current)
            current = []
        current.extend(block)
        # A single uninterrupted speech block stays intact even if it is
        # unusually long; splitting it would invent a silence boundary.
        if len(current) >= maximum_source_words:
            batches.append(current)
            current = []
    if current:
        batches.append(current)
    return batches


def _hinglish_prompt(batch: list[dict[str, object]]) -> str:
    source = [
        {
            "id": str(word["id"]),
            "block": int(word["block"]),
            "text": str(word["text"]),
        }
        for word in batch
    ]
    return f"""Convert the SOURCE WORDS from Hindi (Devanagari) to natural Hinglish (Hindi in Roman/English script).

TRANSLITERATION RULES:
- Use natural Indian chat spelling, not academic transliteration.
- Examples: नहीं → nahi, क्या → kya, है → hai, मैं → main, और → aur, इसलिए → isliye, एक → ek.
- Keep existing English words as English. Convert English written in Devanagari to the intended English word.
- Preserve meaning and order. Do not paraphrase, summarize, invent, or omit speech.

BRAND / PHRASE PRESERVATION (exact spelling and capitalization):
- CapMint
- CapMint Insights
- Scalper Mode
- CapMint Scalper Mode
- Reverse Mode
- CapMint Reverse Mode
- Trade Via Charts
- CapMint Trade Via Charts

Correct variants such as "Cap Mint", "capmint", "Kapmint", or "Cap Mind" to "CapMint";
"Scaler Mode" to "Scalper Mode"; "Riverse Mode" to "Reverse Mode"; and
"Trade Via Chart" to "Trade Via Charts".

ALIGNMENT CONTRACT:
- Return JSON matching the supplied schema: {{"units":[{{"source_ids":["w000000"],"text":"..."}}]}}.
- Every source ID must occur exactly once, in the original order.
- A unit may consume multiple CONTIGUOUS source IDs only when the converted
  expression must be joined or corrected (for example Cap + Mint → CapMint).
- One source ID may produce multiple Roman-script words inside one unit.
- Never combine IDs from different block values. A block change is a real silence.
- Text must be non-empty. Do not return explanations or markdown.

SOURCE WORDS:
{json.dumps(source, ensure_ascii=False, separators=(",", ":"))}
"""


def _response_json(response: object) -> object:
    parsed = getattr(response, "parsed", None)
    if parsed is not None:
        if hasattr(parsed, "model_dump"):
            return parsed.model_dump()
        return parsed
    output_text = (getattr(response, "text", None) or "").strip()
    if not output_text:
        raise _GeminiMappingError("Gemini returned an empty response")
    try:
        return json.loads(output_text)
    except json.JSONDecodeError as exc:
        raise _GeminiMappingError("Gemini returned invalid JSON") from exc


def _validate_gemini_mapping(
    payload: object, source_words: list[dict[str, object]]
) -> list[dict[str, object]]:
    if not isinstance(payload, dict) or not isinstance(payload.get("units"), list):
        raise _GeminiMappingError("Gemini response has no units array")
    raw_units = payload["units"]
    expected_ids = [str(word["id"]) for word in source_words]
    source_by_id = {str(word["id"]): word for word in source_words}
    cursor = 0
    converted: list[dict[str, object]] = []
    for raw_unit in raw_units:
        if not isinstance(raw_unit, dict):
            raise _GeminiMappingError("Gemini returned a malformed conversion unit")
        source_ids = raw_unit.get("source_ids")
        text = re.sub(r"\s+", " ", str(raw_unit.get("text") or "")).strip()
        if (
            not isinstance(source_ids, list)
            or not source_ids
            or not all(isinstance(source_id, str) for source_id in source_ids)
        ):
            raise _GeminiMappingError("A Gemini unit has invalid source IDs")
        if not text or display_word_count(text) < 1:
            raise _GeminiMappingError("A Gemini unit has empty converted text")
        expected_slice = expected_ids[cursor : cursor + len(source_ids)]
        if source_ids != expected_slice:
            raise _GeminiMappingError(
                "Gemini source IDs were omitted, duplicated, reordered, or non-contiguous"
            )
        source_group = [source_by_id[source_id] for source_id in source_ids]
        blocks = {int(word["block"]) for word in source_group}
        if len(blocks) != 1:
            raise _GeminiMappingError(
                "Gemini combined source words across a real silence boundary"
            )
        converted.append(
            {
                "source_ids": source_ids.copy(),
                "text": text,
                "start_ms": int(source_group[0]["start_ms"]),
                "end_ms": int(source_group[-1]["end_ms"]),
                "block": int(source_group[0]["block"]),
            }
        )
        cursor += len(source_ids)
    if cursor != len(expected_ids):
        raise _GeminiMappingError(
            "Gemini omitted one or more source word IDs"
        )
    return converted


def _create_genai_client(api_key: str):
    try:
        from google import genai
    except ImportError as exc:
        raise PipelineError(
            "google-genai is not installed in the server environment."
        ) from exc
    return genai.Client(api_key=api_key)


def convert_to_hinglish(
    entries: list[dict[str, object]],
    api_key: str,
    model_name: str,
    cancel_event: threading.Event,
) -> list[dict[str, object]]:
    _check_cancel(cancel_event)
    if not api_key.strip():
        raise PipelineError("Gemini API key is required for Hindi mode.")
    if model_name not in GEMINI_MODELS:
        raise PipelineError("Unsupported Gemini model.")

    words = [dict(entry) for entry in entries]
    if words and "start_ms" not in words[0]:
        words = normalize_timed_words(words)
    if not words:
        return []

    client = _create_genai_client(api_key.strip())
    result: list[dict[str, object]] = []
    for batch_number, batch in enumerate(_gemini_batches(words), 1):
        base_prompt = _hinglish_prompt(batch)
        prompt = base_prompt
        last_error: _GeminiMappingError | None = None
        for attempt in range(2):
            _check_cancel(cancel_event)
            try:
                response = client.models.generate_content(
                    model=model_name,
                    contents=prompt,
                    config={
                        "response_mime_type": "application/json",
                        "response_json_schema": _GEMINI_RESPONSE_SCHEMA,
                    },
                )
            except Exception as exc:
                if attempt == 0:
                    # Free-tier and preview Gemini endpoints can fail
                    # transiently. Retry the same bounded batch once without
                    # exposing provider details or the API key to job logs.
                    cancel_event.wait(1.0)
                    _check_cancel(cancel_event)
                    continue
                raise PipelineError(
                    "Gemini conversion request failed. Check the key, model, "
                    "and internet connection, then try again."
                ) from exc
            _check_cancel(cancel_event)
            try:
                converted = _validate_gemini_mapping(
                    _response_json(response), batch
                )
            except _GeminiMappingError as exc:
                last_error = exc
                if attempt == 0:
                    prompt = (
                        base_prompt
                        + "\n\nRETRY CORRECTION:\n"
                        + str(exc)
                        + ". Regenerate the entire batch and obey every "
                        "source-ID rule exactly."
                    )
                    continue
                break
            result.extend(converted)
            last_error = None
            break
        if last_error is not None:
            raise PipelineError(
                "Gemini word alignment failed after one retry "
                f"(batch {batch_number}): {last_error}. "
                "No partial SRT was written."
            ) from last_error
    return result


ProgressCallback = Callable[[str, int, str], None]
ProcessCallback = Callable[[subprocess.Popen[str] | None], None]


def process_audio(
    *,
    input_path: Path,
    work_dir: Path,
    source_filename: str,
    language_value: str,
    gemini_api_key: str,
    gemini_model: str,
    vocab_prompt: str,
    max_words: int,
    timeline_offset_ms: int,
    cancel_event: threading.Event,
    progress: ProgressCallback,
    attach_process: ProcessCallback,
    runtime: RuntimePaths | None = None,
) -> tuple[Path, int, float]:
    runtime = runtime or discover_runtime_paths()
    language = normalize_language(language_value)
    needs_gemini = language == "hi"
    missing = runtime.missing(needs_gemini=needs_gemini)
    if missing:
        raise PipelineError("Missing server dependencies: " + ", ".join(missing))
    if needs_gemini and not gemini_api_key.strip():
        raise PipelineError("Gemini API key is required for Hindi mode.")
    if timeline_offset_ms < 0:
        raise PipelineError("Timeline offset cannot be negative.")

    _check_cancel(cancel_event)
    progress("converting", 8, "Validating rendered audio…")
    duration = probe_duration(input_path, runtime, cancel_event, attach_process)
    progress("converting", 15, f"Audio duration: {duration / 60:.1f} minutes")

    wav_path = work_dir / "audio_16k.wav"
    progress("converting", 20, "Converting to 16 kHz mono WAV…")
    convert_to_wav(input_path, wav_path, runtime, cancel_event, attach_process)
    progress("converting", 28, "Audio conversion complete")

    transcript_base = work_dir / "transcript"
    progress(
        "transcribing",
        32,
        f"Running Whisper large-v3 ({language}) with stable word anchors "
        "(max-len=1, split-on-word, flash attention)…",
    )
    whisper_srt, speech_intervals = run_whisper(
        wav_path,
        transcript_base,
        runtime,
        language,
        vocab_prompt,
        max_words,
        cancel_event,
        attach_process,
        on_line=lambda line: progress("transcribing", 55, line),
    )

    _check_cancel(cancel_event)
    progress("cleaning", 62, "Normalizing real Whisper word timestamps…")
    raw_entries = parse_srt(whisper_srt)
    entries = normalize_timed_words(
        raw_entries,
        speech_intervals=speech_intervals if needs_gemini else None,
    )
    if not entries:
        raise PipelineError("Whisper produced no usable timed words.")
    block_count = 1 + max(int(entry["block"]) for entry in entries)
    if needs_gemini:
        progress(
            "cleaning",
            65,
            f"Kept {len(entries)} timed words across {block_count} "
            "Silero speech block(s); VAD did not clip recognized text",
        )
    progress(
        "cleaning",
        68,
        f"Prepared {len(entries)} source-word anchors; "
        f"hard silence boundary {SILENCE_BOUNDARY_MS} ms",
    )

    if needs_gemini:
        gemini_batch_count = len(_gemini_batches(entries))
        progress(
            "converting_hinglish",
            72,
            f"Converting to Hinglish with {gemini_model} in "
            f"{gemini_batch_count} silence-safe batch(es) using validated "
            "source-word IDs…",
        )
        entries = convert_to_hinglish(
            entries, gemini_api_key, gemini_model, cancel_event
        )
        progress("converting_hinglish", 88, "Hinglish conversion complete")

    _check_cancel(cancel_event)
    progress(
        "writing",
        92,
        "Balancing captions from final display-word counts and real word anchors…",
    )
    suffix = "HINGLISH" if needs_gemini else "EN"
    output_name = f"{sanitize_stem(source_filename)}_{suffix}.srt"
    output_path = work_dir / output_name
    count = write_srt(
        entries,
        output_path,
        max_words=normalize_max_words(max_words),
        offset_ms=int(timeline_offset_ms),
    )
    progress("writing", 98, f"Wrote {count} captions")
    return output_path, count, duration
