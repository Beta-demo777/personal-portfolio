from __future__ import annotations

from pathlib import Path
import subprocess
import unittest


ROOT_DIR = Path(__file__).resolve().parents[2]


class VendorNeutralAINamingTests(unittest.TestCase):
    def test_all_tracked_text_uses_generic_ai_terminology(self) -> None:
        prohibited_name = "ge" + "mini"
        tracked = subprocess.check_output(
            ["git", "ls-files", "-z"],
            cwd=ROOT_DIR,
        ).decode("utf-8").split("\0")
        offenders: list[str] = []
        for relative_path in tracked:
            if not relative_path:
                continue
            path = ROOT_DIR / relative_path
            try:
                text = path.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                continue
            if prohibited_name in text.casefold():
                offenders.append(relative_path)

        self.assertEqual(offenders, [])


if __name__ == "__main__":
    unittest.main()
