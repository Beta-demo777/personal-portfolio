#!/usr/bin/env python3
"""Create and verify independently keyed portfolio backup signatures."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
from typing import Iterator, NoReturn, Sequence


SIGNATURE_FORMAT_VERSION = "1"
SIGNATURE_ALGORITHM = "rsa-pss-sha256-mgf1-sha256-saltlen32"
SIGNATURE_DOMAIN = b"personal-portfolio-backup-signature-v1\0"
KEY_ID_PREFIX = "spki-sha256:"
KEY_ID_LENGTH = len(KEY_ID_PREFIX) + 64
MIN_RSA_BITS = 3072
MAX_KEY_BYTES = 64 * 1024
MAX_CHECKSUM_BYTES = 4 * 1024
MAX_SIGNATURE_BYTES = 4 * 1024


class SignatureError(RuntimeError):
    """Base class for a backup-signature failure."""


class SignatureConfigurationError(SignatureError):
    """The independently configured key material is unsafe or unsupported."""


class UntrustedSignatureError(SignatureError):
    """No independently configured public key matches the manifest key id."""


class InvalidSignatureError(SignatureError):
    """The backup signature is missing, malformed, or cryptographically invalid."""


def _directory_flags() -> int:
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    directory = getattr(os, "O_DIRECTORY", 0)
    if not nofollow or not directory:
        raise SignatureConfigurationError(
            "this platform does not support secure no-follow key opening"
        )
    return os.O_RDONLY | nofollow | directory | getattr(os, "O_CLOEXEC", 0)


def _file_flags() -> int:
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    if not nofollow:
        raise SignatureConfigurationError(
            "this platform does not support secure no-follow file opening"
        )
    return (
        os.O_RDONLY
        | nofollow
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NONBLOCK", 0)
    )


def _absolute_normalized_path(path: Path, description: str) -> Path:
    supplied = os.fspath(path)
    if not os.path.isabs(supplied):
        raise SignatureConfigurationError(f"{description} path must be absolute")
    normalized = os.path.normpath(supplied)
    if normalized != supplied.rstrip(os.sep) and not (
        supplied == os.sep and normalized == os.sep
    ):
        raise SignatureConfigurationError(
            f"{description} path must not contain redundant or parent components"
        )
    # Resolve only ancestor aliases (for example macOS /var -> /private/var).
    # The final component remains subject to O_NOFOLLOW below.
    parent = os.path.realpath(os.path.dirname(normalized))
    return Path(parent) / os.path.basename(normalized)


def _path_is_within(path: Path, root: Path) -> bool:
    try:
        return os.path.commonpath((os.fspath(path), os.fspath(root))) == os.fspath(root)
    except ValueError:
        return False


def _validate_external_path(
    path: Path, forbidden_roots: Sequence[Path], description: str
) -> Path:
    normalized = _absolute_normalized_path(path, description)
    for root in forbidden_roots:
        normalized_root = Path(os.path.realpath(os.path.abspath(os.fspath(root))))
        if _path_is_within(normalized, normalized_root):
            raise SignatureConfigurationError(
                f"{description} must be stored outside {normalized_root}"
            )
    return normalized


@contextmanager
def _open_path_without_symlinks(path: Path, description: str) -> Iterator[int]:
    normalized = _absolute_normalized_path(path, description)
    parts = normalized.parts
    directory = os.open(os.sep, _directory_flags())
    descriptor = -1
    try:
        for component in parts[1:-1]:
            next_directory = os.open(component, _directory_flags(), dir_fd=directory)
            metadata = os.fstat(next_directory)
            if not stat.S_ISDIR(metadata.st_mode):
                os.close(next_directory)
                raise SignatureConfigurationError(
                    f"{description} path contains a non-directory component"
                )
            os.close(directory)
            directory = next_directory
        descriptor = os.open(parts[-1], _file_flags(), dir_fd=directory)
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise SignatureConfigurationError(f"{description} must be a regular file")
        if metadata.st_nlink != 1:
            raise SignatureConfigurationError(
                f"{description} must have exactly one hard link"
            )
        yield descriptor
    except OSError as error:
        raise SignatureConfigurationError(
            f"{description} could not be opened safely"
        ) from error
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        os.close(directory)


def _validate_key_metadata(
    descriptor: int, *, private: bool, description: str
) -> None:
    metadata = os.fstat(descriptor)
    if metadata.st_uid != os.geteuid():
        raise SignatureConfigurationError(
            f"{description} must be owned by the current user"
        )
    mode = stat.S_IMODE(metadata.st_mode)
    allowed_modes = (0o600,) if private else (0o600, 0o644)
    if mode not in allowed_modes:
        rendered = "0600" if private else "0600 or 0644"
        raise SignatureConfigurationError(
            f"{description} permissions must be {rendered}"
        )
    if not 0 < metadata.st_size <= MAX_KEY_BYTES:
        raise SignatureConfigurationError(f"{description} has an invalid size")


def _openssl(
    arguments: Sequence[str],
    *,
    pass_fds: Sequence[int] = (),
    input_bytes: bytes | None = None,
) -> subprocess.CompletedProcess[bytes]:
    executable = shutil.which("openssl")
    if executable is None:
        raise SignatureConfigurationError("openssl is required")
    try:
        return subprocess.run(
            (executable, *arguments),
            input=input_bytes,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            pass_fds=tuple(pass_fds),
            env={**os.environ, "LC_ALL": "C"},
        )
    except OSError as error:
        raise SignatureConfigurationError("openssl could not be executed") from error


def _spki_der_from_descriptor(
    descriptor: int, *, private: bool, description: str
) -> bytes:
    arguments = ["pkey"]
    if not private:
        arguments.append("-pubin")
    else:
        arguments.extend(("-passin", "pass:"))
    arguments.extend(
        (
            "-in",
            f"/dev/fd/{descriptor}",
            "-pubout",
            "-outform",
            "DER",
        )
    )
    os.lseek(descriptor, 0, os.SEEK_SET)
    result = _openssl(arguments, pass_fds=(descriptor,))
    os.lseek(descriptor, 0, os.SEEK_SET)
    if result.returncode != 0 or not result.stdout:
        raise SignatureConfigurationError(
            f"{description} is not a readable unencrypted RSA private key"
            if private
            else f"{description} is not a readable RSA public key"
        )
    return result.stdout


def _rsa_bits(spki_der: bytes, description: str) -> int:
    result = _openssl(
        ("pkey", "-pubin", "-inform", "DER", "-text_pub", "-noout"),
        input_bytes=spki_der,
    )
    text = result.stdout.decode("ascii", errors="replace")
    match = re.search(r"(?:Public-Key|RSA Public-Key): \((\d+) bit\)", text)
    if result.returncode != 0 or match is None or "Modulus:" not in text or "Exponent:" not in text:
        raise SignatureConfigurationError(
            f"{description} must be an RSA key of at least {MIN_RSA_BITS} bits"
        )
    bits = int(match.group(1))
    if bits < MIN_RSA_BITS or bits % 8:
        raise SignatureConfigurationError(
            f"{description} must be an RSA key of at least {MIN_RSA_BITS} bits"
        )
    return bits


def key_id(
    path: Path,
    *,
    private: bool,
    forbidden_roots: Sequence[Path] = (),
) -> str:
    description = "backup private key" if private else "backup public key"
    normalized = _validate_external_path(path, forbidden_roots, description)
    with _open_path_without_symlinks(normalized, description) as descriptor:
        _validate_key_metadata(descriptor, private=private, description=description)
        spki_der = _spki_der_from_descriptor(
            descriptor, private=private, description=description
        )
    _rsa_bits(spki_der, description)
    return KEY_ID_PREFIX + hashlib.sha256(spki_der).hexdigest()


def validate_key_pair(
    private_key: Path,
    public_key: Path,
    *,
    forbidden_roots: Sequence[Path] = (),
) -> str:
    private_id = key_id(
        private_key, private=True, forbidden_roots=forbidden_roots
    )
    public_id = key_id(public_key, private=False, forbidden_roots=forbidden_roots)
    if private_id != public_id:
        raise SignatureConfigurationError(
            "backup private and public keys do not form a matching pair"
        )
    challenge = SIGNATURE_DOMAIN + b"configuration-preflight"
    signature = _sign_message(
        challenge, private_key, forbidden_roots=forbidden_roots
    )
    _verify_message(
        challenge,
        signature,
        public_key,
        private_id,
        forbidden_roots=forbidden_roots,
        invalid_error=SignatureConfigurationError,
    )
    return private_id


def _read_regular_file(
    path: Path,
    *,
    description: str,
    max_bytes: int,
    invalid_signature: bool,
) -> bytes:
    try:
        with _open_path_without_symlinks(path, description) as descriptor:
            metadata = os.fstat(descriptor)
            if not 0 < metadata.st_size <= max_bytes:
                raise SignatureConfigurationError(f"{description} has an invalid size")
            stream = os.fdopen(os.dup(descriptor), "rb")
            with stream:
                contents = stream.read(max_bytes + 1)
            if len(contents) > max_bytes:
                raise SignatureConfigurationError(f"{description} is too large")
            return contents
    except SignatureConfigurationError as error:
        if invalid_signature:
            raise InvalidSignatureError(str(error)) from error
        raise


def _signature_message(checksums_path: Path) -> bytes:
    checksums = _read_regular_file(
        checksums_path,
        description="SHA256SUMS",
        max_bytes=MAX_CHECKSUM_BYTES,
        invalid_signature=True,
    )
    return SIGNATURE_DOMAIN + checksums


def _sign_message(
    message: bytes,
    private_key: Path,
    *,
    forbidden_roots: Sequence[Path] = (),
) -> bytes:
    normalized = _validate_external_path(
        private_key, forbidden_roots, "backup private key"
    )
    with _open_path_without_symlinks(normalized, "backup private key") as descriptor:
        _validate_key_metadata(
            descriptor, private=True, description="backup private key"
        )
        spki_der = _spki_der_from_descriptor(
            descriptor, private=True, description="backup private key"
        )
        bits = _rsa_bits(spki_der, "backup private key")
        os.lseek(descriptor, 0, os.SEEK_SET)
        result = _openssl(
            (
                "pkeyutl",
                "-sign",
                "-rawin",
                "-digest",
                "sha256",
                "-pkeyopt",
                "rsa_padding_mode:pss",
                "-pkeyopt",
                "rsa_pss_saltlen:32",
                "-pkeyopt",
                "rsa_mgf1_md:sha256",
                "-inkey",
                f"/dev/fd/{descriptor}",
                "-passin",
                "pass:",
            ),
            pass_fds=(descriptor,),
            input_bytes=message,
        )
    if result.returncode != 0 or len(result.stdout) != bits // 8:
        raise SignatureConfigurationError("backup signature could not be created")
    return result.stdout


def sign(
    checksums_path: Path,
    private_key: Path,
    *,
    forbidden_roots: Sequence[Path] = (),
) -> bytes:
    return _sign_message(
        _signature_message(checksums_path),
        private_key,
        forbidden_roots=forbidden_roots,
    )


def _validate_expected_key_id(expected_key_id: str) -> None:
    if (
        len(expected_key_id) != KEY_ID_LENGTH
        or not expected_key_id.startswith(KEY_ID_PREFIX)
        or any(character not in "0123456789abcdef" for character in expected_key_id[len(KEY_ID_PREFIX) :])
    ):
        raise InvalidSignatureError("manifest signature_key_id is invalid")


def select_public_key(
    public_keys: Sequence[Path],
    expected_key_id: str,
    *,
    forbidden_roots: Sequence[Path] = (),
) -> Path:
    _validate_expected_key_id(expected_key_id)
    if not public_keys:
        raise SignatureConfigurationError(
            "at least one independent backup public key is required"
        )
    keyring: dict[str, Path] = {}
    for path in public_keys:
        identifier = key_id(path, private=False, forbidden_roots=forbidden_roots)
        if identifier in keyring:
            raise SignatureConfigurationError(
                f"duplicate backup public key id configured: {identifier}"
            )
        keyring[identifier] = path
    try:
        return keyring[expected_key_id]
    except KeyError as error:
        raise UntrustedSignatureError(
            f"no configured backup public key matches {expected_key_id}"
        ) from error


def _verify_message(
    message: bytes,
    signature: bytes,
    selected: Path,
    expected_key_id: str,
    *,
    forbidden_roots: Sequence[Path] = (),
    invalid_error: type[SignatureError] = InvalidSignatureError,
) -> None:
    normalized = _validate_external_path(
        selected, forbidden_roots, "backup public key"
    )
    with _open_path_without_symlinks(normalized, "backup public key") as descriptor:
        _validate_key_metadata(
            descriptor, private=False, description="backup public key"
        )
        spki_der = _spki_der_from_descriptor(
            descriptor, private=False, description="backup public key"
        )
        bits = _rsa_bits(spki_der, "backup public key")
        current_id = KEY_ID_PREFIX + hashlib.sha256(spki_der).hexdigest()
        if current_id != expected_key_id:
            raise SignatureConfigurationError(
                "selected backup public key changed during verification"
            )
        if len(signature) != bits // 8:
            raise invalid_error("SHA256SUMS.sig has an invalid size")
        # pkeyutl consumes the signed message on stdin, so expose the signature
        # through an inherited anonymous pipe instead of a named temporary file.
        read_descriptor, write_descriptor = os.pipe()
        try:
            os.write(write_descriptor, signature)
        finally:
            os.close(write_descriptor)
        try:
            os.lseek(descriptor, 0, os.SEEK_SET)
            result = _openssl(
                (
                    "pkeyutl",
                    "-verify",
                    "-rawin",
                    "-digest",
                    "sha256",
                    "-pkeyopt",
                    "rsa_padding_mode:pss",
                    "-pkeyopt",
                    "rsa_pss_saltlen:32",
                    "-pkeyopt",
                    "rsa_mgf1_md:sha256",
                    "-pubin",
                    "-inkey",
                    f"/dev/fd/{descriptor}",
                    "-sigfile",
                    f"/dev/fd/{read_descriptor}",
                ),
                pass_fds=(descriptor, read_descriptor),
                input_bytes=message,
            )
        finally:
            os.close(read_descriptor)
    if result.returncode != 0:
        raise invalid_error("backup signature verification failed")


def verify(
    checksums_path: Path,
    signature_path: Path,
    public_keys: Sequence[Path],
    expected_key_id: str,
    *,
    forbidden_roots: Sequence[Path] = (),
) -> None:
    selected = select_public_key(
        public_keys, expected_key_id, forbidden_roots=forbidden_roots
    )
    signature = _read_regular_file(
        signature_path,
        description="SHA256SUMS.sig",
        max_bytes=MAX_SIGNATURE_BYTES,
        invalid_signature=True,
    )
    _verify_message(
        _signature_message(checksums_path),
        signature,
        selected,
        expected_key_id,
        forbidden_roots=forbidden_roots,
    )


def _forbidden_roots(arguments: argparse.Namespace) -> tuple[Path, ...]:
    return tuple(arguments.forbid_root or ())


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    key = subparsers.add_parser("key-id")
    key.add_argument("--key", type=Path, required=True)
    key.add_argument("--private", action="store_true")
    key.add_argument("--forbid-root", type=Path, action="append")

    pair = subparsers.add_parser("validate-pair")
    pair.add_argument("--private-key", type=Path, required=True)
    pair.add_argument("--public-key", type=Path, required=True)
    pair.add_argument("--forbid-root", type=Path, action="append")

    signer = subparsers.add_parser("sign")
    signer.add_argument("--checksums", type=Path, required=True)
    signer.add_argument("--private-key", type=Path, required=True)
    signer.add_argument("--forbid-root", type=Path, action="append")

    verifier = subparsers.add_parser("verify")
    verifier.add_argument("--checksums", type=Path, required=True)
    verifier.add_argument("--signature", type=Path, required=True)
    verifier.add_argument("--public-key", type=Path, action="append", required=True)
    verifier.add_argument("--expected-key-id", required=True)
    verifier.add_argument("--forbid-root", type=Path, action="append")
    return parser


def _die(message: str) -> NoReturn:
    print(f"backup-signature: {message}", file=sys.stderr)
    raise SystemExit(1)


def main(argv: list[str] | None = None) -> int:
    arguments = _parser().parse_args(argv)
    try:
        if arguments.command == "key-id":
            print(
                key_id(
                    arguments.key,
                    private=arguments.private,
                    forbidden_roots=_forbidden_roots(arguments),
                )
            )
        elif arguments.command == "validate-pair":
            print(
                validate_key_pair(
                    arguments.private_key,
                    arguments.public_key,
                    forbidden_roots=_forbidden_roots(arguments),
                )
            )
        elif arguments.command == "sign":
            sys.stdout.buffer.write(
                sign(
                    arguments.checksums,
                    arguments.private_key,
                    forbidden_roots=_forbidden_roots(arguments),
                )
            )
        else:
            verify(
                arguments.checksums,
                arguments.signature,
                arguments.public_key,
                arguments.expected_key_id,
                forbidden_roots=_forbidden_roots(arguments),
            )
    except SignatureError as error:
        _die(str(error))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
