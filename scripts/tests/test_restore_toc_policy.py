from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import unittest


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIR))

import restore_toc_policy  # noqa: E402
from scripts.tests.toc_fixtures import (  # noqa: E402
    PG18_APPLICATION_TOC,
    with_archive_metadata,
)


class RestoreTocPolicyTests(unittest.TestCase):
    def _validate(self, toc: str, format_version: int = 2) -> None:
        restore_toc_policy.validate_toc_bytes(toc.encode("utf-8"), format_version)

    def _assert_rejected(self, toc: str, format_version: int = 2) -> None:
        with self.assertRaises(restore_toc_policy.TocPolicyError):
            self._validate(toc, format_version)

    def test_accepts_exact_current_and_legacy_application_shapes(self) -> None:
        for format_version in (1, 2, 3):
            with self.subTest(format_version=format_version):
                self._validate(PG18_APPLICATION_TOC, format_version)

    def test_rejects_visible_archive_metadata_and_schema_entries(self) -> None:
        self._assert_rejected(with_archive_metadata())
        self._assert_rejected(
            PG18_APPLICATION_TOC
            + "9007; 2615 2200 SCHEMA - public portfolio\n"
        )

    def test_rejects_unknown_or_dangerous_object_descriptors(self) -> None:
        malicious_entries = (
            "9010; 3079 17000 EXTENSION - untrusted portfolio",
            "9010; 1255 17000 FUNCTION public run_command() portfolio",
            "9010; 3466 17000 EVENT TRIGGER - run_command portfolio",
            "9010; 2615 17000 SCHEMA - private portfolio",
            "9010; 1259 17000 TABLE public audit_log portfolio",
            "9010; 0 0 COMMENT - TABLE site_content portfolio",
        )
        for malicious_entry in malicious_entries:
            with self.subTest(entry=malicious_entry.split()[3]):
                self._assert_rejected(f"{PG18_APPLICATION_TOC}{malicious_entry}\n")

    def test_rejects_duplicate_dump_ids_and_semantic_objects(self) -> None:
        duplicate_id = PG18_APPLICATION_TOC.replace(
            "222; 1259 16403 TABLE public content_revisions portfolio",
            "219; 1259 16403 TABLE public content_revisions portfolio",
        )
        duplicate_object = PG18_APPLICATION_TOC.replace(
            "220; 1259 16391 TABLE public site_content portfolio",
            "220; 1259 16391 TABLE public site_content portfolio\n"
            "9010; 1259 17000 TABLE public site_content portfolio",
        )
        self._assert_rejected(duplicate_id)
        self._assert_rejected(duplicate_object)

    def test_rejects_missing_metadata_or_application_objects(self) -> None:
        missing_alembic_data = PG18_APPLICATION_TOC.replace(
            "3859; 0 16385 TABLE DATA public alembic_version portfolio\n", ""
        )
        self._assert_rejected(missing_alembic_data)

    def test_rejects_oid_mismatch_and_invalid_restore_order(self) -> None:
        mismatched_data_oid = PG18_APPLICATION_TOC.replace(
            "3859; 0 16385 TABLE DATA public alembic_version portfolio",
            "3859; 0 17000 TABLE DATA public alembic_version portfolio",
        )
        default_line = "3704; 2604 16406 DEFAULT public content_revisions id portfolio\n"
        after_data = PG18_APPLICATION_TOC.replace(default_line, "").replace(
            "3862; 0 16403 TABLE DATA public content_revisions portfolio\n",
            "3862; 0 16403 TABLE DATA public content_revisions portfolio\n"
            + default_line,
        )
        self._assert_rejected(mismatched_data_oid)
        self._assert_rejected(after_data)

    def test_enforces_byte_line_and_entry_limits(self) -> None:
        too_many_bytes = PG18_APPLICATION_TOC + ";" + (
            "x" * restore_toc_policy.MAX_TOC_BYTES
        )
        too_many_lines = PG18_APPLICATION_TOC + (
            ";\n" * restore_toc_policy.MAX_TOC_LINES
        )
        extra_entries = "".join(
            f"{9500 + index}; 1259 {20000 + index} TABLE public extra_{index} portfolio\n"
            for index in range(restore_toc_policy.MAX_TOC_ENTRIES)
        )
        self._assert_rejected(too_many_bytes)
        self._assert_rejected(too_many_lines)
        self._assert_rejected(PG18_APPLICATION_TOC + extra_entries)

    def test_cli_error_does_not_echo_untrusted_toc_values(self) -> None:
        secret_marker = "private-object-name-must-not-leak"
        payload = (
            PG18_APPLICATION_TOC
            + f"9010; 1255 17000 FUNCTION public {secret_marker}() portfolio\n"
        )
        result = subprocess.run(
            (
                sys.executable,
                str(SCRIPTS_DIR / "restore_toc_policy.py"),
                "--format-version",
                "2",
            ),
            input=payload,
            capture_output=True,
            text=True,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
            check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("application object policy", result.stderr)
        self.assertNotIn(secret_marker, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
