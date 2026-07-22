from __future__ import annotations

import json
from pathlib import Path
import unittest


ROOT_DIR = Path(__file__).resolve().parents[2]


class DeepSeekProviderTests(unittest.TestCase):
    def test_frontend_uses_only_the_deepseek_compatible_sdk(self) -> None:
        package = json.loads((ROOT_DIR / "frontend/package.json").read_text(encoding="utf-8"))
        lockfile = (ROOT_DIR / "frontend/package-lock.json").read_text(encoding="utf-8")
        retired_sdk = "@google/" + "genai"

        self.assertIn("openai", package["dependencies"])
        self.assertNotIn(retired_sdk, package["dependencies"])
        self.assertNotIn(retired_sdk, lockfile)

    def test_runtime_is_pinned_to_deepseek_with_a_current_default_model(self) -> None:
        agent = (ROOT_DIR / "frontend/server/agent.ts").read_text(encoding="utf-8")
        config = (ROOT_DIR / "frontend/server/config.ts").read_text(encoding="utf-8")
        compose = (ROOT_DIR / "docker-compose.yml").read_text(encoding="utf-8")

        self.assertIn("https://api.deepseek.com", agent)
        self.assertIn("chat.completions.create", agent)
        self.assertIn("thinking: { type: 'disabled' }", agent)
        self.assertIn("deepseek-v4-flash", config)
        self.assertIn("AI_MODEL: ${AI_MODEL:-deepseek-v4-flash}", compose)


if __name__ == "__main__":
    unittest.main()
