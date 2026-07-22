from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import tarfile


UPLOAD_ROOT = Path("/app/uploads")
UPLOAD_FILENAME = re.compile(r"^[0-9a-f]{32}\.(?:jpg|png|webp|gif)$")
GIF_1X1 = (
    b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00"
    b"\xff\xff\xff!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00"
    b"\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;"
)
SEMANTIC_SECRET_MARKER = "semantic-private-content-must-not-leak"


def _text_fields(*names: str) -> dict[str, str]:
    return dict.fromkeys(names, "")


def content_payload(variant: str) -> dict:
    if variant == "malformed":
        return {"privateMarker": SEMANTIC_SECRET_MARKER}

    post = {
        "id": "legacy-post",
        "title": "Recovery post",
        "slug": "legacy-post",
        "excerpt": "Recovery excerpt",
        "content": "# Recovery",
        "date": "2026-07-17",
        "readTime": "1 min",
        "category": "Testing",
        "tags": [],
        "views": 0,
        "likes": 0,
        "status": "published",
    }
    if variant == "legacy":
        del post["status"]

    return {
        "personalInfo": {
            **_text_fields("name", "title", "location", "email", "github", "twitter"),
            "bio": f"recovery-{variant}",
            "experience": [],
        },
        "techStackGroups": [],
        "projects": [],
        "blogPosts": [post],
        "siteSettings": {
            **_text_fields(
                "siteTitle",
                "siteDescription",
                "brandInitials",
                "footerCopyright",
                "icpNumber",
                "icpUrl",
            ),
            "navigation": [],
            "footerBadges": [],
        },
        "homePage": {
            **_text_fields(
                "heroPrefix",
                "heroHighlight",
                "heroSuffix",
                "introduction",
                "portfolioButton",
                "agentButton",
                "blogButton",
            ),
            "greetings": [],
            "highlights": [],
        },
        "showcasePage": {
            **_text_fields(
                "identityLabel",
                "terminalWelcome",
                "terminalHint",
                "terminalTitle",
                "terminalPlaceholder",
                "technologyTitle",
                "worksEyebrow",
                "worksTitle",
                "terminalPrompt",
                "quickLabel",
                "allFilterLabel",
                "commandNotFound",
                "detailsLabel",
                "repositoryLabel",
                "livePreviewLabel",
                "impactLabel",
                "starsLabel",
                "forksLabel",
            ),
            "terminalHelp": [],
        },
        "blogPage": _text_fields(
            "eyebrow",
            "title",
            "description",
            "searchPlaceholder",
            "noResultsText",
            "backLabel",
            "relatedTitle",
            "allCategoryLabel",
            "readsLabel",
            "likeLabel",
            "linkCopiedLabel",
        ),
        "aboutPage": {
            **_text_fields(
                "eyebrow",
                "title",
                "description",
                "introductionTitle",
                "experienceTitle",
                "hobbiesTitle",
                "technologyTitle",
                "contactEyebrow",
                "contactTitle",
                "contactDescription",
                "contactNamePlaceholder",
                "contactMessagePlaceholder",
                "contactSendingLabel",
                "contactSuccessLabel",
                "contactSubmitLabel",
            ),
            "introduction": [],
            "hobbies": [],
        },
        "agentPage": {
            **_text_fields(
                "title",
                "description",
                "welcomeMessage",
                "initialBubble",
                "loadingBubble",
                "answeredBubble",
                "resetBubble",
                "inputPlaceholder",
                "displayName",
                "badgeLabel",
                "modelLabel",
                "idleStatus",
                "loadingStatus",
                "interactionHint",
                "suggestionsTitle",
                "resetLabel",
            ),
            "samplePrompts": [],
            "funQuotes": [],
        },
        "musicPlayer": {
            **_text_fields("title", "minimizedLabel", "standbyLabel", "playingPrefix"),
            "tracks": [],
        },
    }


def clear_uploads() -> None:
    UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)
    for entry in UPLOAD_ROOT.iterdir():
        if entry.is_dir() and not entry.is_symlink():
            shutil.rmtree(entry)
        else:
            entry.unlink()


