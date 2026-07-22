from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT_DIR = Path(__file__).resolve().parents[2]
COMPOSE_FILE = ROOT_DIR / "docker-compose.yml"
SECRET_ENV_NAMES = (
    "PORTFOLIO_POSTGRES_PASSWORD_SECRET_FILE",
    "PORTFOLIO_POSTGRES_APP_PASSWORD_SECRET_FILE",
    "PORTFOLIO_ADMIN_PASSWORD_HASH_SECRET_FILE",
    "PORTFOLIO_APP_SECRET_KEY_SECRET_FILE",
    "PORTFOLIO_GEMINI_API_KEY_SECRET_FILE",
)


class ComposeConfigurationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        docker = shutil.which("docker")
        if docker is None:
            cls.docker = None
            return
        result = subprocess.run(
            [docker, "compose", "version", "--short"],
            capture_output=True,
            text=True,
            check=False,
        )
        cls.docker = docker if result.returncode == 0 else None

    def setUp(self) -> None:
        if self.docker is None:
            self.skipTest("Docker Compose CLI is unavailable")
        self.temp = tempfile.TemporaryDirectory(prefix="portfolio-compose-config-")
        self.directory = Path(self.temp.name)
        self.secret_directory = self.directory / "secrets"
        self.secret_directory.mkdir()
        os.chmod(self.secret_directory, 0o700)
        self.secret_paths: dict[str, Path] = {}
        for name in SECRET_ENV_NAMES:
            path = self.secret_directory / name.removeprefix("PORTFOLIO_").lower()
            path.write_text("fixture", encoding="utf-8")
            os.chmod(path, 0o600)
            self.secret_paths[name] = path

    def tearDown(self) -> None:
        if hasattr(self, "temp"):
            self.temp.cleanup()

    def _run_config(
        self,
        *,
        postgres_user: str | None = "portfolio",
        postgres_db: str | None = "portfolio_cms",
    ) -> subprocess.CompletedProcess[str]:
        values = {
            **{name: str(path) for name, path in self.secret_paths.items()},
            "POSTGRES_USER": postgres_user,
            "POSTGRES_DB": postgres_db,
        }
        env_file = self.directory / "compose.env"
        env_file.write_text(
            "\n".join(
                f"{name}={value}"
                for name, value in values.items()
                if value is not None
            )
            + "\n",
            encoding="utf-8",
        )
        process_environment = os.environ.copy()
        for name in (*SECRET_ENV_NAMES, "POSTGRES_USER", "POSTGRES_DB"):
            process_environment.pop(name, None)
        process_environment["COMPOSE_PROJECT_NAME"] = "portfolio-config-test"
        return subprocess.run(
            [
                self.docker,
                "compose",
                "--project-directory",
                str(ROOT_DIR),
                "--file",
                str(COMPOSE_FILE),
                "--env-file",
                str(env_file),
                "config",
                "--quiet",
            ],
            capture_output=True,
            text=True,
            check=False,
            env=process_environment,
        )

    def test_postgres_user_and_database_must_be_present_and_nonempty(self) -> None:
        valid = self._run_config()
        self.assertEqual(valid.returncode, 0, valid.stderr)

        cases = (
            ("POSTGRES_USER", {"postgres_user": None}),
            ("POSTGRES_USER", {"postgres_user": ""}),
            ("POSTGRES_DB", {"postgres_db": None}),
            ("POSTGRES_DB", {"postgres_db": ""}),
        )
        for name, arguments in cases:
            with self.subTest(name=name, arguments=arguments):
                invalid = self._run_config(**arguments)
                self.assertNotEqual(invalid.returncode, 0)
                self.assertIn(name, invalid.stderr)


if __name__ == "__main__":
    unittest.main()
