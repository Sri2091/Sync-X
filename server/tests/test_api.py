from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import app as server_app
from jobs import JobManager


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.manager = JobManager(Path(self.temp.name) / "jobs", server_app.RUNTIME)
        self.manager_patch = patch.object(server_app, "MANAGER", self.manager)
        self.manager_patch.start()
        self.client = TestClient(server_app.app)

    def tearDown(self):
        self.client.close()
        self.manager_patch.stop()
        self.temp.cleanup()

    def test_health_and_options(self):
        health = self.client.get("/api/v1/health")
        self.assertEqual(health.status_code, 200)
        self.assertEqual(health.json()["version"], "1.0.1-prototype")
        self.assertIn("whisper_vad_model", health.json()["dependencies"])
        options = self.client.get("/api/v1/options")
        self.assertEqual(options.status_code, 200)
        self.assertEqual(options.json()["max_duration_seconds"], 1800)

    def test_hindi_requires_key(self):
        response = self.client.post(
            "/api/v1/jobs",
            data={"language": "Hindi"},
            files={"audio": ("test.mp3", b"abc", "audio/mpeg")},
        )
        self.assertEqual(response.status_code, 422)
        self.assertIn("Gemini API key", response.json()["detail"])

    def test_rejects_unsupported_extension(self):
        response = self.client.post(
            "/api/v1/jobs",
            data={"language": "English"},
            files={"audio": ("test.exe", b"abc", "application/octet-stream")},
        )
        self.assertEqual(response.status_code, 415)

    def test_accepts_english_job_contract(self):
        with patch.object(self.manager, "start") as start:
            response = self.client.post(
                "/api/v1/jobs",
                data={
                    "language": "English",
                    "project_name": "Demo",
                    "sequence_name": "Sequence 01",
                    "track_name": "A2 Voice",
                    "timeline_offset_ms": "5000",
                },
                files={"audio": ("test.mp3", b"ID3data", "audio/mpeg")},
            )
        self.assertEqual(response.status_code, 202)
        job = self.manager.get(response.json()["job_id"])
        self.assertIsNotNone(job)
        self.assertEqual(job.metadata["timeline_offset_ms"], 5000)
        start.assert_called_once()

    def test_accepts_uxp_blob_filename_with_source_extension(self):
        with patch.object(self.manager, "start") as start:
            response = self.client.post(
                "/api/v1/jobs",
                data={
                    "language": "English",
                    "source_filename": "Premiere_Audio_1.mp3",
                },
                files={"audio": ("blob", b"ID3data", "audio/mpeg")},
            )
        self.assertEqual(response.status_code, 202)
        job = self.manager.get(response.json()["job_id"])
        self.assertIsNotNone(job)
        self.assertEqual(job.input_path.suffix, ".mp3")
        start.assert_called_once()


if __name__ == "__main__":
    unittest.main()
