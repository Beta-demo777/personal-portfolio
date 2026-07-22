from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from assert_no_secret_exposure import SecretExposureError, assert_no_secret_exposure


EXPECTED_ENV = {
    "postgres": ["POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password"],
    "database-init": [
        "POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password",
        "POSTGRES_RUNTIME_PASSWORD_FILE=/run/secrets/postgres_app_password",
    ],
    "backend": [
        "POSTGRES_PASSWORD_FILE=/run/secrets/postgres_app_password",
        "BLOG_ADMIN_PASSWORD_HASH_FILE=/run/secrets/blog_admin_password_hash",
        "APP_SECRET_KEY_FILE=/run/secrets/app_secret_key",
    ],
    "frontend": ["AI_API_KEY_FILE=/run/secrets/ai_api_key"],
}


class SecretExposureInspectionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary_directory.name)
        self.active_secrets = self.base / "active"
        self.retired_secrets = self.base / "retired"
        self.active_secrets.mkdir()
        self.retired_secrets.mkdir()
        self.active_value = "active-secret-value-that-must-not-leak"
        self.retired_value = "retired-secret-value-that-must-not-leak"
        (self.active_secrets / "active").write_text(self.active_value, encoding="ascii")
        (self.retired_secrets / "retired").write_text(self.retired_value, encoding="ascii")

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def _write_inspect(self, name: str, environment: list[str], **extra: object) -> Path:
        path = self.base / name
        document: dict[str, object] = {"Config": {"Env": environment}}
        document.update(extra)
        path.write_text(json.dumps([document]), encoding="utf-8")
        return path

    def _assert(self, service: str, container: Path, image: Path) -> None:
        assert_no_secret_exposure(
            service=service,
            container_inspect=container,
            image_inspect=image,
            secret_directories=[self.active_secrets, self.retired_secrets],
        )

    def _valid_documents(self, service: str) -> tuple[Path, Path]:
        container = self._write_inspect(
            f"{service}-container.json",
            [*EXPECTED_ENV[service], "PUBLIC_ORIGIN=https://example.test"],
            Path="node" if service == "frontend" else "entrypoint",
            Args=["--serve"],
        )
        image = self._write_inspect(
            f"{service}-image.json",
            ["PATH=/usr/local/bin:/usr/bin"],
            History=[{"CreatedBy": "build without credentials"}],
        )
        return container, image

    def test_accepts_expected_file_environment_for_each_service(self) -> None:
        for service in EXPECTED_ENV:
            with self.subTest(service=service):
                self._assert(service, *self._valid_documents(service))

    def test_rejects_plaintext_secret_environment_name_without_echoing_value(self) -> None:
        container, image = self._valid_documents("backend")
        payload = json.loads(container.read_text(encoding="utf-8"))
        payload[0]["Config"]["Env"].append("APP_SECRET_KEY=not-the-fixture-secret")
        container.write_text(json.dumps(payload), encoding="utf-8")

        with self.assertRaisesRegex(SecretExposureError, "forbidden variable APP_SECRET_KEY") as error:
            self._assert("backend", container, image)
        self.assertNotIn("not-the-fixture-secret", str(error.exception))

    def test_rejects_missing_or_wrong_secret_file_path(self) -> None:
        container, image = self._valid_documents("frontend")
        payload = json.loads(container.read_text(encoding="utf-8"))
        payload[0]["Config"]["Env"] = ["AI_API_KEY_FILE=/tmp/key"]
        container.write_text(json.dumps(payload), encoding="utf-8")

        with self.assertRaisesRegex(SecretExposureError, "invalid path for AI_API_KEY_FILE"):
            self._assert("frontend", container, image)

    def test_rejects_secret_file_variable_owned_by_another_service(self) -> None:
        container, image = self._valid_documents("postgres")
        payload = json.loads(container.read_text(encoding="utf-8"))
        payload[0]["Config"]["Env"].append(
            "AI_API_KEY_FILE=/run/secrets/ai_api_key"
        )
        container.write_text(json.dumps(payload), encoding="utf-8")

        with self.assertRaisesRegex(SecretExposureError, "unexpected secret file variable"):
            self._assert("postgres", container, image)

    def test_rejects_active_secret_in_container_args(self) -> None:
        container, image = self._valid_documents("backend")
        payload = json.loads(container.read_text(encoding="utf-8"))
        payload[0]["Args"] = ["--credential", self.active_value]
        container.write_text(json.dumps(payload), encoding="utf-8")

        with self.assertRaisesRegex(SecretExposureError, "container inspect metadata") as error:
            self._assert("backend", container, image)
        self.assertNotIn(self.active_value, str(error.exception))

    def test_rejects_retired_secret_in_image_command(self) -> None:
        container, image = self._valid_documents("frontend")
        payload = json.loads(image.read_text(encoding="utf-8"))
        payload[0]["Config"]["Cmd"] = ["node", f"--token={self.retired_value}"]
        image.write_text(json.dumps(payload), encoding="utf-8")

        with self.assertRaisesRegex(SecretExposureError, "image inspect metadata") as error:
            self._assert("frontend", container, image)
        self.assertNotIn(self.retired_value, str(error.exception))


if __name__ == "__main__":
    unittest.main()
