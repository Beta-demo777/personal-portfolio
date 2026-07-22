from __future__ import annotations

from pathlib import Path
import unittest


ROOT_DIR = Path(__file__).resolve().parents[2]
NGINX_CONFIG = ROOT_DIR / "nginx" / "conf.d" / "default.conf"
COMPOSE_CONFIG = ROOT_DIR / "docker-compose.yml"
ENV_EXAMPLE = ROOT_DIR / ".env.example"


def configuration_block(source: str, marker: str) -> str:
    marker_offset = source.index(marker)
    opening_brace = source.index("{", marker_offset)
    depth = 0
    for offset in range(opening_brace, len(source)):
        character = source[offset]
        if character == "{":
            depth += 1
        elif character == "}":
            depth -= 1
            if depth == 0:
                return source[opening_brace + 1 : offset]
    raise AssertionError(f"Unterminated configuration block after {marker!r}")


class NginxConfigurationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.nginx = NGINX_CONFIG.read_text(encoding="utf-8")
        cls.compose = COMPOSE_CONFIG.read_text(encoding="utf-8")
        cls.environment_example = ENV_EXAMPLE.read_text(encoding="utf-8")

    def location(self, declaration: str) -> str:
        return configuration_block(self.nginx, declaration)

    def test_connection_limits_cover_all_requests_and_large_bodies(self) -> None:
        for directive in (
            "limit_conn_zone $hostname zone=portfolio_global_connections:1m;",
            "limit_conn_zone $binary_remote_addr zone=portfolio_per_ip_connections:1m;",
            "limit_conn_zone $hostname zone=portfolio_large_body_global:1m;",
            "limit_conn_zone $binary_remote_addr zone=portfolio_large_body_per_ip:1m;",
            "limit_conn portfolio_global_connections 128;",
            "limit_conn portfolio_per_ip_connections 32;",
            "limit_conn_status 429;",
        ):
            self.assertIn(directive, self.nginx)

        for declaration in (
            "location = /backend/api/v1/admin/content",
            "location = /backend/api/v1/admin/uploads",
        ):
            block = self.location(declaration)
            self.assertIn("limit_conn portfolio_large_body_global 4;", block)
            self.assertIn("limit_conn portfolio_large_body_per_ip 2;", block)

    def test_upload_route_streams_an_eight_mib_file_with_multipart_margin(self) -> None:
        upload = self.location("location = /backend/api/v1/admin/uploads")

        self.assertIn("client_max_body_size 9m;", upload)
        self.assertIn("proxy_request_buffering off;", upload)
        self.assertIn(
            "proxy_pass http://portfolio_backend/api/v1/admin/uploads;", upload
        )
        self.assertEqual(self.nginx.count("client_max_body_size 9m;"), 1)

    def test_content_save_streams_while_other_request_bodies_remain_small(self) -> None:
        content = self.location("location = /backend/api/v1/admin/content")
        agent = self.location("location ^~ /api/agent/chat")
        login = self.location("location ^~ /backend/api/v1/admin/login")
        backend = self.location("location /backend/")

        self.assertIn("client_max_body_size 3m;", content)
        self.assertIn("proxy_request_buffering off;", content)
        self.assertIn("client_max_body_size 64k;", agent)
        self.assertIn("client_max_body_size 16k;", login)
        self.assertIn("client_max_body_size 64k;", backend)
        self.assertEqual(self.nginx.count("proxy_request_buffering off;"), 2)

    def test_large_body_routes_preserve_backend_proxy_contract(self) -> None:
        expected_directives = (
            "proxy_http_version 1.1;",
            "proxy_set_header Host $host;",
            "proxy_set_header X-Real-IP $remote_addr;",
            "proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
            "proxy_set_header X-Forwarded-Proto $scheme;",
            "proxy_set_header X-Request-ID $request_id;",
            "proxy_hide_header X-Powered-By;",
            "proxy_connect_timeout 3s;",
            "proxy_send_timeout 30s;",
            "proxy_read_timeout 30s;",
        )
        for declaration in (
            "location = /backend/api/v1/admin/content",
            "location = /backend/api/v1/admin/uploads",
        ):
            block = self.location(declaration)
            for directive in expected_directives:
                self.assertIn(directive, block)

    def test_healthcheck_verifies_tls_with_system_or_explicit_ci_ca(self) -> None:
        self.assertIn("NGINX_HEALTH_CA_FILE: ${NGINX_HEALTH_CA_FILE:-}", self.compose)
        self.assertIn("NGINX_HEALTH_CA_FILE=", self.environment_example)
        self.assertIn('"beta-demo.top:127.0.0.1"', self.compose)
        self.assertIn("https://beta-demo.top/healthz", self.compose)
        self.assertIn("--cacert \"$$NGINX_HEALTH_CA_FILE\"", self.compose)
        self.assertIn("curl --fail --silent --show-error", self.compose)
        self.assertNotIn("--no-check-certificate", self.compose)
        self.assertNotIn("https://127.0.0.1/healthz", self.compose)


if __name__ == "__main__":
    unittest.main()
