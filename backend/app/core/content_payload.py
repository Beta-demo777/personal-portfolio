import json
import re
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any

from app.schemas.content import parse_scheduled_at


_MANAGED_UPLOAD_REFERENCE_PATTERN = re.compile(
    r"(?:^|(?<=[\s('\"<]))"
    r"(?:/backend)?/uploads/"
    r"(?P<filename>[0-9a-f]{32}\.(?:jpg|png|webp|gif))"
    r"(?=$|[?#)\]\s'\"])"
)


class ContentPayloadTooLargeError(ValueError):
    pass


def extract_managed_upload_filenames(text: str) -> tuple[str, ...]:
    """Return canonical filenames from site-relative managed upload URLs."""
    return tuple(
        dict.fromkeys(
            match.group("filename")
            for match in _MANAGED_UPLOAD_REFERENCE_PATTERN.finditer(text)
        )
    )


def referenced_managed_uploads(value: Any) -> set[str]:
    references: set[str] = set()
    if isinstance(value, dict):
        for child in value.values():
            references.update(referenced_managed_uploads(child))
    elif isinstance(value, list):
        for child in value:
            references.update(referenced_managed_uploads(child))
    elif isinstance(value, str):
        references.update(extract_managed_upload_filenames(value))
    return references


def enforce_content_payload_size(payload: Any, *, max_bytes: int) -> int:
    size_bytes = len(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    )
    if size_bytes > max_bytes:
        raise ContentPayloadTooLargeError
    return size_bytes


def migrate_legacy_content_payload(payload: Any) -> Any:
    migrated = deepcopy(payload)
    if not isinstance(migrated, dict):
        return migrated

    posts = migrated.get("blogPosts")
    if not isinstance(posts, list):
        return migrated
    for post in posts:
        if isinstance(post, dict) and "status" not in post:
            post["status"] = "published"
    return migrated


def is_public_post(post: Any, now: datetime) -> bool:
    if not isinstance(post, dict) or post.get("status") != "published":
        return False

    scheduled_at = post.get("scheduledAt")
    if scheduled_at is None:
        return True
    if not isinstance(scheduled_at, str):
        return False
    if not scheduled_at.strip():
        return True

    try:
        return parse_scheduled_at(scheduled_at) <= now
    except ValueError:
        # Malformed scheduling metadata must never publish content early.
        return False


def public_content_payload(
    payload: dict[str, Any], *, now: datetime | None = None
) -> dict[str, Any]:
    public_payload = dict(payload)
    if not public_payload:
        return public_payload

    current_time = now or datetime.now(timezone.utc)
    public_payload["blogPosts"] = [
        post
        for post in public_payload.get("blogPosts", [])
        if is_public_post(post, current_time)
    ]
    return public_payload
