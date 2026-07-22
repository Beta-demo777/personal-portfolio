from __future__ import annotations

import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import time
import unittest


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
ROOT_DIR = SCRIPTS_DIR.parent
DEPLOY_SCRIPT = SCRIPTS_DIR / "deploy.sh"
LOCK_SCRIPT = SCRIPTS_DIR / "maintenance-lock.sh"


class DeployLifecycleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary_directory.name)
        self.fake_bin = self.base / "bin"
        self.fake_bin.mkdir()
        self.docker_log = self.base / "docker.log"

        docker = self.fake_bin / "docker"
        docker.write_text(
            """#!/bin/sh
printf '%s\n' "$*" >> "$DOCKER_LOG"
case "$*" in
    "compose version --short")
        printf '%s\n' "${FAKE_COMPOSE_VERSION:-2.30.0}"
        ;;
    *" config --quiet")
        if [ "${FAKE_CONFIG_FAIL:-false}" = true ]; then
            exit 48
        fi
        ;;
    *" build backend database-init frontend")
        ;;
    *" stop backend")
        ;;
    *" run --rm --no-deps -T secret-init")
        ;;
    *" up --detach --wait --wait-timeout 60 --no-deps postgres")
        ;;
    *" run --rm --no-deps -T database-init")
        if [ "${FAKE_DATABASE_INIT_FAIL:-false}" = true ]; then
            exit 42
        fi
        ;;
    *" up --detach --wait --wait-timeout 60 --no-deps --force-recreate backend")
        if [ "${FAKE_APPLICATION_FAIL:-}" = backend ]; then
            exit 43
        fi
        ;;
    *" up --detach --wait --wait-timeout 60 --no-deps --force-recreate frontend")
        if [ "${FAKE_APPLICATION_FAIL:-}" = frontend ]; then
            exit 44
        fi
        ;;
    *" up --detach --wait --wait-timeout 60 --no-deps --force-recreate nginx")
        if [ "${FAKE_APPLICATION_FAIL:-}" = nginx ]; then
            exit 45
        fi
        ;;
    *" exec -T nginx sh -euc "*)
        if [ "${FAKE_PUBLIC_PROBE_FAIL:-false}" = true ]; then
            exit 46
        fi
        printf '%s' "${FAKE_PUBLIC_HTTP_STATUS:-200}"
        ;;
    *" stop nginx backend frontend")
        ;;
    *)
        printf 'unexpected fake docker invocation: %s\n' "$*" >&2
        exit 98
        ;;
esac
""",
            encoding="utf-8",
        )
        docker.chmod(0o755)

        python = self.fake_bin / "python3"
        python.write_text(
            "#!/bin/sh\n"
            "case \"$*\" in\n"
            "    *deployment_preflight.py*)\n"
            "        if [ \"${FAKE_PREFLIGHT_FAIL:-false}\" = true ]; then\n"
            "            printf '%s\\n' 'deployment preflight: FAILED: test failure' >&2\n"
            "            exit 47\n"
            "        fi\n"
            "        exit 0\n"
            "        ;;\n"
            f"    *) exec {shlex.quote(sys.executable)} \"$@\" ;;\n"
            "esac\n",
            encoding="utf-8",
        )
        python.chmod(0o755)

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def _environment(
        self,
        project_name: str,
        *,
        migration_fails: bool = False,
        compose_version: str = "2.30.0",
        application_failure: str = "",
        public_http_status: str = "200",
        public_probe_fails: bool = False,
        preflight_fails: bool = False,
        config_fails: bool = False,
    ) -> dict[str, str]:
        environment = os.environ.copy()
        environment.update(
            {
                "DOCKER_LOG": str(self.docker_log),
                "FAKE_COMPOSE_VERSION": compose_version,
                "FAKE_DATABASE_INIT_FAIL": "true" if migration_fails else "false",
                "FAKE_APPLICATION_FAIL": application_failure,
                "FAKE_PUBLIC_HTTP_STATUS": public_http_status,
                "FAKE_PUBLIC_PROBE_FAIL": "true" if public_probe_fails else "false",
                "FAKE_PREFLIGHT_FAIL": "true" if preflight_fails else "false",
                "FAKE_CONFIG_FAIL": "true" if config_fails else "false",
                "PATH": f"{self.fake_bin}{os.pathsep}{environment['PATH']}",
                "PORTFOLIO_COMPOSE_PROJECT_NAME": project_name,
                "PORTFOLIO_MAINTENANCE_LOCK_DIR": str(self.base / "locks"),
            }
        )
        return environment

    def _run_deploy(
        self,
        project_name: str = "deploy-lifecycle-test",
        *,
        migration_fails: bool = False,
        compose_version: str = "2.30.0",
        application_failure: str = "",
        public_http_status: str = "200",
        public_probe_fails: bool = False,
        preflight_fails: bool = False,
        config_fails: bool = False,
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            (str(DEPLOY_SCRIPT),),
            cwd=self.base,
            env=self._environment(
                project_name,
                migration_fails=migration_fails,
                compose_version=compose_version,
                application_failure=application_failure,
                public_http_status=public_http_status,
                public_probe_fails=public_probe_fails,
                preflight_fails=preflight_fails,
                config_fails=config_fails,
            ),
            capture_output=True,
            text=True,
            check=False,
        )

    def _expected_commands(self, project_name: str) -> list[str]:
        compose_prefix = (
            f"compose --project-name {project_name} "
            f"--project-directory {ROOT_DIR} --file {ROOT_DIR / 'docker-compose.yml'}"
        )
        return [
            "compose version --short",
            f"{compose_prefix} config --quiet",
            f"{compose_prefix} build backend database-init frontend",
            f"{compose_prefix} stop backend",
            f"{compose_prefix} run --rm --no-deps -T secret-init",
            (
                f"{compose_prefix} up --detach --wait --wait-timeout 60 "
                "--no-deps postgres"
            ),
            f"{compose_prefix} run --rm --no-deps -T database-init",
            (
                f"{compose_prefix} up --detach --wait --wait-timeout 60 "
                "--no-deps --force-recreate backend"
            ),
            (
                f"{compose_prefix} up --detach --wait --wait-timeout 60 "
                "--no-deps --force-recreate frontend"
            ),
            (
                f"{compose_prefix} up --detach --wait --wait-timeout 60 "
                "--no-deps --force-recreate nginx"
            ),
        ]

    def _docker_commands(self) -> list[str]:
        return self.docker_log.read_text(encoding="utf-8").splitlines()

    def _start_lock_holder(self, project_name: str) -> tuple[subprocess.Popen[str], Path]:
        marker = self.base / "holder.ready"
        release = self.base / "holder.release"
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
                "deploy-test-holder",
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
        self.assertTrue(
            marker.exists(),
            process.stderr.read() if process.poll() is not None else "lock holder timed out",
        )
        return process, release

    def test_success_uses_safe_order_and_custom_project(self) -> None:
        project_name = "custom-portfolio"
        result = self._run_deploy(project_name)

        self.assertEqual(result.returncode, 0, f"{result.stdout}\n{result.stderr}")
        commands = self._docker_commands()
        self.assertEqual(commands[:-1], self._expected_commands(project_name))
        self.assertIn("portfolio-public-site-acceptance", commands[-1])
        self.assertIn(
            f"Deployment completed for Compose project {project_name}.", result.stdout
        )

    def test_nginx_healthcheck_uses_the_tls_server_name_on_loopback(self) -> None:
        compose = (ROOT_DIR / "docker-compose.yml").read_text(encoding="utf-8")

        self.assertIn('"beta-demo.top:127.0.0.1"', compose)
        self.assertIn("https://beta-demo.top/healthz", compose)
        self.assertNotIn("https://127.0.0.1/healthz", compose)

    def test_unsupported_compose_version_fails_before_data_or_service_operations(self) -> None:
        result = self._run_deploy(compose_version="2.29.7")

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self._docker_commands(), ["compose version --short"])
        self.assertIn("Docker Compose 2.30.0 or newer is required", result.stderr)

    def test_preflight_failure_precedes_compose_configuration_and_build(self) -> None:
        result = self._run_deploy(preflight_fails=True)

        self.assertEqual(result.returncode, 47)
        self.assertEqual(self._docker_commands(), ["compose version --short"])
        self.assertIn("deployment preflight: FAILED", result.stderr)

    def test_compose_configuration_failure_precedes_build_and_data_operations(self) -> None:
        project_name = "config-failure"
        result = self._run_deploy(project_name, config_fails=True)

        self.assertEqual(result.returncode, 48)
        self.assertEqual(
            self._docker_commands(),
            self._expected_commands(project_name)[:2],
        )
        self.assertNotIn(" build ", "\n".join(self._docker_commands()))

    def test_migration_failure_leaves_backend_stopped(self) -> None:
        project_name = "migration-failure"
        result = self._run_deploy(project_name, migration_fails=True)

        self.assertEqual(result.returncode, 42, f"{result.stdout}\n{result.stderr}")
        self.assertEqual(
            self._docker_commands(), self._expected_commands(project_name)[:-3]
        )
        self.assertIn("backend remains stopped", result.stderr)
        self.assertNotIn(
            "--force-recreate backend", "\n".join(self._docker_commands())
        )

    def test_application_readiness_failure_stops_edge_and_application_services(self) -> None:
        project_name = "application-failure"
        compose_prefix = (
            f"compose --project-name {project_name} "
            f"--project-directory {ROOT_DIR} --file {ROOT_DIR / 'docker-compose.yml'}"
        )

        for service, expected_code in (("backend", 43), ("frontend", 44), ("nginx", 45)):
            with self.subTest(service=service):
                self.docker_log.unlink(missing_ok=True)
                result = self._run_deploy(
                    project_name,
                    application_failure=service,
                )
                self.assertEqual(result.returncode, expected_code)
                commands = self._docker_commands()
                self.assertEqual(
                    commands[-1],
                    f"{compose_prefix} stop nginx backend frontend",
                )
                self.assertIn(
                    "stopped to avoid a partial deployment",
                    result.stderr,
                )
                if service == "backend":
                    self.assertFalse(any(
                        "--force-recreate frontend" in command
                        or "--force-recreate nginx" in command
                        for command in commands
                    ))
                elif service == "frontend":
                    self.assertFalse(any(
                        "--force-recreate nginx" in command
                        for command in commands
                    ))

    def test_public_site_requires_exact_http_200_and_keeps_ready_services(self) -> None:
        for public_status in ("204", "302", "503"):
            with self.subTest(public_status=public_status):
                self.docker_log.unlink(missing_ok=True)
                result = self._run_deploy(
                    "public-site-failure",
                    public_http_status=public_status,
                )

                self.assertEqual(result.returncode, 1)
                commands = self._docker_commands()
                self.assertEqual(
                    commands[:-1],
                    self._expected_commands("public-site-failure"),
                )
                self.assertIn("portfolio-public-site-acceptance", commands[-1])
                self.assertNotIn("stop nginx backend frontend", "\n".join(commands))
                self.assertNotIn("Deployment completed", result.stdout)
                self.assertIn("public site did not return HTTP 200", result.stderr)
                self.assertIn("application services remain running", result.stderr)

    def test_public_site_transport_failure_keeps_ready_services_running(self) -> None:
        result = self._run_deploy(
            "public-probe-failure",
            public_probe_fails=True,
        )

        self.assertEqual(result.returncode, 1)
        commands = self._docker_commands()
        self.assertEqual(commands[:-1], self._expected_commands("public-probe-failure"))
        self.assertNotIn("stop nginx backend frontend", "\n".join(commands))
        self.assertNotIn("Deployment completed", result.stdout)
        self.assertIn("public site acceptance request failed", result.stderr)
        self.assertIn("application services remain running", result.stderr)

    def test_lock_conflict_exits_before_any_docker_command(self) -> None:
        project_name = "locked-deployment"
        holder, release = self._start_lock_holder(project_name)
        try:
            result = self._run_deploy(project_name)

            self.assertEqual(result.returncode, 75, result.stderr)
            self.assertIn("another maintenance operation", result.stderr)
            self.assertFalse(self.docker_log.exists())
        finally:
            release.touch()
            stdout, stderr = holder.communicate(timeout=5)
            self.assertEqual(holder.returncode, 0, f"{stdout}\n{stderr}")


if __name__ == "__main__":
    unittest.main()
