from __future__ import annotations

from pathlib import Path
import unittest


ROOT_DIR = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT_DIR / ".github" / "workflows" / "ci.yml"


class CIWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.workflow = WORKFLOW.read_text(encoding="utf-8")
        cls.compose_job = cls.workflow.split("\n  compose:\n", 1)[1]

    def test_compose_job_runs_preflight_before_build(self) -> None:
        preflight = self.compose_job.index(
            "python3 scripts/deployment_preflight.py"
        )
        compose_config = self.compose_job.index(
            "- name: Validate Compose configuration"
        )
        build = self.compose_job.index("- name: Build application images")
        self.assertLess(preflight, compose_config)
        self.assertLess(compose_config, build)
        self.assertIn('--repository "${GITHUB_WORKSPACE}"', self.compose_job)
        self.assertIn('--env "${env_file}"', self.compose_job)
        self.assertIn(
            'env_file="${RUNNER_TEMP}/portfolio-compose.env"',
            self.compose_job,
        )

    def test_compose_fixtures_satisfy_tls_and_are_cleaned_up(self) -> None:
        self.assertIn(
            "openssl req -x509 -newkey rsa:2048 -nodes -days 90",
            self.compose_job,
        )
        self.assertIn("openssl x509 -req -days 90", self.compose_job)
        self.assertIn('chmod 0600 "${env_file}"', self.compose_job)
        self.assertIn(
            'rm -f -- "${RUNNER_TEMP}/portfolio-compose.env"',
            self.compose_job,
        )
        self.assertIn(
            'rm -rf -- "${RUNNER_TEMP}/portfolio-compose-api"',
            self.compose_job,
        )

    def test_compose_initializes_cms_through_real_admin_api_before_smoke(self) -> None:
        initialize = self.compose_job.index(
            "- name: Initialize CMS through the administrator API"
        )
        smoke = self.compose_job.index("- name: Run HTTPS smoke checks")
        self.assertLess(initialize, smoke)
        self.assertIn(
            "https://beta-demo.top/backend/api/v1/admin/login",
            self.compose_job,
        )
        self.assertIn(
            "https://beta-demo.top/backend/api/v1/admin/content",
            self.compose_job,
        )
        self.assertIn('--header "If-Match: ${initial_etag}"', self.compose_job)
        self.assertIn(
            'test "${initial_etag}" = \'"0"\'',
            self.compose_job,
        )
        self.assertIn(
            '"id": "micro-interactions"',
            self.compose_job,
        )
        self.assertIn(
            "grep -Fq 'type=\"application/ld+json\"'",
            self.compose_job,
        )

    def test_compose_admin_password_is_file_backed_and_never_in_curl_arguments(self) -> None:
        self.assertIn(
            'admin_password_file="${secrets_dir}/admin_password"',
            self.compose_job,
        )
        self.assertIn(
            'echo "PORTFOLIO_ADMIN_PASSWORD_FILE=${admin_password_file}"',
            self.compose_job,
        )
        self.assertIn(
            '--data-binary "@${login_payload}"',
            self.compose_job,
        )
        initialize_step = self.compose_job.split(
            "- name: Initialize CMS through the administrator API",
            1,
        )[1].split("- name: Run HTTPS smoke checks", 1)[0]
        self.assertNotIn("${admin_password}", initialize_step)

    def test_preflight_env_contains_only_contract_values_and_secret_paths(self) -> None:
        required_names = (
            "POSTGRES_USER",
            "POSTGRES_DB",
            "AUTH_COOKIE_SECURE",
            "PUBLIC_ORIGIN",
            "PORTFOLIO_POSTGRES_PASSWORD_SECRET_FILE",
            "PORTFOLIO_POSTGRES_APP_PASSWORD_SECRET_FILE",
            "PORTFOLIO_ADMIN_PASSWORD_HASH_SECRET_FILE",
            "PORTFOLIO_APP_SECRET_KEY_SECRET_FILE",
            "PORTFOLIO_AI_API_KEY_SECRET_FILE",
        )
        for name in required_names:
            with self.subTest(name=name):
                self.assertIn(f'"{name}=${{{name}}}"', self.compose_job)

    def test_preflight_fixture_does_not_use_repository_env(self) -> None:
        self.assertNotIn('--env "${GITHUB_WORKSPACE}/.env"', self.compose_job)


if __name__ == "__main__":
    unittest.main()
