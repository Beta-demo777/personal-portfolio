from __future__ import annotations

import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
ENTRYPOINT = ROOT / "backend" / "docker-entrypoint.sh"


class BackendEntrypointTests(unittest.TestCase):
    def run_entrypoint(
        self,
        *arguments: str,
        migration_setting: str | None = None,
    ) -> tuple[subprocess.CompletedProcess[str], str]:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            calls = root / "calls.txt"
            for executable in ("python", "uvicorn"):
                path = root / executable
                path.write_text(
                    "#!/bin/sh\n"
                    f"printf '{executable}:%s\\n' \"$*\" >> \"$ENTRYPOINT_CALLS\"\n",
                    encoding="utf-8",
                )
                path.chmod(path.stat().st_mode | stat.S_IXUSR)

            environment = os.environ.copy()
            environment.update(
                {
                    "ENTRYPOINT_CALLS": str(calls),
                    "PATH": f"{root}:{environment.get('PATH', '')}",
                }
            )
            environment.pop("RUN_DB_MIGRATIONS", None)
            if migration_setting is not None:
                environment["RUN_DB_MIGRATIONS"] = migration_setting
            result = subprocess.run(
                ["sh", str(ENTRYPOINT), *arguments],
                env=environment,
                check=False,
                capture_output=True,
                text=True,
            )
            recorded_calls = calls.read_text(encoding="utf-8") if calls.exists() else ""
            return result, recorded_calls

    def test_database_init_runs_migration_and_runtime_role_reconciliation(self) -> None:
        result, calls = self.run_entrypoint("database-init")

        self.assertEqual(result.returncode, 0)
        self.assertEqual(
            calls.splitlines(),
            [
                "python:-m alembic -c /app/alembic.ini upgrade head",
                "python:-m app.db.runtime_role",
            ],
        )

    def test_runtime_server_never_runs_migrations(self) -> None:
        result, calls = self.run_entrypoint("uvicorn", "app.main:app")

        self.assertEqual(result.returncode, 0)
        self.assertEqual(calls.splitlines(), ["uvicorn:app.main:app"])

    def test_legacy_runtime_migration_switch_is_rejected(self) -> None:
        result, calls = self.run_entrypoint(
            "uvicorn",
            "app.main:app",
            migration_setting="true",
        )

        self.assertEqual(result.returncode, 64)
        self.assertEqual(calls, "")
        self.assertEqual(
            result.stderr.strip(),
            "portfolio-entrypoint: RUN_DB_MIGRATIONS is no longer supported; run the database-init service",
        )


if __name__ == "__main__":
    unittest.main()
