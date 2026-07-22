from __future__ import annotations

import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scan_secrets.py"
SPEC = importlib.util.spec_from_file_location("scan_secrets", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("could not load secret scanner")
scan_secrets = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = scan_secrets
SPEC.loader.exec_module(scan_secrets)


class SecretScannerTests(unittest.TestCase):
    def test_detects_high_confidence_and_generic_secrets_without_returning_values(self) -> None:
        google_key = "".join(("AIza012345", "6789abcdef", "GHIJKLMNOP", "QRSTUVXYZ"))
        session_secret = "".join(("Q9mV7wK2", "pR4xT8zN", "cF6hJ3sL", "uD5gB1yE"))
        text = f"GOOGLE_API_KEY={google_key}\nAPP_SECRET_KEY={session_secret}\n"

        findings = scan_secrets.scan_text(text, source="test", path="fixture.env")

        self.assertEqual(
            {finding.rule for finding in findings},
            {"google-api-key", "high-entropy-secret-assignment"},
        )
        self.assertNotIn(google_key, repr(findings))
        self.assertNotIn(session_secret, repr(findings))

    def test_allows_obvious_placeholders_and_secret_file_paths(self) -> None:
        text = "\n".join(
            (
                "APP_SECRET_KEY=change-me-in-production",
                "APP_SECRET_KEY_FILE=/run/secrets/app_secret_key",
                "APP_SECRET_KEY=ci_only_session_key_at_least_32_bytes",
            )
        )
        self.assertEqual(
            scan_secrets.scan_text(text, source="test", path="example.env"),
            [],
        )

    def test_explicit_allow_marker_is_limited_to_the_fixture_line(self) -> None:
        first = "".join(("Q9mV7wK2", "pR4xT8zN", "cF6hJ3sL", "uD5gB1yE"))
        second = "".join(("A7nC4rP9", "wE2kM6xT", "dH8qL1sV", "bF5jU3yR"))
        text = (
            f"APP_SECRET_KEY={first} # secret-scan: allow-test-fixture\n"
            f"APP_SECRET_KEY={second}\n"
        )

        findings = scan_secrets.scan_text(text, source="test", path="fixture.env")

        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].line, 2)

    def test_history_mode_finds_a_removed_secret_and_redacts_output(self) -> None:
        secret = "".join(("Q9mV7wK2", "pR4xT8zN", "cF6hJ3sL", "uD5gB1yE"))
        with tempfile.TemporaryDirectory(prefix="portfolio-secret-history-") as directory:
            repo = Path(directory)
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            subprocess.run(
                ["git", "-C", str(repo), "config", "user.email", "scanner@example.invalid"],
                check=True,
            )
            subprocess.run(
                ["git", "-C", str(repo), "config", "user.name", "Secret Scanner Test"],
                check=True,
            )
            fixture = repo / "config.env"
            fixture.write_text(f"APP_SECRET_KEY={secret}\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(repo), "add", "config.env"], check=True)
            subprocess.run(["git", "-C", str(repo), "commit", "-qm", "add fixture"], check=True)
            fixture.unlink()
            (repo / "README.md").write_text("safe\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True)
            subprocess.run(["git", "-C", str(repo), "commit", "-qm", "remove fixture"], check=True)

            current = subprocess.run(
                [sys.executable, str(SCRIPT), "--repo", str(repo)],
                capture_output=True,
                text=True,
                check=False,
            )
            history = subprocess.run(
                [sys.executable, str(SCRIPT), "--repo", str(repo), "--history"],
                capture_output=True,
                text=True,
                check=False,
            )

        self.assertEqual(current.returncode, 0, current.stderr)
        self.assertEqual(history.returncode, 1)
        self.assertIn("history:config.env:1", history.stderr)
        self.assertIn("rule=high-entropy-secret-assignment", history.stderr)
        self.assertNotIn(secret, history.stdout + history.stderr)


if __name__ == "__main__":
    unittest.main()
