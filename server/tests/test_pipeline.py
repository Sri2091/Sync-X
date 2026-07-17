from __future__ import annotations

import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from pipeline import (
    PipelineError,
    RuntimePaths,
    constrain_entries_to_speech,
    convert_to_hinglish,
    merge_broken_words,
    normalize_language,
    normalize_max_words,
    parse_srt,
    parse_vad_speech_intervals,
    run_whisper,
    sanitize_stem,
    sanitize_label,
    split_entries,
    write_srt,
)


class PipelineTests(unittest.TestCase):
    def test_normalizers(self):
        self.assertEqual(normalize_language("Hindi"), "hi")
        self.assertEqual(normalize_language("EN"), "en")
        self.assertEqual(normalize_max_words(1), 2)
        self.assertEqual(normalize_max_words(99), 20)
        self.assertEqual(normalize_max_words("bad"), 6)
        # Path components are discarded before sanitizing, preventing traversal.
        self.assertEqual(sanitize_stem("../A: bad/name.mp3"), "name")
        self.assertEqual(sanitize_label("Sequence.v1", "Sequence"), "Sequence.v1")

    def test_parse_and_merge(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "source.srt"
            source.write_text(
                "1\n00:00:00,000 --> 00:00:01,000\nHel-\n\n"
                "2\n00:00:01,000 --> 00:00:02,000\nlo world\n",
                encoding="utf-8",
            )
            entries = merge_broken_words(parse_srt(source))
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["text"], "Hello world")
        self.assertEqual(entries[0]["end"], "00:00:02,000")

    def test_hyphenated_cleanup_does_not_bridge_silence(self):
        entries = merge_broken_words(
            [
                {
                    "start": "00:00:00,000",
                    "end": "00:00:01,000",
                    "text": "Hel-",
                },
                {
                    "start": "00:00:03,000",
                    "end": "00:00:04,000",
                    "text": "lo",
                },
            ]
        )
        self.assertEqual(len(entries), 2)
        self.assertEqual(entries[0]["end"], "00:00:01,000")
        self.assertEqual(entries[1]["start"], "00:00:03,000")

    def test_vad_log_parsing_and_crossing_cue_remap(self):
        log_text = (
            "VAD segment 0: start = 0.27, end = 5.17 (duration: 4.90)\n"
            "VAD segment 1: start = 7.47, end = 20.50 (duration: 13.03)\n"
        )
        intervals = parse_vad_speech_intervals(log_text)
        self.assertEqual(intervals, [(270, 5170), (7470, 20500)])
        remapped = constrain_entries_to_speech(
            [
                {
                    "start": "00:00:04,560",
                    "end": "00:00:04,950",
                    "text": "terminal",
                },
                {
                    "start": "00:00:04,950",
                    "end": "00:00:09,220",
                    "text": "Scalper ho to Scalper Mode ke saath",
                },
            ],
            intervals,
        )
        self.assertEqual(remapped[0]["end"], "00:00:04,950")
        self.assertEqual(remapped[1]["start"], "00:00:07,470")
        self.assertEqual(remapped[1]["end"], "00:00:09,220")

    def test_balanced_crossing_cue_splits_across_speech_regions(self):
        remapped = constrain_entries_to_speech(
            [
                {
                    "start": "00:00:04,000",
                    "end": "00:00:08,000",
                    "text": "one two three four",
                }
            ],
            [(4000, 5000), (7000, 8000)],
        )
        self.assertEqual([entry["text"] for entry in remapped], ["one two", "three four"])
        self.assertEqual(remapped[0]["end"], "00:00:05,000")
        self.assertEqual(remapped[1]["start"], "00:00:07,000")

    def test_word_splitting_and_offset(self):
        entries = [
            {
                "start": "00:00:00,000",
                "end": "00:00:04,000",
                "text": "one two three four",
            }
        ]
        split = split_entries(entries, max_words=2, offset_ms=10_000)
        self.assertEqual([item["text"] for item in split], ["one two", "three four"])
        self.assertEqual(split[0]["start"], "00:00:10,000")
        self.assertEqual(split[1]["start"], "00:00:12,000")
        self.assertEqual(split[1]["end"], "00:00:14,000")

    def test_convert_then_split_preserves_silence_and_offset(self):
        source = [
            {
                "start": "00:00:00,000",
                "end": "00:00:05,000",
                "text": "पहली पंक्ति",
            },
            {
                "start": "00:00:07,000",
                "end": "00:00:11,000",
                "text": "दूसरी पंक्ति",
            },
        ]
        response = SimpleNamespace(
            text="1|doosri line ab yahan hai\n0|pehli line thodi lambi hai"
        )
        with patch("google.genai.Client") as client:
            client.return_value.models.generate_content.return_value = response
            converted = convert_to_hinglish(
                source,
                "test-key",
                "gemini-3-flash-preview",
                threading.Event(),
            )

        self.assertEqual(
            [(entry["start"], entry["end"]) for entry in converted],
            [
                ("00:00:00,000", "00:00:05,000"),
                ("00:00:07,000", "00:00:11,000"),
            ],
        )
        self.assertEqual(source[0]["text"], "पहली पंक्ति")
        split = split_entries(converted, max_words=2, offset_ms=10_000)
        before_gap = [entry for entry in split if entry["end"] <= "00:00:15,000"]
        after_gap = [entry for entry in split if entry["start"] >= "00:00:17,000"]
        self.assertTrue(before_gap)
        self.assertTrue(after_gap)
        self.assertEqual(before_gap[-1]["end"], "00:00:15,000")
        self.assertEqual(after_gap[0]["start"], "00:00:17,000")
        self.assertTrue(all(len(entry["text"].split()) <= 2 for entry in split))

    def test_gemini_numbered_lines_fail_closed(self):
        source = [
            {"start": "00:00:00,000", "end": "00:00:01,000", "text": "एक"},
            {"start": "00:00:02,000", "end": "00:00:03,000", "text": "दो"},
        ]
        bad_responses = [
            "0|ek",
            "0|ek\n0|phir ek\n1|do",
            "0|ek\n1|",
            "0|ek\n1|do\n2|teen",
        ]
        for output in bad_responses:
            with self.subTest(output=output), patch("google.genai.Client") as client:
                client.return_value.models.generate_content.return_value = SimpleNamespace(
                    text=output
                )
                with self.assertRaises(PipelineError):
                    convert_to_hinglish(
                        source,
                        "test-key",
                        "gemini-3-flash-preview",
                        threading.Event(),
                    )

    def test_hindi_whisper_uses_vad_without_changing_english_command(self):
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
                run_whisper(
                    root / "audio.wav",
                    root / "english",
                    runtime,
                    "en",
                    "",
                    6,
                    threading.Event(),
                    lambda _process: None,
                    lambda _line: None,
                )

        self.assertIn("--vad", commands[0])
        self.assertEqual(
            commands[0][commands[0].index("--vad-model") + 1],
            str(runtime.whisper_vad_model),
        )
        self.assertEqual(
            commands[0][commands[0].index("--vad-min-silence-duration-ms") + 1],
            "250",
        )
        self.assertEqual(
            commands[0][commands[0].index("--vad-speech-pad-ms") + 1],
            "50",
        )
        self.assertNotIn("--vad", commands[1])

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

    def test_write_srt(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "output.srt"
            count = write_srt(
                [{"start": "00:00:00,000", "end": "00:00:01,000", "text": "hello world"}],
                output,
                max_words=6,
                offset_ms=5_000,
            )
            content = output.read_text(encoding="utf-8")
        self.assertEqual(count, 1)
        self.assertIn("00:00:05,000 --> 00:00:06,000", content)


if __name__ == "__main__":
    unittest.main()
