"""Audio-to-SRT processing pipeline for the Hinglish SRT localhost server."""

from __future__ import annotations

import importlib.util
import os
import re
import shutil
import signal
import subprocess
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable


APP_VERSION = "1.0.1-prototype"
MAX_DURATION_SECONDS = 30 * 60
MAX_UPLOAD_BYTES = 64 * 1024 * 1024
VAD_MIN_SILENCE_MS = 250
VAD_SPEECH_PAD_MS = 50

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
    entries: Iterable[dict[str, str]], max_words: int, offset_ms: int = 0
) -> list[dict[str, str]]:
    max_words = normalize_max_words(max_words)
    output: list[dict[str, str]] = []
    for entry in entries:
        words = entry["text"].split()
        if not words:
            continue
        start_ms = time_to_ms(entry["start"])
        end_ms = max(start_ms + 1, time_to_ms(entry["end"]))
        chunks = [words[i : i + max_words] for i in range(0, len(words), max_words)]
        word_cursor = 0
        for chunk in chunks:
            chunk_start = start_ms + int((end_ms - start_ms) * word_cursor / len(words))
            word_cursor += len(chunk)
            chunk_end = start_ms + int((end_ms - start_ms) * word_cursor / len(words))
            output.append(
                {
                    "start": ms_to_time(chunk_start + offset_ms),
                    "end": ms_to_time(max(chunk_start + 1, chunk_end) + offset_ms),
                    "text": " ".join(chunk),
                }
            )
    return output


def write_srt(
    entries: Iterable[dict[str, str]],
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
    max_len_chars = max(35, normalize_max_words(max_words) * 7)
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
        str(max_len_chars),
        "--split-on-word",
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
        raise PipelineError("Whisper VAD did not report usable speech timing ranges.")
    return srt_path, speech_intervals


def convert_to_hinglish(
    entries: list[dict[str, str]],
    api_key: str,
    model_name: str,
    cancel_event: threading.Event,
) -> list[dict[str, str]]:
    _check_cancel(cancel_event)
    if not api_key.strip():
        raise PipelineError("Gemini API key is required for Hindi mode.")
    if model_name not in GEMINI_MODELS:
        raise PipelineError("Unsupported Gemini model.")
    try:
        from google import genai
    except ImportError as exc:
        raise PipelineError("google-genai is not installed in the server environment.") from exc

    numbered = [f"{index}|{entry['text']}" for index, entry in enumerate(entries)]
    batch_text = "\n".join(numbered)
    prompt = f"""Convert the following Hindi (Devanagari) subtitle lines to Hinglish (Hindi written in Roman/English script).

RULES:
- Write Hindi words in natural Roman script the way Indians actually type in chat — NOT academic transliteration
- Examples: नहीं → nahi, क्या → kya, है → hai, मैं → main, और → aur, इसलिए → isliye, एक → ek
- English words already in Roman script stay as-is (e.g. "feedback", "trading", "performance")
- English words written in Devanagari should be converted to English (e.g. ट्रेडिंग → trading, फीडबैक → feedback, प्रॉफिट → profit, इंप्रूवमेंट → improvement, डाउनलोड → download)

BRAND / PHRASE PRESERVATION (CRITICAL — must be exact, never transliterated phonetically):
The following are official product/brand names. They must appear EXACTLY as written below — same spelling, same capitalization, same spacing. Never split, merge, or phoneticize them.

- CapMint
- CapMint Insights
- Scalper Mode
- CapMint Scalper Mode
- Reverse Mode
- CapMint Reverse Mode
- Trade Via Charts
- CapMint Trade Via Charts

Examples of WRONG → RIGHT corrections you must make if the transcript contains misheard or malformed variants:
- "Cap Mint" / "capmint" / "Kapmint" / "Cap Mind" → CapMint
- "scalper mode" / "Scaler Mode" / "Skalper Mode" → Scalper Mode
- "reverse mode" / "Riverse Mode" → Reverse Mode
- "trade via charts" / "Trade via Charts" / "Trade Via Chart" → Trade Via Charts
- "CapMint scalper mode" → CapMint Scalper Mode (capitalize every brand word)
- When a CapMint product name appears, keep it as a single brand phrase.

FORMAT:
- Keep the numbering format exactly: NUMBER|text
- Do NOT add any extra text, explanation, or formatting
- Do NOT skip any line
- Each line must start with its original number

TIMING / ALIGNMENT (CRITICAL):
- Each NUMBER represents one fixed subtitle time range
- Convert every numbered line independently
- Do NOT move, borrow, merge, split, reorder, add, or remove words across line numbers
- Do NOT paraphrase, summarize, or rewrite the sentence
- Preserve the original word order and meaning; only change the script and apply the listed brand corrections

INPUT:
{batch_text}

OUTPUT (same format, just converted to Hinglish):"""

    client = genai.Client(api_key=api_key.strip())
    response = client.models.generate_content(model=model_name, contents=prompt)
    _check_cancel(cancel_event)
    output_text = (getattr(response, "text", None) or "").strip()
    if not output_text:
        raise PipelineError("Gemini returned an empty response.")

    converted: dict[int, str] = {}
    expected_ids = set(range(len(entries)))
    for line in output_text.splitlines():
        if "|" not in line:
            continue
        key, text = line.strip().split("|", 1)
        try:
            index = int(key.strip())
        except ValueError:
            continue
        converted_text = text.strip()
        if index not in expected_ids:
            raise PipelineError("Gemini returned an out-of-range subtitle line ID.")
        if index in converted:
            raise PipelineError("Gemini returned a duplicate subtitle line ID.")
        if not converted_text:
            raise PipelineError("Gemini returned an empty subtitle line.")
        converted[index] = converted_text
    if set(converted) != expected_ids:
        missing_count = len(expected_ids.difference(converted))
        raise PipelineError(
            f"Gemini omitted {missing_count} numbered subtitle line(s); no partial result was written."
        )

    result = [entry.copy() for entry in entries]
    for index, entry in enumerate(result):
        entry["text"] = converted[index]
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
    progress("transcribing", 32, f"Running Whisper large-v3 ({language})…")
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
    progress("cleaning", 62, "Parsing and cleaning transcription…")
    entries = parse_srt(whisper_srt)
    if needs_gemini:
        entries = constrain_entries_to_speech(entries, speech_intervals)
        progress(
            "cleaning",
            65,
            f"Locked captions to {len(speech_intervals)} detected speech region(s)",
        )
    entries = merge_broken_words(entries)
    if not entries:
        raise PipelineError("Whisper produced no usable subtitle entries.")
    progress("cleaning", 68, f"Cleaned {len(entries)} transcript segments")

    if needs_gemini:
        progress("converting_hinglish", 72, f"Converting to Hinglish with {gemini_model}…")
        entries = convert_to_hinglish(
            entries, gemini_api_key, gemini_model, cancel_event
        )
        progress("converting_hinglish", 88, "Hinglish conversion complete")

    _check_cancel(cancel_event)
    progress("writing", 92, "Writing final SRT…")
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
