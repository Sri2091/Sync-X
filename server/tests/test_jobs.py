from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from jobs import JobManager
from pipeline import PipelineError, RuntimePaths


class JobManagerTests(unittest.TestCase):
    def test_only_one_active_job(self):
        with tempfile.TemporaryDirectory() as temp:
            missing = Path(temp) / "missing"
            manager = JobManager(
                Path(temp) / "jobs",
                RuntimePaths(missing, missing, missing, missing, missing),
            )
            first = manager.reserve("input.mp3", {"language": "English"})
            with self.assertRaises(PipelineError):
                manager.reserve("input.mp3", {"language": "English"})
            first.state = "failed"
            second = manager.reserve("input.mp3", {"language": "English"})
            self.assertNotEqual(first.job_id, second.job_id)


if __name__ == "__main__":
    unittest.main()
