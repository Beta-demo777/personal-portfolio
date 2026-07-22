from __future__ import annotations

import argparse
import json
import re
import stat
import sys
from collections.abc import Iterator, Sequence
from pathlib import Path
from typing import Any

from sqlalchemy import Text, cast, func, select
from sqlalchemy.orm import Session

from app.core.content_payload import (
    ContentPayloadTooLargeError,
    enforce_content_payload_size,
    migrate_legacy_content_payload,
    public_content_payload,
    referenced_managed_uploads,
)
from app.core.config import settings
from app.core.upload_security import InvalidImageError, verify_image_file
from app.db.session import SessionLocal
from app.models.content import ContentRevision, SiteContent
from app.schemas.content import ContentPayload


UPLOAD_FILENAME_PATTERN = re.compile(r"^[0-9a-f]{32}\.(?:jpg|png|webp|gif)$")
RESTORE_STREAM_BATCH_SIZE = 1
STORED_JSON_SIZE_MULTIPLIER = 4


class RestoredContentInvalidError(RuntimeError):
    """A sanitized restore rejection that is safe to print in operator logs."""


def _validate_payload(payload: Any, *, label: str) -> dict[str, Any]:
    try:
        # Reject known-oversized documents before legacy migration deep-copies them.
        enforce_content_payload_size(
            payload,
            max_bytes=settings.MAX_CONTENT_BYTES,
        )
        migrated_payload = migrate_legacy_content_payload(payload)
        enforce_content_payload_size(
            migrated_payload,
            max_bytes=settings.MAX_CONTENT_BYTES,
        )
        validated_payload = ContentPayload.model_validate(migrated_payload)
        validated_payload.model_dump_json(exclude_none=True)
        return migrated_payload
    except ContentPayloadTooLargeError:
        raise RestoredContentInvalidError(
            f"{label} exceeds the configured content size limit"
        ) from None
    except Exception:
        raise RestoredContentInvalidError(
            f"{label} does not match the current application contract"
        ) from None


def _validate_site_payload(payload: Any) -> dict[str, Any]:
    migrated_payload = _validate_payload(payload, label="site content")
    try:
        # Exercise the same transformation used by the public endpoint against
        # the stored document, then verify its result remains a valid contract.
        public_payload = public_content_payload(payload)
        ContentPayload.model_validate(public_payload)
    except Exception:
        raise RestoredContentInvalidError(
            "site content does not match the current application contract"
        ) from None
    return migrated_payload


def validate_site_content_rows(rows: Sequence[tuple[int, Any]]) -> list[dict[str, Any]]:
    if len(rows) > 1 or (rows and rows[0][0] != 1):
        raise RestoredContentInvalidError("site content singleton invariant failed")
    if not rows:
        return []

    return [_validate_site_payload(rows[0][1])]


def validate_revision_rows(
    rows: Sequence[tuple[int, Any]],
    *,
    max_revisions: int,
) -> list[dict[str, Any]]:
    if len(rows) > max_revisions:
        raise RestoredContentInvalidError("content revision count exceeds the configured limit")

    payloads: list[dict[str, Any]] = []
    seen_ids: set[int] = set()
    for revision_id, payload in rows:
        if revision_id < 1 or revision_id in seen_ids:
            raise RestoredContentInvalidError("content revision identity invariant failed")
        seen_ids.add(revision_id)
        payloads.append(_validate_payload(payload, label="content revision"))
    return payloads


def _validated_staged_upload_names(uploads_root: Path) -> set[str]:
    try:
        root_metadata = uploads_root.lstat()
        if not stat.S_ISDIR(root_metadata.st_mode) or uploads_root.is_symlink():
            raise RestoredContentInvalidError("staged uploaded media set is invalid")

        available: set[str] = set()
        for entry in uploads_root.iterdir():
            metadata = entry.lstat()
            if (
                not UPLOAD_FILENAME_PATTERN.fullmatch(entry.name)
                or not stat.S_ISREG(metadata.st_mode)
                or entry.is_symlink()
            ):
                raise RestoredContentInvalidError("staged uploaded media set is invalid")
            if metadata.st_size > settings.MAX_UPLOAD_MB * 1024 * 1024:
                raise RestoredContentInvalidError("staged uploaded media set is invalid")
            try:
                verified = verify_image_file(
                    entry,
                    max_pixels=settings.MAX_IMAGE_PIXELS,
                    max_dimension=settings.MAX_IMAGE_DIMENSION,
                    max_frames=settings.MAX_IMAGE_FRAMES,
                    max_total_pixels=settings.MAX_IMAGE_TOTAL_PIXELS,
                )
            except InvalidImageError:
                raise RestoredContentInvalidError(
                    "staged uploaded media set is invalid"
                ) from None
            if entry.suffix != verified.extension:
                raise RestoredContentInvalidError("staged uploaded media set is invalid")
            available.add(entry.name)
    except RestoredContentInvalidError:
        raise
    except OSError:
        raise RestoredContentInvalidError("staged uploaded media set is invalid") from None
    return available


def _validate_payload_media_references(
    payload: dict[str, Any],
    available: set[str],
) -> None:
    if not referenced_managed_uploads(payload).issubset(available):
        raise RestoredContentInvalidError(
            "staged uploaded media is missing a referenced content file"
        )


