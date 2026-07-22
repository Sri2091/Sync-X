"""Word-anchored subtitle timing and balanced caption construction.

Whisper is deliberately asked for one word per SRT cue.  This module keeps
those real anchors intact, adds hard speech-block boundaries, and performs the
display-word grouping only after recognition (and, for Hindi, conversion).
"""

from __future__ import annotations

import math
import re
from collections.abc import Iterable


SILENCE_BOUNDARY_MS = 250
MAX_HYPHEN_JOIN_GAP_MS = 80

_SPECIAL_ENTRY = re.compile(
    r"^(?:"
    r"<\|[^>]+\|>|"
    r"[\[(]\s*(?:blank[_ ]audio|silence|music|noise|applause|laughter)\s*[\])]"
    r")$",
    re.IGNORECASE,
)
_PUNCTUATION_ONLY = re.compile(r"^[^\w\u0900-\u097F]+$", re.UNICODE)
_OPENING_PUNCTUATION = frozenset("([{<«‹“‘「『【〔（［｛")


class TimingError(ValueError):
    """Raised when source timestamps cannot form valid word-anchored cues."""


def _clean_text(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _display_word_count(text: str) -> int:
    return max(1, len(_clean_text(text).split()))


def _is_punctuation(text: str) -> bool:
    return bool(text and _PUNCTUATION_ONLY.fullmatch(text))


def _is_opening_punctuation(text: str) -> bool:
    return bool(text and _is_punctuation(text) and all(char in _OPENING_PUNCTUATION for char in text))


def _join_text(left: str, right: str) -> str:
    left = _clean_text(left)
    right = _clean_text(right)
    if not left:
        return right
    if not right:
        return left
    if _is_punctuation(right):
        return left + right
    if _is_opening_punctuation(left):
        return left + right
    if left.endswith(("-", "‐", "‑")):
        return left[:-1] + right
    return f"{left} {right}"


def _nearest_vad_index(
    start_ms: int, end_ms: int, speech_intervals: list[tuple[int, int]]
) -> int:
    """Assign a word to a VAD region without moving or discarding the word."""
    best_index = 0
    best_score: tuple[int, int] | None = None
    midpoint = (start_ms + max(start_ms, end_ms)) // 2
    for index, (speech_start, speech_end) in enumerate(speech_intervals):
        overlap = max(0, min(end_ms, speech_end) - max(start_ms, speech_start))
        if overlap:
            score = (0, -overlap)
        elif midpoint < speech_start:
            score = (speech_start - midpoint, 0)
        elif midpoint > speech_end:
            score = (midpoint - speech_end, 0)
        else:
            score = (0, 0)
        if best_score is None or score < best_score:
            best_index = index
            best_score = score
    return best_index


def _assign_blocks(
    records: list[dict[str, object]],
    speech_intervals: list[tuple[int, int]] | None,
    silence_ms: int,
) -> None:
    if not records:
        return
    intervals = sorted(
        (max(0, int(start)), max(0, int(end)))
        for start, end in (speech_intervals or [])
        if int(end) > int(start)
    )
    block = 0
    previous = records[0]
    previous_interval = (
        _nearest_vad_index(
            int(previous["start_ms"]), int(previous["end_ms"]), intervals
        )
        if intervals
        else None
    )
    previous["block"] = block
    for record in records[1:]:
        current_interval = (
            _nearest_vad_index(
                int(record["start_ms"]), int(record["end_ms"]), intervals
            )
            if intervals
            else None
        )
        native_silence = (
            int(record["start_ms"]) - int(previous["end_ms"]) >= silence_ms
        )
        if intervals:
            # Separate Silero regions are authoritative.  Their configured
            # 250 ms detector threshold already accounts for the 50 ms pads.
            # The native word gap remains a second safety net so a genuine
            # 250 ms silence can never be crossed if VAD merges two regions.
            boundary = current_interval != previous_interval or native_silence
        else:
            boundary = native_silence
        if boundary:
            block += 1
        record["block"] = block
        previous = record
        previous_interval = current_interval


def _merge_punctuation_and_hyphens(
    records: list[dict[str, object]],
) -> list[dict[str, object]]:
    output: list[dict[str, object]] = []
    pending_prefix: dict[str, object] | None = None
    for record in records:
        text = str(record["text"])
        if _is_punctuation(text):
            if _is_opening_punctuation(text):
                if pending_prefix and pending_prefix["block"] == record["block"]:
                    pending_prefix["text"] = (
                        str(pending_prefix["text"]) + text
                    )
                    pending_prefix["end_ms"] = max(
                        int(pending_prefix["end_ms"]), int(record["end_ms"])
                    )
                else:
                    pending_prefix = record.copy()
                continue
            if output and output[-1]["block"] == record["block"]:
                output[-1]["text"] = _join_text(str(output[-1]["text"]), text)
                output[-1]["end_ms"] = max(
                    int(output[-1]["end_ms"]), int(record["end_ms"])
                )
            else:
                pending_prefix = record.copy()
            continue

        current = record.copy()
        if pending_prefix and pending_prefix["block"] == current["block"]:
            current["text"] = _join_text(
                str(pending_prefix["text"]), str(current["text"])
            )
            current["start_ms"] = min(
                int(pending_prefix["start_ms"]), int(current["start_ms"])
            )
            pending_prefix = None
        elif pending_prefix:
            pending_prefix = None

        if output and output[-1]["block"] == current["block"]:
            previous = output[-1]
            gap_ms = int(current["start_ms"]) - int(previous["end_ms"])
            if (
                str(previous["text"]).endswith(("-", "‐", "‑"))
                and 0 <= gap_ms <= MAX_HYPHEN_JOIN_GAP_MS
            ):
                previous["text"] = _join_text(
                    str(previous["text"]), str(current["text"])
                )
                previous["end_ms"] = max(
                    int(previous["end_ms"]), int(current["end_ms"])
                )
                continue
        output.append(current)
    if (
        pending_prefix
        and output
        and output[-1]["block"] == pending_prefix["block"]
    ):
        output[-1]["text"] = _join_text(
            str(output[-1]["text"]), str(pending_prefix["text"])
        )
        output[-1]["end_ms"] = max(
            int(output[-1]["end_ms"]), int(pending_prefix["end_ms"])
        )
    return output


def _repair_zero_duration(records: list[dict[str, object]]) -> list[dict[str, object]]:
    """Merge invalid anchors with a neighbour in the same speech block."""
    output = [record.copy() for record in records]
    index = 0
    while index < len(output):
        record = output[index]
        if int(record["end_ms"]) > int(record["start_ms"]):
            index += 1
            continue
        if index > 0 and output[index - 1]["block"] == record["block"]:
            previous = output[index - 1]
            previous["text"] = _join_text(
                str(previous["text"]), str(record["text"])
            )
            previous["end_ms"] = max(
                int(previous["end_ms"]),
                int(record["start_ms"]),
                int(record["end_ms"]),
            )
            output.pop(index)
            continue
        if index + 1 < len(output) and output[index + 1]["block"] == record["block"]:
            following = output[index + 1]
            following["text"] = _join_text(
                str(record["text"]), str(following["text"])
            )
            following["start_ms"] = min(
                int(record["start_ms"]), int(following["start_ms"])
            )
            output.pop(index)
            continue
        raise TimingError(
            "Whisper returned an isolated word without a usable timestamp."
        )
    return output


def _remove_word_overlaps(
    records: list[dict[str, object]],
) -> list[dict[str, object]]:
    """Make neighbouring anchors monotonic without manufacturing tiny cues."""
    output: list[dict[str, object]] = []
    for original in records:
        record = original.copy()
        if not output or output[-1]["block"] != record["block"]:
            output.append(record)
            continue
        previous = output[-1]
        if int(record["start_ms"]) >= int(previous["end_ms"]):
            output.append(record)
            continue

        # Prefer preserving the next word's real start anchor by shortening the
        # previous word.  If that would erase the previous word, combine both.
        if int(record["start_ms"]) > int(previous["start_ms"]):
            previous["end_ms"] = int(record["start_ms"])
            output.append(record)
        elif int(record["end_ms"]) > int(previous["end_ms"]):
            record["start_ms"] = int(previous["end_ms"])
            output.append(record)
        else:
            previous["text"] = _join_text(
                str(previous["text"]), str(record["text"])
            )
            previous["end_ms"] = max(
                int(previous["end_ms"]), int(record["end_ms"])
            )
    return output


def normalize_timed_words(
    entries: Iterable[dict[str, object]],
    *,
    speech_intervals: list[tuple[int, int]] | None = None,
    silence_ms: int = SILENCE_BOUNDARY_MS,
    time_to_ms,
) -> list[dict[str, object]]:
    """Normalize word-level Whisper SRT cues into stable timed source words.

    ``speech_intervals`` is supplied only for Hindi.  It decides where speech
    blocks break, but never clips, moves, or drops recognized text.
    """
    records: list[dict[str, object]] = []
    for position, entry in enumerate(entries):
        text = _clean_text(entry.get("text"))
        if not text or _SPECIAL_ENTRY.fullmatch(text):
            continue
        if "start_ms" in entry:
            start_ms = max(0, int(entry["start_ms"]))
            end_ms = max(0, int(entry["end_ms"]))
        else:
            start_ms = max(0, int(time_to_ms(str(entry["start"]))))
            end_ms = max(0, int(time_to_ms(str(entry["end"]))))
        records.append(
            {
                "text": text,
                "start_ms": start_ms,
                "end_ms": end_ms,
                "_position": position,
            }
        )
    if not records:
        return []

    # Preserve Whisper's source order.  Timestamps are repaired below rather
    # than reordering words that the recognizer emitted in sentence order.
    _assign_blocks(records, speech_intervals, max(1, int(silence_ms)))
    records = _merge_punctuation_and_hyphens(records)
    records = _repair_zero_duration(records)
    records = _remove_word_overlaps(records)
    records = _repair_zero_duration(records)

    normalized: list[dict[str, object]] = []
    block_map: dict[int, int] = {}
    for record in records:
        original_block = int(record["block"])
        block = block_map.setdefault(original_block, len(block_map))
        normalized.append(
            {
                "id": f"w{len(normalized):06d}",
                "source_ids": [f"w{len(normalized):06d}"],
                "text": _clean_text(record["text"]),
                "start_ms": int(record["start_ms"]),
                "end_ms": int(record["end_ms"]),
                "block": block,
            }
        )
    return normalized


def _minimum_groups(weights: list[int], maximum: int) -> list[int]:
    """Return the fewest possible groups for every suffix."""
    count = len(weights)
    minimum = [0] * (count + 1)
    for index in range(count - 1, -1, -1):
        if weights[index] > maximum:
            next_index = index + 1
        else:
            total = 0
            next_index = index
            while next_index < count and total + weights[next_index] <= maximum:
                total += weights[next_index]
                next_index += 1
        minimum[index] = 1 + minimum[next_index]
    return minimum


def _balanced_block(
    units: list[dict[str, object]], maximum: int
) -> list[list[dict[str, object]]]:
    if not units:
        return []
    weights = [_display_word_count(str(unit["text"])) for unit in units]
    total_words = sum(weights)
    if maximum == 2 and total_words == 3 and all(weight <= 2 for weight in weights):
        return [units]

    minimum = _minimum_groups(weights, maximum)
    groups_left = minimum[0]
    result: list[list[dict[str, object]]] = []
    index = 0
    remaining_weight = total_words
    while index < len(units):
        if groups_left == 1:
            result.append(units[index:])
            break
        target = math.ceil(remaining_weight / groups_left)
        candidates: list[tuple[int, int]] = []
        if weights[index] > maximum:
            candidates.append((index + 1, weights[index]))
        else:
            running = 0
            cursor = index
            while cursor < len(units) and running + weights[cursor] <= maximum:
                running += weights[cursor]
                cursor += 1
                remaining_units = len(units) - cursor
                if (
                    minimum[cursor] <= groups_left - 1
                    and remaining_units >= groups_left - 1
                ):
                    candidates.append((cursor, running))
        if not candidates:
            raise TimingError("Timed words could not be partitioned into captions.")

        # One-word groups lose before any valid non-orphan candidate.  The
        # target is rounded upward so ties put the extra word in the earlier
        # caption: 7/6 -> 4+3 and 13/6 -> 5+4+4.
        non_orphans = [candidate for candidate in candidates if candidate[1] != 1]
        if non_orphans:
            candidates = non_orphans
        end_index, group_weight = min(
            candidates,
            key=lambda candidate: (
                abs(candidate[1] - target),
                -candidate[1],
                -candidate[0],
            ),
        )
        result.append(units[index:end_index])
        index = end_index
        remaining_weight -= group_weight
        groups_left -= 1
    return result


def build_balanced_captions(
    units: Iterable[dict[str, object]],
    *,
    max_words: int,
    offset_ms: int = 0,
) -> list[dict[str, object]]:
    """Build captions without crossing speech blocks or interpolating time."""
    maximum = min(20, max(2, int(max_words)))
    ordered = [dict(unit) for unit in units if _clean_text(unit.get("text"))]
    if not ordered:
        return []

    blocks: list[list[dict[str, object]]] = []
    for unit in ordered:
        if not blocks or blocks[-1][-1].get("block") != unit.get("block"):
            blocks.append([unit])
        else:
            blocks[-1].append(unit)

    captions: list[dict[str, object]] = []
    for block in blocks:
        for group in _balanced_block(block, maximum):
            start_ms = int(group[0]["start_ms"])
            end_ms = int(group[-1]["end_ms"])
            if end_ms <= start_ms:
                raise TimingError("A final caption has no usable word-anchored duration.")
            text = " ".join(_clean_text(unit["text"]) for unit in group).strip()
            captions.append(
                {
                    "start_ms": start_ms + int(offset_ms),
                    "end_ms": end_ms + int(offset_ms),
                    "text": text,
                    "block": group[0].get("block", 0),
                    "source_ids": [
                        source_id
                        for unit in group
                        for source_id in unit.get("source_ids", [])
                    ],
                }
            )

    for previous, current in zip(captions, captions[1:]):
        if int(current["start_ms"]) >= int(previous["end_ms"]):
            continue
        if int(current["start_ms"]) > int(previous["start_ms"]):
            previous["end_ms"] = int(current["start_ms"])
        elif int(current["end_ms"]) > int(previous["end_ms"]):
            current["start_ms"] = int(previous["end_ms"])
        else:
            raise TimingError("Final caption timestamps are not monotonic.")
        if int(previous["end_ms"]) <= int(previous["start_ms"]):
            raise TimingError("Overlap repair would create a zero-duration caption.")
        if int(current["end_ms"]) <= int(current["start_ms"]):
            raise TimingError("Overlap repair would create a zero-duration caption.")
    return captions


def display_word_count(text: str) -> int:
    """Public helper used by semantic validation and tests."""
    return _display_word_count(text)
