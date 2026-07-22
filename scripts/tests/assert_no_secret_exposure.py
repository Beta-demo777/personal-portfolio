from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Iterator


EXPECTED_SECRET_FILE_ENV = {
    "postgres": {
        "POSTGRES_PASSWORD_FILE": "/run/secrets/postgres_password",
    },
    "database-init": {
        "POSTGRES_PASSWORD_FILE": "/run/secrets/postgres_password",
        "POSTGRES_RUNTIME_PASSWORD_FILE": "/run/secrets/postgres_app_password",
    },
    "backend": {
        "POSTGRES_PASSWORD_FILE": "/run/secrets/postgres_app_password",
        "BLOG_ADMIN_PASSWORD_HASH_FILE": "/run/secrets/blog_admin_password_hash",
        "APP_SECRET_KEY_FILE": "/run/secrets/app_secret_key",
    },
    "frontend": {
        "GEMINI_API_KEY_FILE": "/run/secrets/gemini_api_key",
    },
}

PLAINTEXT_SECRET_ENV_NAMES = {
    "POSTGRES_PASSWORD",
    "POSTGRES_APP_PASSWORD",
    "POSTGRES_RUNTIME_PASSWORD",
    "BLOG_ADMIN_PASSWORD",
    "BLOG_ADMIN_PASSWORD_HASH",
    "APP_SECRET_KEY",
    "GEMINI_API_KEY",
}

HOST_SECRET_PATH_ENV_NAMES = {
    "PORTFOLIO_POSTGRES_PASSWORD_SECRET_FILE",
    "PORTFOLIO_POSTGRES_APP_PASSWORD_SECRET_FILE",
    "PORTFOLIO_ADMIN_PASSWORD_HASH_SECRET_FILE",
    "PORTFOLIO_APP_SECRET_KEY_SECRET_FILE",
    "PORTFOLIO_GEMINI_API_KEY_SECRET_FILE",
}

KNOWN_SECRET_FILE_ENV_NAMES = {
    name
    for service_environment in EXPECTED_SECRET_FILE_ENV.values()
    for name in service_environment
} | {"BLOG_ADMIN_PASSWORD_FILE"}

SECRET_FILE_ENV_SUFFIXES = (
    "_PASSWORD_FILE",
    "_PASSWORD_HASH_FILE",
    "_SECRET_FILE",
    "_SECRET_KEY_FILE",
    "_API_KEY_FILE",
    "_TOKEN_FILE",
)


class SecretExposureError(RuntimeError):
    pass


def _load_inspect_document(path: Path, label: str) -> dict[str, object]:
    with path.open(encoding="utf-8") as source:
        payload = json.load(source)
    if not isinstance(payload, list) or len(payload) != 1 or not isinstance(payload[0], dict):
        raise SecretExposureError(f"{label} inspect payload is not one object")
    return payload[0]


def _environment(document: dict[str, object], label: str) -> dict[str, str]:
    config = document.get("Config")
    if not isinstance(config, dict):
        raise SecretExposureError(f"{label} inspect payload has no Config object")
    entries = config.get("Env") or []
    if not isinstance(entries, list) or not all(isinstance(entry, str) for entry in entries):
        raise SecretExposureError(f"{label} Config.Env is not a string array")

    environment: dict[str, str] = {}
    for entry in entries:
        name, separator, value = entry.partition("=")
        if not separator or not name:
            raise SecretExposureError(f"{label} Config.Env contains a malformed entry")
        if name in environment:
            raise SecretExposureError(f"{label} Config.Env repeats {name}")
        environment[name] = value
    return environment


def _assert_secret_environment(
    service: str,
    document: dict[str, object],
    label: str,
    *,
    require_expected: bool,
) -> None:
    environment = _environment(document, label)
    forbidden_names = PLAINTEXT_SECRET_ENV_NAMES | HOST_SECRET_PATH_ENV_NAMES
    exposed_names = sorted(forbidden_names & environment.keys())
    if exposed_names:
        raise SecretExposureError(
            f"{label} Config.Env contains forbidden variable {exposed_names[0]}"
        )

    expected = EXPECTED_SECRET_FILE_ENV[service]
    secret_file_names = {
        name
        for name in environment
        if name in KNOWN_SECRET_FILE_ENV_NAMES or name.endswith(SECRET_FILE_ENV_SUFFIXES)
    }
    for name in sorted(secret_file_names):
        if name not in expected:
            raise SecretExposureError(
                f"{label} Config.Env contains unexpected secret file variable {name}"
            )
        if environment[name] != expected[name]:
            raise SecretExposureError(
                f"{label} Config.Env has an invalid path for {name}"
            )

    if require_expected:
        for name, value in expected.items():
            if environment.get(name) != value:
                raise SecretExposureError(
                    f"{label} Config.Env is missing the expected path for {name}"
                )


def _secret_values(secret_directories: list[Path]) -> set[bytes]:
    values: set[bytes] = set()
    for directory in secret_directories:
        if not directory.is_dir():
            raise SecretExposureError("a secret source directory is unavailable")
        for path in sorted(directory.iterdir()):
            if not path.is_file():
                continue
            value = path.read_bytes()
            if value:
                values.add(value)
            without_trailing_newline = value.rstrip(b"\r\n")
            if without_trailing_newline:
                values.add(without_trailing_newline)
    return values


def _text_values(value: object) -> Iterator[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for key, child in value.items():
            yield from _text_values(key)
            yield from _text_values(child)
    elif isinstance(value, list):
        for child in value:
            yield from _text_values(child)


def _assert_no_secret_values(
    document: dict[str, object],
    secret_values: set[bytes],
    label: str,
) -> None:
    for text_value in _text_values(document):
        encoded_value = text_value.encode("utf-8")
        if any(secret in encoded_value for secret in secret_values):
            raise SecretExposureError(f"{label} inspect metadata contains test secret content")


def assert_no_secret_exposure(
    *,
    service: str,
    container_inspect: Path,
    image_inspect: Path,
    secret_directories: list[Path],
) -> None:
    if service not in EXPECTED_SECRET_FILE_ENV:
        raise SecretExposureError(f"unsupported service {service}")

    container_document = _load_inspect_document(container_inspect, f"{service} container")
    image_document = _load_inspect_document(image_inspect, f"{service} image")
    secrets = _secret_values(secret_directories)
    if not secrets:
        raise SecretExposureError("no non-empty test secrets were supplied")

    _assert_secret_environment(
        service,
        container_document,
        f"{service} container",
        require_expected=True,
    )
    _assert_secret_environment(
        service,
        image_document,
        f"{service} image",
        require_expected=False,
    )
    _assert_no_secret_values(container_document, secrets, f"{service} container")
    _assert_no_secret_values(image_document, secrets, f"{service} image")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Fail when Docker inspect metadata exposes test secret material."
    )
    parser.add_argument("--service", choices=sorted(EXPECTED_SECRET_FILE_ENV), required=True)
    parser.add_argument("--container-inspect", type=Path, required=True)
    parser.add_argument("--image-inspect", type=Path, required=True)
    parser.add_argument(
        "--secret-directory",
        action="append",
        type=Path,
        required=True,
        dest="secret_directories",
    )
    return parser


def main() -> int:
    arguments = _parser().parse_args()
    try:
        assert_no_secret_exposure(
            service=arguments.service,
            container_inspect=arguments.container_inspect,
            image_inspect=arguments.image_inspect,
            secret_directories=arguments.secret_directories,
        )
    except (OSError, ValueError, SecretExposureError) as error:
        print(f"secret exposure inspection failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
