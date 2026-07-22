import unittest

from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from app.core.api_errors import CONTENT_VERSION_CONFLICT
from app.core.content_version import EMPTY_CONTENT_ETAG, content_etag, require_matching_etag
from app.core.login_limiter import parse_trusted_proxy_cidrs
from app.core.origin import parse_origin, validate_same_origin_request


def make_request(headers: dict[str, str], *, client: str = "198.51.100.10") -> Request:
    raw_headers = [(key.lower().encode(), value.encode()) for key, value in headers.items()]
    return Request({
        "type": "http",
        "method": "POST",
        "scheme": "http",
        "path": "/api/v1/admin/content",
        "raw_path": b"/api/v1/admin/content",
        "query_string": b"",
        "headers": raw_headers,
        "client": (client, 12345),
        "server": ("beta-demo.top", 80),
    })


class ContentVersionTests(unittest.TestCase):
    def test_empty_and_canonical_etags_are_stable(self) -> None:
        self.assertEqual(content_etag(None), EMPTY_CONTENT_ETAG)
        self.assertEqual(content_etag({"b": 2, "a": 1}), content_etag({"a": 1, "b": 2}))

    def test_if_match_is_required_and_conflicts_are_reported(self) -> None:
        with self.assertRaises(HTTPException) as missing:
            require_matching_etag(None, '"current"')
        self.assertEqual(missing.exception.status_code, 428)

        with self.assertRaises(HTTPException) as conflict:
            require_matching_etag('"old"', '"current"')
        self.assertEqual(conflict.exception.status_code, 409)
        self.assertEqual(
            conflict.exception.detail,
            {
                "code": CONTENT_VERSION_CONFLICT,
                "message": "Content changed in another session. Reload before publishing.",
            },
        )
        require_matching_etag(' "current" ', '"current"')

    def test_conflict_http_response_uses_the_machine_readable_detail_envelope(self) -> None:
        application = FastAPI()

        def stale_write() -> None:
            require_matching_etag('"old"', '"current"')

        application.add_api_route("/stale-write", stale_write, methods=["PUT"])
        with TestClient(application) as client:
            response = client.put("/stale-write")

        self.assertEqual(response.status_code, 409)
        self.assertEqual(
            response.json(),
            {
                "detail": {
                    "code": CONTENT_VERSION_CONFLICT,
                    "message": (
                        "Content changed in another session. Reload before publishing."
                    ),
                }
            },
        )


class OriginProtectionTests(unittest.TestCase):
    def test_exact_same_origin_is_allowed_but_sibling_domain_is_rejected(self) -> None:
        validate_same_origin_request(make_request({
            "host": "beta-demo.top",
            "origin": "http://beta-demo.top",
        }))

        with self.assertRaises(HTTPException) as rejected:
            validate_same_origin_request(make_request({
                "host": "beta-demo.top",
                "origin": "http://www.beta-demo.top",
            }))
        self.assertEqual(rejected.exception.status_code, 403)

    def test_trusted_proxy_forwarded_scheme_supports_https_origin(self) -> None:
        request = make_request({
            "host": "beta-demo.top",
            "origin": "https://beta-demo.top",
            "x-forwarded-proto": "https",
        }, client="172.20.0.5")
        validate_same_origin_request(
            request,
            trusted_proxies=parse_trusted_proxy_cidrs("172.16.0.0/12"),
        )

    def test_missing_origin_requires_browser_signal_or_trusted_referer(self) -> None:
        validate_same_origin_request(make_request({
            "host": "beta-demo.top",
            "sec-fetch-site": "same-origin",
        }))
        validate_same_origin_request(make_request({
            "host": "beta-demo.top",
            "referer": "http://beta-demo.top/admin",
        }))

        with self.assertRaises(HTTPException) as missing:
            validate_same_origin_request(make_request({"host": "beta-demo.top"}))
        self.assertEqual(missing.exception.status_code, 403)

    def test_explicit_trusted_origin_is_exact_and_parser_rejects_paths(self) -> None:
        validate_same_origin_request(
            make_request({
                "host": "beta-demo.top",
                "origin": "https://cms.example.com:8443",
            }),
            trusted_origins="https://cms.example.com:8443",
        )
        with self.assertRaises(ValueError):
            parse_origin("https://beta-demo.top/admin")


if __name__ == "__main__":
    unittest.main()
