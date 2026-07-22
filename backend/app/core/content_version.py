import hashlib
import json
from typing import Any, Optional

from fastapi import HTTPException, status

from app.core.api_errors import CONTENT_VERSION_CONFLICT, api_error_detail


EMPTY_CONTENT_ETAG = '"0"'


def content_etag(payload: Optional[dict[str, Any]]) -> str:
    if payload is None:
        return EMPTY_CONTENT_ETAG
    canonical_payload = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    digest = hashlib.sha256(canonical_payload).hexdigest()
    return f'"sha256-{digest}"'


def require_matching_etag(if_match: Optional[str], current_etag: str) -> None:
    if if_match is None:
        raise HTTPException(
            status_code=status.HTTP_428_PRECONDITION_REQUIRED,
            detail="If-Match is required. Reload content before publishing.",
        )
    if if_match.strip() != current_etag:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=api_error_detail(
                CONTENT_VERSION_CONFLICT,
                "Content changed in another session. Reload before publishing.",
            ),
        )
