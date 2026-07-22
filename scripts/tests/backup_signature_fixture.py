from __future__ import annotations

from pathlib import Path
import stat
import subprocess


SCRIPTS_DIR = Path(__file__).resolve().parents[1]


def generate_rsa_key_pair(directory: Path, name: str, *, bits: int = 3072) -> tuple[Path, Path]:
    private_key = directory / f"{name}-private.pem"
    public_key = directory / f"{name}-public.pem"
    subprocess.run(
        (
            "openssl",
            "genpkey",
            "-algorithm",
            "RSA",
            "-pkeyopt",
            f"rsa_keygen_bits:{bits}",
            "-out",
            str(private_key),
        ),
        check=True,
        capture_output=True,
    )
    private_key.chmod(0o600)
    subprocess.run(
        (
            "openssl",
            "pkey",
            "-in",
            str(private_key),
            "-pubout",
            "-out",
            str(public_key),
        ),
        check=True,
        capture_output=True,
    )
    public_key.chmod(0o644)
    return private_key, public_key


def sign_checksums(backup: Path, private_key: Path) -> None:
    from scripts import backup_signature

    signature = backup_signature.sign(backup / "SHA256SUMS", private_key)
    signature_path = backup / "SHA256SUMS.sig"
    signature_path.write_bytes(signature)
    signature_path.chmod(0o600)


def assert_key_permissions(private_key: Path, public_key: Path) -> None:
    assert stat.S_IMODE(private_key.stat().st_mode) == 0o600
    assert stat.S_IMODE(public_key.stat().st_mode) == 0o644