def write_fixture(variant: str) -> None:
    clear_uploads()
    if variant == "large-backup":
        # 24 x 3 MiB creates a 72 MiB media set while each file remains below
        # the application's normal 8 MiB upload limit.
        for index in range(24):
            target = UPLOAD_ROOT / f"{index:032x}.gif"
            target.write_bytes(GIF_1X1)
            with target.open("r+b") as output:
                output.truncate(3 * 1024 * 1024)
    elif variant == "mutated":
        (UPLOAD_ROOT / ("a" * 32 + ".gif")).write_bytes(GIF_1X1 + b"mutated")
    elif variant == "failure-current":
        (UPLOAD_ROOT / ("b" * 32 + ".gif")).write_bytes(GIF_1X1 + b"must-survive")
    else:
        raise ValueError(f"unknown fixture variant: {variant}")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def snapshot() -> None:
    entries: dict[str, dict[str, str | int]] = {}
    for path in sorted(UPLOAD_ROOT.iterdir(), key=lambda item: item.name):
        if not UPLOAD_FILENAME.fullmatch(path.name) or not path.is_file() or path.is_symlink():
            raise ValueError(f"unexpected uploads entry: {path.name!r}")
        entries[path.name] = {"bytes": path.stat().st_size, "sha256": sha256_file(path)}
    print(json.dumps(entries, sort_keys=True, separators=(",", ":")))


def corrupt_backup_media(backup_directory: Path, private_key: Path) -> None:
    archive_path = backup_directory / "uploads.tar"
    payload = b"forged image content"
    with tarfile.open(archive_path, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        member = tarfile.TarInfo("f" * 32 + ".png")
        member.size = len(payload)
        member.mtime = 1_700_000_000
        archive.addfile(member, io.BytesIO(payload))

    manifest_path = backup_directory / "manifest.txt"
    manifest_lines = manifest_path.read_text(encoding="ascii").splitlines()
    replacements = 0
    for index, line in enumerate(manifest_lines):
        if line.startswith("uploads_bytes="):
            manifest_lines[index] = f"uploads_bytes={archive_path.stat().st_size}"
            replacements += 1
    if replacements != 1:
        raise ValueError("backup manifest must contain exactly one uploads_bytes field")
    manifest_path.write_text("\n".join((*manifest_lines, "")), encoding="ascii")

    checksums = []
    for filename in ("database.dump", "uploads.tar", "manifest.txt"):
        checksums.append(f"{sha256_file(backup_directory / filename)}  {filename}\n")
    (backup_directory / "SHA256SUMS").write_text("".join(checksums), encoding="ascii")
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    import backup_signature

    (backup_directory / "SHA256SUMS.sig").write_bytes(
        backup_signature.sign(backup_directory / "SHA256SUMS", private_key)
    )


def print_content_payload(variant: str) -> None:
    print(json.dumps(content_payload(variant), sort_keys=True, separators=(",", ":")))


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    write = subparsers.add_parser("write")
    write.add_argument("variant", choices=("large-backup", "mutated", "failure-current"))
    subparsers.add_parser("snapshot")
    content = subparsers.add_parser("content")
    content.add_argument(
        "variant",
        choices=(
            "current",
            "legacy",
            "malformed",
            "after_media_stage",
            "after_media_activate",
            "after_live_database_rename",
            "after_database_restore",
            "after_backend_validation",
        ),
    )
    corrupt_media = subparsers.add_parser("corrupt-backup-media")
    corrupt_media.add_argument("backup_directory", type=Path)
    corrupt_media.add_argument("--private-key", type=Path, required=True)
    arguments = parser.parse_args()
    if arguments.command == "write":
        write_fixture(arguments.variant)
    elif arguments.command == "snapshot":
        snapshot()
    elif arguments.command == "content":
        print_content_payload(arguments.variant)
    else:
        corrupt_backup_media(arguments.backup_directory, arguments.private_key)


if __name__ == "__main__":
    main()