def validate_staged_uploads(
    uploads_root: Path,
    payloads: Sequence[dict[str, Any]],
) -> None:
    available = _validated_staged_upload_names(uploads_root)
    for payload in payloads:
        _validate_payload_media_references(payload, available)


def _stored_json_size_limit() -> int:
    # SQLAlchemy's PostgreSQL JSON serializer may represent Unicode as
    # surrogate escapes and retain insignificant whitespace. The exact compact
    # application limit is enforced after decoding; this is a transport guard.
    return settings.MAX_CONTENT_BYTES * STORED_JSON_SIZE_MULTIPLIER


def _stored_json_size(payload_column):
    return func.octet_length(cast(payload_column, Text))


def _validate_database_payload_boundaries(session: Session) -> tuple[int, int]:
    stored_size_limit = _stored_json_size_limit()
    site_result = session.execute(
        select(SiteContent.id, _stored_json_size(SiteContent.payload))
        .order_by(SiteContent.id)
        .limit(2)
    )
    try:
        site_metadata = site_result.all()
    finally:
        site_result.close()
    if len(site_metadata) > 1 or (site_metadata and site_metadata[0][0] != 1):
        raise RestoredContentInvalidError("site content singleton invariant failed")
    if site_metadata and site_metadata[0][1] > stored_size_limit:
        raise RestoredContentInvalidError(
            "site content exceeds the restore storage size limit"
        )

    revision_result = session.execute(
        select(
            func.count(ContentRevision.id),
            func.max(_stored_json_size(ContentRevision.payload)),
        )
    )
    try:
        revision_count, largest_revision = revision_result.one()
    finally:
        revision_result.close()
    revision_count = int(revision_count or 0)
    if revision_count > settings.MAX_CONTENT_REVISIONS:
        raise RestoredContentInvalidError(
            "content revision count exceeds the configured limit"
        )
    if largest_revision is not None and largest_revision > stored_size_limit:
        raise RestoredContentInvalidError(
            "content revision exceeds the restore storage size limit"
        )
    return len(site_metadata), revision_count


def _stream_stored_payloads(
    session: Session,
    id_column,
    payload_column,
    *,
    max_rows: int,
) -> Iterator[tuple[int, str]]:
    stored_size_limit = _stored_json_size_limit()
    result = session.execute(
        select(id_column, cast(payload_column, Text))
        .where(_stored_json_size(payload_column) <= stored_size_limit)
        .order_by(id_column)
        .limit(max_rows + 1)
        .execution_options(yield_per=RESTORE_STREAM_BATCH_SIZE)
    )
    try:
        for row_index, (row_id, serialized_payload) in enumerate(result):
            if row_index >= max_rows:
                raise RestoredContentInvalidError(
                    "restored content changed while it was being validated"
                )
            yield row_id, serialized_payload
    finally:
        result.close()


def _decode_stored_payload(serialized_payload: str, *, label: str) -> Any:
    try:
        if not isinstance(serialized_payload, str):
            raise TypeError
        return json.loads(serialized_payload)
    except Exception:
        raise RestoredContentInvalidError(
            f"{label} does not match the current application contract"
        ) from None


def validate_restored_content(session: Session, uploads_root: Path) -> None:
    expected_site_rows, expected_revision_rows = _validate_database_payload_boundaries(
        session
    )
    available = _validated_staged_upload_names(uploads_root)

    site_rows_seen = 0
    for site_id, serialized_payload in _stream_stored_payloads(
        session,
        SiteContent.id,
        SiteContent.payload,
        max_rows=1,
    ):
        site_rows_seen += 1
        if site_id != 1:
            raise RestoredContentInvalidError("site content singleton invariant failed")
        payload = _validate_site_payload(
            _decode_stored_payload(serialized_payload, label="site content")
        )
        _validate_payload_media_references(payload, available)
    if site_rows_seen != expected_site_rows:
        raise RestoredContentInvalidError(
            "restored content changed while it was being validated"
        )

    revision_rows_seen = 0
    seen_revision_ids: set[int] = set()
    for revision_id, serialized_payload in _stream_stored_payloads(
        session,
        ContentRevision.id,
        ContentRevision.payload,
        max_rows=settings.MAX_CONTENT_REVISIONS,
    ):
        revision_rows_seen += 1
        if revision_id < 1 or revision_id in seen_revision_ids:
            raise RestoredContentInvalidError(
                "content revision identity invariant failed"
            )
        seen_revision_ids.add(revision_id)
        payload = _validate_payload(
            _decode_stored_payload(serialized_payload, label="content revision"),
            label="content revision",
        )
        _validate_payload_media_references(payload, available)
    if revision_rows_seen != expected_revision_rows:
        raise RestoredContentInvalidError(
            "restored content changed while it was being validated"
        )


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--uploads-root", required=True, type=Path)
    arguments = parser.parse_args(argv)
    try:
        with SessionLocal() as session:
            validate_restored_content(session, arguments.uploads_root)
    except RestoredContentInvalidError as error:
        print(f"restore preflight: {error}", file=sys.stderr)
        return 1
    except Exception:
        # Database and driver exceptions can include bound values. Keep restore
        # output content-free while still failing closed.
        print("restore preflight: staged content validation could not complete", file=sys.stderr)
        return 1
    print("restore preflight: staged content contract is valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
