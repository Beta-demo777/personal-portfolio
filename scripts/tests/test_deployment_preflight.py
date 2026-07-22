from __future__ import annotations

import contextlib
import io
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIR))

import deployment_preflight  # noqa: E402


ARGON_HASH = (
    "$argon2id$v=19$m=65536,t=3,p=4$"
    "c2FsdHNhbHQ$c2VjdXJlZGlnaWVzdGhhc2g"
)


class DeploymentPreflightTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="portfolio-preflight-")
        self.root = Path(self.temp.name) / "repo"
        self.root.mkdir()
        (self.root / "nginx" / "certs").mkdir(parents=True)
        self.secret_dir = Path(self.temp.name) / "secrets"
        self.secret_dir.mkdir()
        os.chmod(self.secret_dir, 0o700)
        self.paths: dict[str, Path] = {}
        contents = {
            "PORTFOLIO_POSTGRES_PASSWORD_SECRET_FILE": "postgres-password",
            "PORTFOLIO_POSTGRES_APP_PASSWORD_SECRET_FILE": "app-password",
            "PORTFOLIO_ADMIN_PASSWORD_HASH_SECRET_FILE": ARGON_HASH,
            "PORTFOLIO_APP_SECRET_KEY_SECRET_FILE": "a" * 64,
            "PORTFOLIO_GEMINI_API_KEY_SECRET_FILE": "",
        }
        for name, content in contents.items():
            path = self.secret_dir / name.removeprefix("PORTFOLIO_").lower()
            path.write_text(content, encoding="utf-8")
            os.chmod(path, 0o600)
            self.paths[name] = path
        self.env = self.root / ".env"
        self._write_env()
        os.chmod(self.env, 0o600)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _write_env(
        self,
        extra: str = "",
        *,
        replace: dict[str, str] | None = None,
        omit: tuple[str, ...] = (),
    ) -> None:
        values = {
            "POSTGRES_USER": "portfolio",
            "POSTGRES_DB": "portfolio_cms",
            **{name: str(path) for name, path in self.paths.items()},
        }
        values.update(replace or {})
        for name in omit:
            values.pop(name, None)
        lines = [f"{name}={value}" for name, value in values.items()]
        self.env.write_text("\n".join((*lines, extra, "")), encoding="utf-8")

    def _make_certificate(
        self,
        *,
        days: int = 60,
        mismatched_key: bool = False,
        sans: tuple[str, ...] = ("beta-demo.top", "www.beta-demo.top"),
    ) -> None:
        cert_dir = self.root / "nginx" / "certs"
        key = cert_dir / "beta-demo.top.key"
        csr = Path(self.temp.name) / "certificate.csr"
        cert = cert_dir / "beta-demo.top.pem"
        request = [
            "openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes",
            "-subj", "/CN=beta-demo.top",
        ]
        if sans:
            request.extend(
                (
                    "-addext",
                    "subjectAltName=" + ",".join(f"DNS:{name}" for name in sans),
                )
            )
        request.extend(("-keyout", str(key), "-out", str(csr)))
        subprocess.run(
            request,
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        os.chmod(key, 0o600)
        subprocess.run(
            [
                "openssl", "x509", "-req", "-days", str(days), "-sha256",
                "-in", str(csr), "-signkey", str(key),
                "-copy_extensions", "copy", "-out", str(cert),
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if mismatched_key:
            other = cert_dir / "other.key"
            subprocess.run(
                [
                    "openssl",
                    "genpkey",
                    "-algorithm",
                    "RSA",
                    "-pkeyopt",
                    "rsa_keygen_bits:2048",
                    "-out",
                    str(other),
                ],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            os.chmod(other, 0o600)
            other.replace(key)

    def test_validates_secret_contract_and_allows_empty_gemini(self) -> None:
        deployment_preflight.validate_env(self.root)

    def test_requires_nonempty_database_identity(self) -> None:
        for name in ("POSTGRES_USER", "POSTGRES_DB"):
            for state in ("missing", "empty"):
                with self.subTest(name=name, state=state):
                    self._write_env(
                        replace={name: ""} if state == "empty" else None,
                        omit=(name,) if state == "missing" else (),
                    )
                    with self.assertRaisesRegex(
                        deployment_preflight.PreflightError,
                        f"{name} must be set and non-empty",
                    ):
                        deployment_preflight.validate_env(self.root)

    def test_requires_app_secret_minimum_utf8_byte_length(self) -> None:
        app_secret = self.paths["PORTFOLIO_APP_SECRET_KEY_SECRET_FILE"]
        app_secret.write_text("x" * 31, encoding="utf-8")
        with self.assertRaisesRegex(
            deployment_preflight.PreflightError, "at least 32 UTF-8 bytes"
        ):
            deployment_preflight.validate_env(self.root)

        app_secret.write_text("é" * 16, encoding="utf-8")
        deployment_preflight.validate_env(self.root)

    def test_rejects_insecure_cookie_for_https_origin_but_allows_http_local_dev(self) -> None:
        self._write_env(replace={"AUTH_COOKIE_SECURE": "false"})
        with self.assertRaisesRegex(
            deployment_preflight.PreflightError, "AUTH_COOKIE_SECURE must not be false"
        ):
            deployment_preflight.validate_env(self.root)

        self._write_env(
            replace={"AUTH_COOKIE_SECURE": "false", "PUBLIC_ORIGIN": "http://localhost"}
        )
        deployment_preflight.validate_env(self.root)

    def test_secret_directory_requires_private_mode_and_current_owner(self) -> None:
        os.chmod(self.secret_dir, 0o755)
        with self.assertRaisesRegex(
            deployment_preflight.PreflightError, "secret directory mode must be 0700"
        ):
            deployment_preflight.validate_env(self.root)

        os.chmod(self.secret_dir, 0o700)
        with mock.patch.object(deployment_preflight.os, "getuid", return_value=os.getuid() + 1):
            with self.assertRaisesRegex(
                deployment_preflight.PreflightError, "not owned by the current user"
            ):
                deployment_preflight.validate_env(self.root)

    def test_env_accepts_read_only_mode_and_rejects_execute_or_public_bits(self) -> None:
        os.chmod(self.env, 0o400)
        deployment_preflight.validate_env(self.root)
        for mode in (0o700, 0o640, 0o604):
            with self.subTest(mode=oct(mode)):
                os.chmod(self.env, mode)
                with self.assertRaisesRegex(
                    deployment_preflight.PreflightError, "0600 or stricter"
                ):
                    deployment_preflight.validate_env(self.root)

    def test_rejects_legacy_key_without_printing_secret_or_path(self) -> None:
        secret = "legacy-secret-value"
        self._write_env(f"BLOG_ADMIN_PASSWORD={secret}")
        output = io.StringIO()
        with contextlib.redirect_stderr(output), self.assertRaises(
            deployment_preflight.PreflightError
        ):
            deployment_preflight.validate_env(self.root)
        self.assertNotIn(secret, output.getvalue())
        self.assertNotIn(str(self.paths["PORTFOLIO_APP_SECRET_KEY_SECRET_FILE"]), output.getvalue())

    def test_rejects_relative_or_repository_secret_paths(self) -> None:
        self._write_env(replace={"PORTFOLIO_APP_SECRET_KEY_SECRET_FILE": "relative-secret"})
        with self.assertRaisesRegex(deployment_preflight.PreflightError, "absolute"):
            deployment_preflight.validate_env(self.root)
        inside = self.root / "inside-secret"
        inside.write_text("x", encoding="utf-8")
        os.chmod(inside, 0o600)
        self._write_env(replace={"PORTFOLIO_APP_SECRET_KEY_SECRET_FILE": str(inside)})
        with self.assertRaisesRegex(deployment_preflight.PreflightError, "outside"):
            deployment_preflight.validate_env(self.root)

    def test_rejects_secret_symlink_hardlink_bad_owner_mode_and_size(self) -> None:
        target = self.paths["PORTFOLIO_APP_SECRET_KEY_SECRET_FILE"]
        link = Path(self.temp.name) / "secret-link"
        link.symlink_to(target)
        self.paths["PORTFOLIO_APP_SECRET_KEY_SECRET_FILE"] = link
        self._write_env()
        with self.assertRaisesRegex(deployment_preflight.PreflightError, "symbolic"):
            deployment_preflight.validate_env(self.root)

        self.paths["PORTFOLIO_APP_SECRET_KEY_SECRET_FILE"] = target
        os.chmod(target, 0o640)
        self._write_env()
        with self.assertRaisesRegex(deployment_preflight.PreflightError, "mode"):
            deployment_preflight.validate_env(self.root)
        os.chmod(target, 0o600)
        hardlink = Path(self.temp.name) / "secret-hardlink"
        os.link(target, hardlink)
        self._write_env()
        with self.assertRaisesRegex(deployment_preflight.PreflightError, "hard link"):
            deployment_preflight.validate_env(self.root)
        hardlink.unlink()
        target.write_bytes(b"x" * (deployment_preflight.MAX_SECRET_FILE_BYTES + 1))
        self._write_env()
        with self.assertRaisesRegex(deployment_preflight.PreflightError, "16 KiB"):
            deployment_preflight.validate_env(self.root)

    def test_requires_argon2id_v19_for_admin_file(self) -> None:
        admin = self.paths["PORTFOLIO_ADMIN_PASSWORD_HASH_SECRET_FILE"]
        admin.write_text("$argon2i$v=19$m=65536,t=3,p=4$c2FsdA$ZGlnZXN0", encoding="utf-8")
        with self.assertRaisesRegex(deployment_preflight.PreflightError, "Argon2id v=19"):
            deployment_preflight.validate_env(self.root)

    def test_required_secret_must_be_nonempty_but_exact_size_limit_is_allowed(self) -> None:
        app_secret = self.paths["PORTFOLIO_APP_SECRET_KEY_SECRET_FILE"]
        app_secret.write_text("", encoding="utf-8")
        with self.assertRaisesRegex(deployment_preflight.PreflightError, "must not be empty"):
            deployment_preflight.validate_env(self.root)
        app_secret.write_bytes(b"x" * deployment_preflight.MAX_SECRET_FILE_BYTES)
        deployment_preflight.validate_env(self.root)

    def test_tls_checks_sans_expiry_and_key_pair(self) -> None:
        self._make_certificate()
        deployment_preflight.validate_tls(self.root)
        self._make_certificate(mismatched_key=True)
        with self.assertRaisesRegex(deployment_preflight.PreflightError, "do not match"):
            deployment_preflight.validate_tls(self.root)

    def test_tls_rejects_expiring_certificate_and_insecure_key(self) -> None:
        self._make_certificate(days=1)
        with self.assertRaisesRegex(deployment_preflight.PreflightError, "30 days"):
            deployment_preflight.validate_tls(self.root)
        key = self.root / "nginx" / "certs" / "beta-demo.top.key"
        os.chmod(key, 0o644)
        with self.assertRaisesRegex(deployment_preflight.PreflightError, "0600"):
            deployment_preflight.validate_tls(self.root)

    def test_tls_rejects_certificate_symlink_and_private_key_hardlink(self) -> None:
        self._make_certificate()
        cert = self.root / "nginx" / "certs" / "beta-demo.top.pem"
        real_cert = Path(self.temp.name) / "real-certificate.pem"
        cert.replace(real_cert)
        cert.symlink_to(real_cert)
        with self.assertRaisesRegex(deployment_preflight.PreflightError, "certificate must not"):
            deployment_preflight.validate_tls(self.root)

        cert.unlink()
        real_cert.replace(cert)
        key = self.root / "nginx" / "certs" / "beta-demo.top.key"
        hardlink = Path(self.temp.name) / "private-key-hardlink"
        os.link(key, hardlink)
        with self.assertRaisesRegex(deployment_preflight.PreflightError, "exactly one hard link"):
            deployment_preflight.validate_tls(self.root)

    def test_tls_private_key_requires_current_owner(self) -> None:
        self._make_certificate()
        with mock.patch.object(deployment_preflight.os, "getuid", return_value=os.getuid() + 1):
            with self.assertRaisesRegex(
                deployment_preflight.PreflightError, "not owned by the current user"
            ):
                deployment_preflight.validate_tls(self.root)

    def test_tls_requires_both_dns_sans(self) -> None:
        self._make_certificate(sans=("beta-demo.top",))
        with self.assertRaisesRegex(deployment_preflight.PreflightError, "DNS SANs"):
            deployment_preflight.validate_tls(self.root)

    def test_cli_output_contains_no_path(self) -> None:
        result = subprocess.run(
            [
                sys.executable,
                str(SCRIPTS_DIR / "deployment_preflight.py"),
                "--repo",
                str(self.root),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 1)
        self.assertNotIn(str(self.root), result.stdout + result.stderr)
        self.assertNotIn(str(self.secret_dir), result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
