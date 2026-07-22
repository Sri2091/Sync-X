from __future__ import annotations

import json
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from pipeline import (
    PipelineError,
    RuntimePaths,
    _gemini_batches,
    convert_to_hinglish,
    normalize_language,
    normalize_max_words,
    normalize_timed_words,
    parse_srt,
    parse_vad_speech_intervals,
    run_whisper,
    sanitize_label,
    sanitize_stem,
    split_entries,
    write_srt,
)


def source_entries(
    words: list[str],
    *,
    starts: list[int] | None = None,
    durations: list[int] | None = None,
) -> list[dict[str, str]]:
    starts = starts or [index * 200 for index in range(len(words))]
    durations = durations or [120] * len(words)
    return [
        {
            "start": ms_to_srt(starts[index]),
            "end": ms_to_srt(starts[index] + durations[index]),
            "text": word,
        }
        for index, word in enumerate(words)
    ]


def ms_to_srt(value: int) -> str:
    hours, value = divmod(value, 3_600_000)
    minutes, value = divmod(value, 60_000)
    seconds, millis = divmod(value, 1_000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{millis:03d}"


class PipelineTests(unittest.TestCase):
    def test_normalizers(self):
        self.assertEqual(normalize_language("Hindi"), "hi")
        self.assertEqual(normalize_language("EN"), "en")
        self.assertEqual(normalize_max_words(1), 2)
        self.assertEqual(normalize_max_words(99), 20)
        self.assertEqual(normalize_max_words("bad"), 6)
        self.assertEqual(sanitize_stem("../A: bad/name.mp3"), "name")
        self.assertEqual(sanitize_label("Sequence.v1", "Sequence"), "Sequence.v1")

    def test_parse_and_normalize_word_cues(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "source.srt"
            source.write_text(
                "1\n00:00:00,000 --> 00:00:00,300\nHel-\n\n"
                "2\n00:00:00,320 --> 00:00:00,600\nlo\n\n"
                "3\n00:00:00,600 --> 00:00:00,640\n,\n\n"
                "4\n00:00:00,650 --> 00:00:00,650\nbroken\n\n"
                "5\n00:00:00,700 --> 00:00:01,000\nword\n\n"
                "6\n00:00:01,000 --> 00:00:01,100\n[BLANK_AUDIO]\n",
                encoding="utf-8",
            )
            words = normalize_timed_words(parse_srt(source))
        self.assertEqual([word["text"] for word in words], ["Hello, broken", "word"])
        self.assertEqual(words[0]["start_ms"], 0)
        self.assertEqual(words[0]["end_ms"], 650)
        self.assertGreater(words[0]["end_ms"], words[0]["start_ms"])
        self.assertEqual([word["id"] for word in words], ["w000000", "w000001"])

    def test_native_silence_is_a_hard_english_boundary(self):
        words = normalize_timed_words(
            source_entries(
                ["one", "two", "three", "four"],
                starts=[0, 150, 600, 750],
                durations=[100, 100, 100, 100],
            )
        )
        self.assertEqual([word["block"] for word in words], [0, 0, 1, 1])
        captions = split_entries(words, max_words=6)
        self.assertEqual(
            [caption["text"] for caption in captions],
            ["one two", "three four"],
        )
        self.assertLessEqual(captions[0]["end"], captions[1]["start"])

    def test_silence_boundary_is_exactly_250_milliseconds(self):
        below = normalize_timed_words(
            source_entries(
                ["one", "two"],
                starts=[0, 349],
                durations=[100, 100],
            )
        )
        exact = normalize_timed_words(
            source_entries(
                ["one", "two"],
                starts=[0, 350],
                durations=[100, 100],
            )
        )
        self.assertEqual([word["block"] for word in below], [0, 0])
        self.assertEqual([word["block"] for word in exact], [0, 1])

    def test_hindi_vad_sets_boundaries_but_never_drops_words(self):
        words = normalize_timed_words(
            source_entries(
                ["पहला", "misplaced", "दूसरा"],
                starts=[100, 1_200, 2_100],
                durations=[200, 100, 200],
            ),
            speech_intervals=[(0, 1_000), (2_000, 3_000)],
        )
        self.assertEqual([word["text"] for word in words], ["पहला", "misplaced", "दूसरा"])
        self.assertEqual([word["block"] for word in words], [0, 1, 2])
        self.assertEqual(words[1]["start_ms"], 1_200)
        self.assertEqual(words[1]["end_ms"], 1_300)

    def test_hindi_native_gap_remains_hard_when_vad_merges_region(self):
        words = normalize_timed_words(
            source_entries(
                ["पहला", "दूसरा"],
                starts=[100, 500],
                durations=[100, 100],
            ),
            speech_intervals=[(0, 1_000)],
        )
        self.assertEqual([word["block"] for word in words], [0, 1])

    def test_opening_and_closing_punctuation_attach_to_words(self):
        words = normalize_timed_words(
            source_entries(
                ["(", "hello", ")", "next"],
                starts=[0, 20, 120, 160],
                durations=[10, 80, 20, 80],
            )
        )
        self.assertEqual([word["text"] for word in words], ["(hello)", "next"])
        self.assertEqual(words[0]["start_ms"], 0)
        self.assertEqual(words[0]["end_ms"], 140)

    def test_balanced_caption_counts(self):
        cases = [
            (7, 6, [4, 3]),
            (13, 6, [5, 4, 4]),
            (12, 6, [6, 6]),
            (5, 6, [5]),
        ]
        for total, maximum, expected in cases:
            with self.subTest(total=total, maximum=maximum):
                words = normalize_timed_words(
                    source_entries([f"w{index}" for index in range(total)])
                )
                captions = split_entries(words, max_words=maximum)
                self.assertEqual(
                    [len(caption["text"].split()) for caption in captions],
                    expected,
                )
                if total > 1:
                    self.assertNotIn(
                        1, [len(caption["text"].split()) for caption in captions]
                    )

    def test_maximum_two_three_word_exception(self):
        words = normalize_timed_words(source_entries(["one", "two", "three"]))
        captions = split_entries(words, max_words=2)
        self.assertEqual(len(captions), 1)
        self.assertEqual(captions[0]["text"], "one two three")

    def test_irregular_word_durations_keep_real_anchors_and_offset(self):
        words = normalize_timed_words(
            source_entries(
                ["one", "two", "three", "four"],
                starts=[0, 150, 3_200, 3_240],
                durations=[100, 2_950, 20, 2_760],
            )
        )
        captions = split_entries(words, max_words=2, offset_ms=10_000)
        self.assertEqual(
            [
                (caption["start"], caption["end"], caption["text"])
                for caption in captions
            ],
            [
                ("00:00:10,000", "00:00:13,100", "one two"),
                ("00:00:13,200", "00:00:16,000", "three four"),
            ],
        )

    def test_zero_duration_word_is_merged_not_given_one_millisecond(self):
        words = normalize_timed_words(
            source_entries(
                ["valid", "zero", "next"],
                starts=[0, 150, 180],
                durations=[100, 0, 100],
            )
        )
        self.assertEqual([word["text"] for word in words], ["valid zero", "next"])
        captions = split_entries(words, max_words=6)
        self.assertEqual(captions[0]["start"], "00:00:00,000")
        self.assertEqual(captions[0]["end"], "00:00:00,280")
        self.assertNotEqual(captions[0]["end"], "00:00:00,001")

    def test_vad_log_parsing(self):
        intervals = parse_vad_speech_intervals(
            "VAD segment 0: start = 0.27, end = 5.17\n"
            "VAD segment 1: start = 7.47, end = 20.50\n"
        )
        self.assertEqual(intervals, [(270, 5_170), (7_470, 20_500)])

    def test_whisper_command_is_word_level_and_slider_independent(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            runtime = RuntimePaths(
                whisper_cli=root / "whisper-cli",
                ffmpeg=root / "ffmpeg",
                ffprobe=root / "ffprobe",
                whisper_model=root / "large-v3.bin",
                whisper_vad_model=root / "silero.bin",
            )
            commands: list[list[str]] = []

            def fake_run_process(command, *_args, **_kwargs):
                commands.append(command)
                output_index = command.index("--output-file") + 1
                Path(command[output_index]).with_suffix(".srt").write_text(
                    "1\n00:00:00,000 --> 00:00:01,000\ntext\n",
                    encoding="utf-8",
                )
                if "--vad" in command:
                    return "VAD segment 0: start = 0.10, end = 1.00"
                return ""

            with patch("pipeline.run_process", side_effect=fake_run_process):
                for maximum in (2, 20):
                    run_whisper(
                        root / "audio.wav",
                        root / f"english-{maximum}",
                        runtime,
                        "en",
                        "",
                        maximum,
                        threading.Event(),
                        lambda _process: None,
                        lambda _line: None,
                    )
                run_whisper(
                    root / "audio.wav",
                    root / "hindi",
                    runtime,
                    "hi",
                    "",
                    6,
                    threading.Event(),
                    lambda _process: None,
                    lambda _line: None,
                )

        english_2 = commands[0]
        english_20 = commands[1]
        self.assertEqual(
            english_2[english_2.index("--max-len") + 1],
            "1",
        )
        self.assertEqual(
            english_20[english_20.index("--max-len") + 1],
            "1",
        )
        normalized_commands = []
        for command in (english_2, english_20):
            normalized = command.copy()
            normalized[normalized.index("--output-file") + 1] = "<output>"
            normalized_commands.append(normalized)
        self.assertEqual(normalized_commands[0], normalized_commands[1])
        self.assertIn("--split-on-word", english_2)
        self.assertIn("--flash-attn", english_2)
        self.assertNotIn("--dtw", english_2)
        hindi = commands[2]
        self.assertIn("--vad", hindi)
        self.assertEqual(
            hindi[hindi.index("--vad-min-silence-duration-ms") + 1], "250"
        )
        self.assertEqual(hindi[hindi.index("--vad-speech-pad-ms") + 1], "50")

    def test_hindi_whisper_falls_back_when_vad_log_has_no_intervals(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            runtime = RuntimePaths(
                whisper_cli=root / "whisper-cli",
                ffmpeg=root / "ffmpeg",
                ffprobe=root / "ffprobe",
                whisper_model=root / "large-v3.bin",
                whisper_vad_model=root / "silero.bin",
            )
            logs: list[str] = []

            def fake_run_process(command, *_args, **_kwargs):
                output_index = command.index("--output-file") + 1
                Path(command[output_index]).with_suffix(".srt").write_text(
                    "1\n00:00:00,000 --> 00:00:01,000\nशब्द\n",
                    encoding="utf-8",
                )
                return "Whisper completed without a parseable VAD segment line"

            with patch("pipeline.run_process", side_effect=fake_run_process):
                _, intervals = run_whisper(
                    root / "audio.wav",
                    root / "hindi",
                    runtime,
                    "hi",
                    "",
                    6,
                    threading.Event(),
                    lambda _process: None,
                    logs.append,
                )
        self.assertEqual(intervals, [])
        self.assertTrue(any("native 250 ms word gaps" in line for line in logs))

    def test_gemini_structured_alignment_supports_mapping_shapes(self):
        words = normalize_timed_words(
            source_entries(["मैं", "कैप", "मिंट", "है"])
        )
        payload = {
            "units": [
                {"source_ids": ["w000000"], "text": "main hoon"},
                {"source_ids": ["w000001", "w000002"], "text": "CapMint"},
                {"source_ids": ["w000003"], "text": "hai"},
            ]
        }
        with patch("pipeline._create_genai_client") as client:
            client.return_value.models.generate_content.return_value = SimpleNamespace(
                text=json.dumps(payload)
            )
            converted = convert_to_hinglish(
                words,
                "test-key",
                "gemini-3-flash-preview",
                threading.Event(),
            )
        self.assertEqual(
            [unit["text"] for unit in converted], ["main hoon", "CapMint", "hai"]
        )
        self.assertEqual(converted[1]["start_ms"], words[1]["start_ms"])
        self.assertEqual(converted[1]["end_ms"], words[2]["end_ms"])
        call = client.return_value.models.generate_content.call_args
        self.assertEqual(
            call.kwargs["config"]["response_mime_type"], "application/json"
        )

    def test_gemini_invalid_mapping_retries_once_then_succeeds(self):
        words = normalize_timed_words(source_entries(["एक", "दो"]))
        bad = {"units": [{"source_ids": ["w000001"], "text": "do"}]}
        good = {
            "units": [
                {"source_ids": ["w000000"], "text": "ek"},
                {"source_ids": ["w000001"], "text": "do"},
            ]
        }
        with patch("pipeline._create_genai_client") as client:
            generator = client.return_value.models.generate_content
            generator.side_effect = [
                SimpleNamespace(text=json.dumps(bad)),
                SimpleNamespace(text=json.dumps(good)),
            ]
            converted = convert_to_hinglish(
                words,
                "test-key",
                "gemini-3-flash-preview",
                threading.Event(),
            )
            self.assertEqual(generator.call_count, 2)
        self.assertEqual([unit["text"] for unit in converted], ["ek", "do"])

    def test_gemini_transient_request_failure_retries_once_then_succeeds(self):
        words = normalize_timed_words(source_entries(["एक", "दो"]))
        good = {
            "units": [
                {"source_ids": ["w000000"], "text": "ek"},
                {"source_ids": ["w000001"], "text": "do"},
            ]
        }
        with patch("pipeline._create_genai_client") as client:
            generator = client.return_value.models.generate_content
            generator.side_effect = [
                RuntimeError("temporary free-tier failure"),
                SimpleNamespace(text=json.dumps(good)),
            ]
            converted = convert_to_hinglish(
                words,
                "test-key",
                "gemini-3-flash-preview",
                threading.Event(),
            )
            self.assertEqual(generator.call_count, 2)
        self.assertEqual([unit["text"] for unit in converted], ["ek", "do"])

    def test_gemini_rejects_ids_twice_and_fails_closed(self):
        words = normalize_timed_words(source_entries(["एक", "दो"]))
        invalid_payloads = [
            {
                "units": [
                    {"source_ids": ["w000000"], "text": "ek"},
                    {"source_ids": ["w000000"], "text": "duplicate"},
                ]
            },
            {
                "units": [
                    {"source_ids": ["w000000", "w000001"], "text": ""}
                ]
            },
        ]
        with patch("pipeline._create_genai_client") as client:
            generator = client.return_value.models.generate_content
            generator.side_effect = [
                SimpleNamespace(text=json.dumps(payload))
                for payload in invalid_payloads
            ]
            with self.assertRaisesRegex(PipelineError, "after one retry"):
                convert_to_hinglish(
                    words,
                    "test-key",
                    "gemini-3-flash-preview",
                    threading.Event(),
                )
            self.assertEqual(generator.call_count, 2)

    def test_gemini_transport_error_is_generic_and_does_not_echo_key(self):
        words = normalize_timed_words(source_entries(["एक"]))
        secret = "very-secret-api-key"
        with patch("pipeline._create_genai_client") as client:
            client.return_value.models.generate_content.side_effect = RuntimeError(
                f"request failed with credential {secret}"
            )
            with self.assertRaises(PipelineError) as raised:
                convert_to_hinglish(
                    words,
                    secret,
                    "gemini-3-flash-preview",
                    threading.Event(),
                )
        self.assertNotIn(secret, str(raised.exception))
        self.assertIn("Gemini conversion request failed", str(raised.exception))

    def test_gemini_cannot_merge_across_silence(self):
        words = normalize_timed_words(
            source_entries(
                ["एक", "दो"], starts=[0, 500], durations=[100, 100]
            )
        )
        payload = {
            "units": [
                {
                    "source_ids": ["w000000", "w000001"],
                    "text": "ek do",
                }
            ]
        }
        with patch("pipeline._create_genai_client") as client:
            client.return_value.models.generate_content.return_value = SimpleNamespace(
                text=json.dumps(payload)
            )
            with self.assertRaisesRegex(PipelineError, "after one retry"):
                convert_to_hinglish(
                    words,
                    "test-key",
                    "gemini-3-flash-preview",
                    threading.Event(),
                )
            self.assertEqual(
                client.return_value.models.generate_content.call_count, 2
            )

    def test_gemini_batching_uses_only_silence_boundaries(self):
        words = normalize_timed_words(
            source_entries(
                ["a", "b", "c", "d"],
                starts=[0, 100, 1_000, 1_100],
                durations=[50, 50, 50, 50],
            )
        )
        batches = _gemini_batches(words, maximum_source_words=3)
        self.assertEqual([[word["text"] for word in batch] for batch in batches], [["a", "b"], ["c", "d"]])

    def test_gemini_default_batching_caps_at_fifty_on_silence_boundaries(self):
        block_sizes = [11, 7, 50, 20, 13, 9]
        words: list[dict[str, object]] = []
        word_index = 0
        for block_index, block_size in enumerate(block_sizes):
            for _ in range(block_size):
                words.append(
                    {
                        "id": f"w{word_index:06d}",
                        "text": f"word-{word_index}",
                        "start_ms": word_index * 100,
                        "end_ms": word_index * 100 + 80,
                        "block": block_index,
                    }
                )
                word_index += 1

        batches = _gemini_batches(words)

        self.assertEqual([len(batch) for batch in batches], [18, 50, 42])
        self.assertEqual(
            [word["id"] for batch in batches for word in batch],
            [word["id"] for word in words],
        )
        self.assertEqual(
            [
                sorted({int(word["block"]) for word in batch})
                for batch in batches
            ],
            [[0, 1], [2], [3, 4, 5]],
        )

    def test_write_srt_uses_word_anchors_and_offset(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "output.srt"
            words = normalize_timed_words(
                source_entries(["hello", "world"], starts=[100, 900], durations=[200, 300])
            )
            count = write_srt(
                words,
                output,
                max_words=6,
                offset_ms=5_000,
            )
            content = output.read_text(encoding="utf-8")
        self.assertEqual(count, 2)  # 600 ms native silence is a hard boundary.
        self.assertIn("00:00:05,100 --> 00:00:05,300", content)
        self.assertIn("00:00:05,900 --> 00:00:06,200", content)

    def test_slider_changes_only_grouping_not_source_word_anchors(self):
        words = normalize_timed_words(
            source_entries(
                [f"w{index}" for index in range(7)],
                starts=[0, 130, 480, 610, 740, 870, 1_000],
                durations=[90, 300, 80, 70, 60, 50, 220],
            )
        )
        anchors_before = [
            (word["id"], word["start_ms"], word["end_ms"]) for word in words
        ]
        six = split_entries(words, max_words=6)
        three = split_entries(words, max_words=3)
        anchors_after = [
            (word["id"], word["start_ms"], word["end_ms"]) for word in words
        ]
        self.assertEqual(anchors_before, anchors_after)
        self.assertEqual(
            [len(caption["text"].split()) for caption in six], [4, 3]
        )
        self.assertEqual(
            [len(caption["text"].split()) for caption in three], [3, 2, 2]
        )

    def test_vad_model_is_required_only_for_hindi_jobs(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            existing = root / "ready"
            existing.write_bytes(b"ready")
            runtime = RuntimePaths(
                whisper_cli=existing,
                ffmpeg=existing,
                ffprobe=existing,
                whisper_model=existing,
                whisper_vad_model=root / "missing-vad.bin",
            )
            self.assertNotIn("whisper_vad_model", runtime.missing(needs_gemini=False))
            self.assertIn("whisper_vad_model", runtime.missing(needs_gemini=True))


if __name__ == "__main__":
    unittest.main()
