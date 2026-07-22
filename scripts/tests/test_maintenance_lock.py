from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
LOCK_SCRIPT = SCRIPTS_DIR / "maintenance-lock.sh"
BACKUP_SCRIPT = SCRIPTS_DIR / "backup.sh"
RESTORE_SCRIPT = SCRIPTS_DIR / "restore.sh"


class MaintenanceLockTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary_directory.name)
        self.lock_directory = self.base / "locks"
        self.fake_bin = self.base / "bin"
        self.fake_bin.mkdir()
        self.docker_log = self.base / "docker.log"
        docker = self.fake_bin / "docker"
        docker.write_text(
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$DOCKER_LOG\"\nexit 0\n",
            encoding="ascii",
        )
        docker.chmod(0o755)

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def _environment(self, project_name: str) -> dict[str, str]:
        environment = os.environ.copy()
        environment.update(
            {
                "DOCKER_LOG": str(self.docker_log),
                "PATH": f"{self.fake_bin}{os.pathsep}{environment['PATH']}",
                "PORTFOLIO_COMPOSE_PROJECT_NAME": project_name,
                "PORTFOLIO_MAINTENANCE_LOCK_DIR": str(self.lock_directory),
            }
        )
        return environment

    def _install_stat_mock(self) -> Path:
        stat = self.fake_bin / "stat"
        stat.write_text(
            """#!/bin/sh
printf '%s\\n' "$*" >> "$STAT_LOG"
case "${FAKE_STAT_MODE}:$1" in
    gnu:-c)
        printf '%s\\n' "$EXPECTED_UID"
        ;;
    gnu:-f|bsd:-c|invalid:-f)
        exit 2
        ;;
    bsd:-f)
        printf '%s\\n' "$EXPECTED_UID"
        ;;
    invalid:-c)
        printf '%s\\n' 'not-a-uid'
        ;;
    broken:*)
        printf '%s\\n' 'stat probe failed' >&2
        exit 1
        ;;
    *)
        exit 2
        ;;
esac
""",
            encoding="ascii",
        )
        stat.chmod(0o755)
        return stat

    def _start_holder(self, project_name: str) -> tuple[subprocess.Popen[str], Path]:
        marker = self.base / f"{project_name}.ready"
        release = self.base / f"{project_name}.release"
        holder_code = (
            "import pathlib, sys, time; "
            "ready = pathlib.Path(sys.argv[1]); release = pathlib.Path(sys.argv[2]); "
            "ready.touch(); "
            "exec('while not release.exists():\\n    time.sleep(0.02)')"
        )
        process = subprocess.Popen(
            (
                str(LOCK_SCRIPT),
                "--project-name",
                project_name,
                "--operation",
                "test-holder",
                "--",
                sys.executable,
                "-c",
                holder_code,
                str(marker),
                str(release),
            ),
            env=self._environment(project_name),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        deadline = time.monotonic() + 5
        while not marker.exists() and process.poll() is None and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue(marker.exists(), process.stderr.read() if process.poll() is not None else "")
        return process, release

    def _release_holder(self, process: subprocess.Popen[str], release: Path) -> None:
        release.touch()
        stdout, stderr = process.communicate(timeout=5)
        self.assertEqual(process.returncode, 0, f"{stdout}\n{stderr}")

    def test_same_project_blocks_backup_and_restore_before_side_effects(self) -> None:
        project_name = "lock-test"
        holder, release = self._start_holder(project_name)
        try:
            output_directory = self.base / "backups"
            backup = subprocess.run(
                (str(BACKUP_SCRIPT), "--output", str(output_directory)),
                env=self._environment(project_name),
                capture_output=True,
                text=True,
                check=False,
            )
            restore = subprocess.run(
                (str(RESTORE_SCRIPT), "--backup", str(self.base / "missing"), "--yes"),
                env=self._environment(project_name),
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(backup.returncode, 75, backup.stderr)
            self.assertEqual(restore.returncode, 75, restore.stderr)
            self.assertIn("another maintenance operation", backup.stderr)
            self.assertIn("another maintenance operation", restore.stderr)
            self.assertFalse(output_directory.exists())
            self.assertFalse(self.docker_log.exists())
        finally:
            self._release_holder(holder, release)

        acquired_after_release = subprocess.run(
            (
                str(LOCK_SCRIPT),
                "--project-name",
                project_name,
                "--operation",
                "post-release",
                "--",
                sys.executable,
                "-c",
                "pass",
            ),
            env=self._environment(project_name),
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(acquired_after_release.returncode, 0, acquired_after_release.stderr)

    def test_different_compose_projects_do_not_block_each_other(self) -> None:
        holder, release = self._start_holder("project-a")
        try:
            marker = self.base / "project-b.completed"
            second_project = subprocess.run(
                (
                    str(LOCK_SCRIPT),
                    "--project-name",
                    "project-b",
                    "--operation",
                    "parallel-test",
                    "--",
                    sys.executable,
                    "-c",
                    "import pathlib, sys; pathlib.Path(sys.argv[1]).touch()",
                    str(marker),
                ),
                env=self._environment("project-b"),
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(second_project.returncode, 0, second_project.stderr)
            self.assertTrue(marker.exists())
        finally:
            self._release_holder(holder, release)

    def test_owner_check_uses_gnu_stat_when_available(self) -> None:
        self._install_stat_mock()
        environment = self._environment("gnu-stat-test")
        environment.update(
            {
                "FAKE_STAT_MODE": "gnu",
                "EXPECTED_UID": str(os.getuid()),
                "STAT_LOG": str(self.base / "stat.log"),
            }
        )
        result = subprocess.run(
            (
                str(LOCK_SCRIPT),
                "--project-name",
                "gnu-stat-test",
                "--operation",
                "stat-format",
                "--",
                sys.executable,
                "-c",
                "pass",
            ),
            env=environment,
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        calls = (self.base / "stat.log").read_text(encoding="ascii").splitlines()
        self.assertEqual(len(calls), 1)
        self.assertTrue(calls[0].startswith("-c %u "))

    def test_owner_check_falls_back_to_bsd_stat_and_rejects_invalid_gnu_output(self) -> None:
        self._install_stat_mock()
        environment = self._environment("bsd-stat-test")
        environment.update(
            {
                "FAKE_STAT_MODE": "bsd",
                "EXPECTED_UID": str(os.getuid()),
                "STAT_LOG": str(self.base / "bsd-stat.log"),
            }
        )
        bsd_result = subprocess.run(
            (
                str(LOCK_SCRIPT),
                "--project-name",
                "bsd-stat-test",
                "--operation",
                "stat-format",
                "--",
                sys.executable,
                "-c",
                "pass",
            ),
            env=environment,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(bsd_result.returncode, 0, bsd_result.stderr)
        bsd_calls = (self.base / "bsd-stat.log").read_text(encoding="ascii").splitlines()
        self.assertEqual(len(bsd_calls), 2)
        self.assertTrue(bsd_calls[0].startswith("-c %u "))
        self.assertTrue(bsd_calls[1].startswith("-f %u "))

        invalid_environment = self._environment("invalid-stat-test")
        invalid_environment.update(
            {
                "FAKE_STAT_MODE": "invalid",
                "EXPECTED_UID": str(os.getuid()),
                "STAT_LOG": str(self.base / "invalid-stat.log"),
            }
        )
        invalid_result = subprocess.run(
            (
                str(LOCK_SCRIPT),
                "--project-name",
                "invalid-stat-test",
                "--operation",
                "stat-format",
                "--",
                sys.executable,
                "-c",
                "pass",
            ),
            env=invalid_environment,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(invalid_result.returncode, 73, invalid_result.stderr)
        self.assertIn("ownership could not be checked", invalid_result.stderr)


if __name__ == "__main__":
    unittest.main()
