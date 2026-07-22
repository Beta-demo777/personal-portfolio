import json
import logging
import mimetypes
import os
import re
import tempfile
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import partial
from pathlib import Path
from threading import Lock
from typing import Any, BinaryIO, Iterable, Iterator, Optional
from uuid import uuid4

import anyio
from fastapi import (
    APIRouter,
    Depends,
    File,
    Header,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
    status,
)
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import delete, func, select, text
from sqlalchemy.orm import Session

from app.core.auth import (
    COOKIE_NAME,
    create_session_token,
    require_admin,
    require_admin_enabled,
    verify_password,
)
from app.core.api_errors import (
    MEDIA_REFERENCE_MISSING,
    MEDIA_STILL_REFERENCED,
    REVISION_INCOMPATIBLE,
    api_error_detail,
)
from app.core.config import settings
from app.core.content_payload import (
    ContentPayloadTooLargeError,
    enforce_content_payload_size,
    extract_managed_upload_filenames,
    is_public_post as _is_public_post,
    migrate_legacy_content_payload as _migrate_legacy_content_payload,
    public_content_payload,
    referenced_managed_uploads,
)
from app.core.content_version import content_etag, require_matching_etag
from app.core.login_limiter import (
    LoginAttemptLimiter,
    parse_trusted_proxy_cidrs,
    resolve_client_ip,
)
from app.core.origin import require_same_origin
from app.core.upload_security import InvalidImageError, verify_image_file
from app.db.session import get_db
from app.models.content import ContentRevision, SiteContent
from app.schemas.content import (
    AdminContentResponse,
    ContentPayload,
    InitializedAdminContentResponse,
    UninitializedAdminContentResponse,
)


router = APIRouter(prefix="/api/v1")
logger = logging.getLogger(__name__)

LOGIN_ATTEMPTS = LoginAttemptLimiter(
    max_failures=settings.ADMIN_LOGIN_MAX_FAILURES,
    window_seconds=settings.ADMIN_LOGIN_WINDOW_SECONDS,
    lockout_seconds=settings.ADMIN_LOGIN_LOCKOUT_SECONDS,
    max_clients=settings.ADMIN_LOGIN_MAX_CLIENTS,
)
TRUSTED_PROXY_NETWORKS = parse_trusted_proxy_cidrs(settings.AUTH_TRUSTED_PROXY_CIDRS)

UPLOAD_FILENAME_PATTERN = re.compile(r"^[0-9a-f]{32}\.(?:jpg|png|webp|gif)$")
UPLOAD_CONTENT_TYPES = {
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
}
UPLOAD_CHUNK_BYTES = 1024 * 1024
REVISION_STREAM_BATCH_SIZE = 1
MAX_REVISION_LIST_LIMIT = 30
UPLOAD_PROCESSING_LIMITER = anyio.CapacityLimiter(settings.MAX_CONCURRENT_UPLOADS)
MEDIA_INVENTORY_LIMIT_DETAIL = "Media file inventory limit reached"
REVISION_INVENTORY_LIMIT_DETAIL = "Content revision history exceeds the configured limit"
_MEDIA_INVENTORY_LOCK = Lock()
_PENDING_MEDIA_UPLOADS = 0


@dataclass(frozen=True)
class _StoredUpload:
    filename: str
    content_type: str
    size_bytes: int
    uploaded_at: datetime


@dataclass(frozen=True)
class _UploadDirectorySnapshot:
    media_paths: tuple[Path, ...]
    entry_count: int


@dataclass
class _MediaUploadReservation:
    pending: bool = True


class LoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    password: str = Field(min_length=1, max_length=256)


def _locked_site_content(db: Session) -> Optional[SiteContent]:
    # A row lock cannot protect the initial write because row id=1 does not yet
    # exist. The transaction-scoped advisory lock serializes both initial and
    # subsequent CMS writes without requiring another coordination table.
    db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": 0x504F5254464F4C49})
    return db.execute(
        select(SiteContent).where(SiteContent.id == 1).with_for_update()
    ).scalar_one_or_none()


def _content_etag(content: Optional[SiteContent]) -> str:
    return content_etag(content.payload if content else None)


def _if_none_match_matches(header_value: Optional[str], current_etag: str) -> bool:
    if not header_value:
        return False
    for candidate in header_value.split(","):
        tag = candidate.strip()
        if tag == "*":
            return True
        if tag.startswith("W/"):
            tag = tag[2:].strip()
        if tag == current_etag:
            return True
    return False


def _serialize_content_payload(payload: ContentPayload) -> dict[str, Any]:
    data = payload.model_dump(exclude_none=True)
    try:
        enforce_content_payload_size(data, max_bytes=settings.MAX_CONTENT_BYTES)
    except ContentPayloadTooLargeError:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"Content exceeds the {settings.MAX_CONTENT_BYTES} byte limit",
        ) from None
    return data


def _serialize_revision_payload(payload: Any) -> dict[str, Any]:
    try:
        validated = ContentPayload.model_validate(
            _migrate_legacy_content_payload(payload)
        )
    except ValidationError:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=api_error_detail(
                REVISION_INCOMPATIBLE,
                "This revision does not match the current content schema",
            ),
        ) from None
    return _serialize_content_payload(validated)


def require_admin_writes_enabled() -> None:
    if not settings.ADMIN_WRITES_ENABLED:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Administrator writes are temporarily unavailable",
            headers={"Retry-After": "5"},
        )


def _create_revision(db: Session, payload: dict[str, Any], reason: str) -> ContentRevision:
    revision = ContentRevision(payload=deepcopy(payload), reason=reason)
    db.add(revision)
    db.flush()

    first_stale_revision_id = db.scalar(
        select(ContentRevision.id)
        .order_by(ContentRevision.id.desc())
        .offset(settings.MAX_CONTENT_REVISIONS)
        .limit(1)
    )
    if first_stale_revision_id is not None:
        db.execute(
            delete(ContentRevision)
            .where(ContentRevision.id <= first_stale_revision_id)
            .execution_options(synchronize_session=False)
        )
    return revision


def _content_summary(payload: dict[str, Any]) -> dict[str, int]:
    posts = payload.get("blogPosts", [])
    projects = payload.get("projects", [])
    skill_groups = payload.get("techStackGroups", [])
    return {
        "posts": len(posts) if isinstance(posts, list) else 0,
        "drafts": sum(
            1
            for post in posts
            if isinstance(post, dict) and post.get("status") == "draft"
        )
        if isinstance(posts, list)
        else 0,
        "projects": len(projects) if isinstance(projects, list) else 0,
        "skillGroups": len(skill_groups) if isinstance(skill_groups, list) else 0,
        "sizeBytes": len(json.dumps(payload, ensure_ascii=False).encode("utf-8")),
    }


def _revision_metadata_values(
    revision_id: int,
    reason: str,
    created_at: datetime,
    payload: dict[str, Any],
) -> dict[str, Any]:
    return {
        "id": revision_id,
        "reason": reason,
        "createdAt": created_at,
        "summary": _content_summary(payload),
    }


def _revision_metadata(revision: ContentRevision) -> dict[str, Any]:
    return _revision_metadata_values(
        revision.id,
        revision.reason,
        revision.created_at,
        revision.payload,
    )


def _upload_root() -> Path:
    root = Path(settings.UPLOAD_DIR)
    root.mkdir(parents=True, exist_ok=True)
    return root.resolve()


def _upload_path(filename: str) -> Path:
    if not UPLOAD_FILENAME_PATTERN.fullmatch(filename):
        raise HTTPException(status_code=400, detail="Invalid media filename")
    root = _upload_root()
    target = (root / filename).resolve()
    if target.parent != root:
        raise HTTPException(status_code=400, detail="Invalid media filename")
    return target


def _scan_upload_directory(
    upload_root: Path,
    *,
    max_files: int,
) -> _UploadDirectorySnapshot:
    media_paths: list[Path] = []
    entry_count = 0

    with os.scandir(upload_root) as entries:
        for entry in entries:
            entry_count += 1
            if entry_count > max_files:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=MEDIA_INVENTORY_LIMIT_DETAIL,
                )
            if entry.name.startswith(".upload-") and entry.name.endswith(".tmp"):
                continue
            if not UPLOAD_FILENAME_PATTERN.fullmatch(entry.name):
                continue
            if entry.is_file(follow_symlinks=False):
                media_paths.append(Path(entry.path))

    return _UploadDirectorySnapshot(
        media_paths=tuple(media_paths),
        entry_count=entry_count,
    )


@contextmanager
def _reserve_media_upload_slot(
    upload_root: Path,
    *,
    max_files: int,
) -> Iterator[_MediaUploadReservation]:
    global _PENDING_MEDIA_UPLOADS

    reservation = _MediaUploadReservation()
    with _MEDIA_INVENTORY_LOCK:
        snapshot = _scan_upload_directory(upload_root, max_files=max_files)
        if snapshot.entry_count + _PENDING_MEDIA_UPLOADS >= max_files:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=MEDIA_INVENTORY_LIMIT_DETAIL,
            )
        _PENDING_MEDIA_UPLOADS += 1

    try:
        yield reservation
    finally:
        with _MEDIA_INVENTORY_LOCK:
            if reservation.pending:
                reservation.pending = False
                _PENDING_MEDIA_UPLOADS -= 1


def _materialize_media_upload(
    upload_dir: Path,
    reservation: _MediaUploadReservation,
) -> tuple[BinaryIO, Path]:
    global _PENDING_MEDIA_UPLOADS

    with _MEDIA_INVENTORY_LOCK:
        if not reservation.pending:
            raise RuntimeError("Media upload reservation is no longer pending")
        output = tempfile.NamedTemporaryFile(
            mode="wb",
            dir=upload_dir,
            prefix=".upload-",
            suffix=".tmp",
            delete=False,
        )
        temporary_path = Path(output.name)
        reservation.pending = False
        _PENDING_MEDIA_UPLOADS -= 1
    return output, temporary_path


def _store_uploaded_image(
    source: BinaryIO,
    *,
    max_bytes: int,
    max_files: int,
    max_pixels: int,
    max_dimension: int,
    max_frames: int,
    max_total_pixels: int,
) -> _StoredUpload:
    """Persist and verify one upload entirely outside the event loop."""
    upload_dir = _upload_root()
    written = 0
    temporary_path: Optional[Path] = None
    published_path: Optional[Path] = None
    completed = False

    with _reserve_media_upload_slot(
        upload_dir,
        max_files=max_files,
    ) as reservation:
        try:
            output, temporary_path = _materialize_media_upload(
                upload_dir,
                reservation,
            )
            with output:
                while chunk := source.read(UPLOAD_CHUNK_BYTES):
                    written += len(chunk)
                    if written > max_bytes:
                        raise HTTPException(
                            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                            detail=f"Image exceeds {max_bytes // (1024 * 1024)} MB",
                        )
                    output.write(chunk)
                output.flush()
                os.fsync(output.fileno())

            try:
                verified = verify_image_file(
                    temporary_path,
                    max_pixels=max_pixels,
                    max_dimension=max_dimension,
                    max_frames=max_frames,
                    max_total_pixels=max_total_pixels,
                )
            except InvalidImageError as error:
                raise HTTPException(status_code=400, detail=str(error)) from error

            filename = f"{uuid4().hex}{verified.extension}"
            target_path = upload_dir / filename
            os.replace(temporary_path, target_path)
            temporary_path = None
            published_path = target_path

            metadata = published_path.stat()
            stored_upload = _StoredUpload(
                filename=filename,
                content_type=verified.content_type,
                size_bytes=metadata.st_size,
                uploaded_at=datetime.fromtimestamp(metadata.st_mtime, tz=timezone.utc),
            )
            completed = True
            return stored_upload
        finally:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)
            if published_path is not None and not completed:
                published_path.unlink(missing_ok=True)


def _index_media_references(
    value: Any,
    index: dict[str, list[str]],
    path: str = "$",
    tracked_filenames: set[str] | None = None,
) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            _index_media_references(
                child,
                index,
                f"{path}.{key}",
                tracked_filenames,
            )
    elif isinstance(value, list):
        for item_index, child in enumerate(value):
            _index_media_references(
                child,
                index,
                f"{path}[{item_index}]",
                tracked_filenames,
            )
    elif isinstance(value, str):
        for filename in extract_managed_upload_filenames(value):
            if tracked_filenames is not None and filename not in tracked_filenames:
                continue
            index.setdefault(filename, []).append(path)


def _build_media_reference_index(
    content_payload: dict[str, Any],
    revision_payloads: Iterable[tuple[int, dict[str, Any]]],
    *,
    tracked_filenames: set[str] | None = None,
) -> dict[str, list[str]]:
    index: dict[str, list[str]] = {}
    _index_media_references(
        content_payload,
        index,
        tracked_filenames=tracked_filenames,
    )
    for revision_id, payload in revision_payloads:
        _index_media_references(
            payload,
            index,
            f"revision[{revision_id}]",
            tracked_filenames,
        )
    return index


def _validate_managed_media_references(payload: dict[str, Any]) -> None:
    references = sorted(referenced_managed_uploads(payload))
    if not references:
        return

    try:
        upload_root = _upload_root()
    except OSError:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=api_error_detail(
                MEDIA_REFERENCE_MISSING,
                "Content references unavailable managed media",
                details={"filenames": references},
            ),
        ) from None
    missing: list[str] = []
    for filename in references:
        target = upload_root / filename
        try:
            available = target.is_file() and not target.is_symlink()
        except OSError:
            available = False
        if not available:
            missing.append(filename)

    if missing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=api_error_detail(
                MEDIA_REFERENCE_MISSING,
                "Content references unavailable managed media",
                details={"filenames": missing},
            ),
        )


def _iter_bounded_revision_payloads(
    db: Session,
) -> Iterator[tuple[int, dict[str, Any]]]:
    result = db.execute(
        select(ContentRevision.id, ContentRevision.payload)
        .order_by(ContentRevision.id.desc())
        .limit(settings.MAX_CONTENT_REVISIONS + 1)
        .execution_options(yield_per=REVISION_STREAM_BATCH_SIZE)
    )
    try:
        for row_index, (revision_id, payload) in enumerate(result):
            if row_index >= settings.MAX_CONTENT_REVISIONS:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=REVISION_INVENTORY_LIMIT_DETAIL,
                )
            yield revision_id, payload
    finally:
        result.close()


def _media_metadata(
    path: Path,
    reference_index: dict[str, list[str]],
) -> dict[str, Any]:
    stat = path.stat()
    references = reference_index.get(path.name, [])
    return {
        "filename": path.name,
        "url": f"/backend/uploads/{path.name}",
        "contentType": UPLOAD_CONTENT_TYPES.get(path.suffix.lower())
        or mimetypes.guess_type(path.name)[0]
        or "application/octet-stream",
        "sizeBytes": stat.st_size,
        "uploadedAt": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc),
        "referenced": bool(references),
        "references": references,
    }


@router.get("/content")
def read_public_content(
    response: Response,
    if_none_match: Optional[str] = Header(default=None, alias="If-None-Match"),
    db: Session = Depends(get_db),
):
    content = db.get(SiteContent, 1)
    public_payload = public_content_payload(content.payload if content else {})

    etag = content_etag(public_payload)
    cache_control = "public, max-age=0, must-revalidate"
    response.headers["ETag"] = etag
    response.headers["Cache-Control"] = cache_control
    if _if_none_match_matches(if_none_match, etag):
        return Response(
            status_code=status.HTTP_304_NOT_MODIFIED,
            headers={"ETag": etag, "Cache-Control": cache_control},
        )
    return public_payload


@router.get("/admin/status")
def admin_status(_admin=Depends(require_admin)):
    return {"authenticated": True}


@router.post("/admin/login", dependencies=[Depends(require_same_origin)])
def admin_login(payload: LoginRequest, request: Request, response: Response):
    require_admin_enabled()
    peer_host = request.client.host if request.client else None
    client_ip = resolve_client_ip(
        peer_host,
        request.headers.get("x-real-ip"),
        TRUSTED_PROXY_NETWORKS,
    )
    retry_after = LOGIN_ATTEMPTS.retry_after(client_ip)
    if retry_after is not None:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many login attempts. Try again later.",
            headers={"Retry-After": str(retry_after)},
        )

    if not verify_password(payload.password):
        failure = LOGIN_ATTEMPTS.record_failure(client_ip)
        if failure.retry_after is not None:
            if failure.newly_locked:
                logger.warning("admin_login_lockout client_ip=%s", client_ip)
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many login attempts. Try again later.",
                headers={"Retry-After": str(failure.retry_after)},
            )
        logger.info("admin_login_failed client_ip=%s", client_ip)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid password")

    LOGIN_ATTEMPTS.clear(client_ip)
    response.set_cookie(
        key=COOKIE_NAME,
        value=create_session_token(),
        httponly=True,
        secure=settings.AUTH_COOKIE_SECURE,
        samesite="strict",
        max_age=settings.AUTH_SESSION_HOURS * 3600,
        path=settings.AUTH_COOKIE_PATH,
    )
    return {"authenticated": True}


@router.post("/admin/logout", dependencies=[Depends(require_same_origin)])
def admin_logout(response: Response):
    response.delete_cookie(
        COOKIE_NAME,
        path=settings.AUTH_COOKIE_PATH,
        secure=settings.AUTH_COOKIE_SECURE,
        httponly=True,
        samesite="strict",
    )
    return {"authenticated": False}


@router.get(
    "/admin/content",
    response_model=AdminContentResponse,
    response_model_exclude_unset=True,
)
def read_admin_content(
    response: Response,
    _admin=Depends(require_admin),
    db: Session = Depends(get_db),
):
    content = db.get(SiteContent, 1)
    response.headers["ETag"] = _content_etag(content)
    if not content:
        return UninitializedAdminContentResponse(
            initialized=False,
            content=None,
        )
    return InitializedAdminContentResponse(
        initialized=True,
        content=ContentPayload.model_validate(
            _migrate_legacy_content_payload(content.payload)
        ),
    )


@router.put(
    "/admin/content",
    dependencies=[Depends(require_same_origin), Depends(require_admin_writes_enabled)],
)
def update_admin_content(
    payload: ContentPayload,
    response: Response,
    if_match: Optional[str] = Header(default=None, alias="If-Match"),
    _admin=Depends(require_admin),
    db: Session = Depends(get_db),
):
    content = _locked_site_content(db)
    require_matching_etag(if_match, _content_etag(content))
    data = _serialize_content_payload(payload)
    _validate_managed_media_references(data)
    if content:
        _create_revision(db, content.payload, reason="content_update")
        content.payload = data
    else:
        content = SiteContent(id=1, payload=data)
        db.add(content)
    db.commit()
    db.refresh(content)
    response.headers["ETag"] = _content_etag(content)
    return {"saved": True}


@router.get("/admin/revisions")
def list_content_revisions(
    limit: int = Query(default=20, ge=1, le=MAX_REVISION_LIST_LIMIT),
    offset: int = Query(default=0, ge=0),
    _admin=Depends(require_admin),
    db: Session = Depends(get_db),
):
    result = db.execute(
        select(
            ContentRevision.id,
            ContentRevision.reason,
            ContentRevision.created_at,
            ContentRevision.payload,
        )
        .order_by(ContentRevision.id.desc())
        .offset(offset)
        .limit(limit)
        .execution_options(yield_per=REVISION_STREAM_BATCH_SIZE)
    )
    try:
        items = [
            _revision_metadata_values(revision_id, reason, created_at, payload)
            for revision_id, reason, created_at, payload in result
        ]
    finally:
        result.close()
    total = db.scalar(select(func.count(ContentRevision.id))) or 0
    return {
        "items": items,
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@router.get("/admin/revisions/{revision_id}")
def read_content_revision(
    revision_id: int,
    _admin=Depends(require_admin),
    db: Session = Depends(get_db),
):
    revision = db.get(ContentRevision, revision_id)
    if not revision:
        raise HTTPException(status_code=404, detail="Content revision not found")
    payload = _serialize_revision_payload(revision.payload)
    return {
        **_revision_metadata(revision),
        "payload": payload,
    }


@router.post(
    "/admin/revisions/{revision_id}/restore",
    dependencies=[Depends(require_same_origin), Depends(require_admin_writes_enabled)],
)
def restore_content_revision(
    revision_id: int,
    response: Response,
    if_match: Optional[str] = Header(default=None, alias="If-Match"),
    _admin=Depends(require_admin),
    db: Session = Depends(get_db),
):
    revision = db.get(ContentRevision, revision_id)
    if not revision:
        raise HTTPException(status_code=404, detail="Content revision not found")
    restored_payload = _serialize_revision_payload(revision.payload)

    content = _locked_site_content(db)
    require_matching_etag(if_match, _content_etag(content))
    _validate_managed_media_references(restored_payload)
    if content:
        _create_revision(db, content.payload, reason="before_restore")
        content.payload = restored_payload
    else:
        content = SiteContent(id=1, payload=restored_payload)
        db.add(content)
    db.commit()
    db.refresh(content)
    response.headers["ETag"] = _content_etag(content)
    return {
        "saved": True,
        "restoredRevisionId": revision_id,
        "content": content.payload,
    }


@router.get("/admin/media")
def list_uploaded_media(
    _admin=Depends(require_admin),
    db: Session = Depends(get_db),
):
    content = db.get(SiteContent, 1)
    payload = content.payload if content else {}
    upload_root = _upload_root()
    snapshot = _scan_upload_directory(
        upload_root,
        max_files=settings.MAX_MEDIA_FILES,
    )
    tracked_filenames = {path.name for path in snapshot.media_paths}
    revision_payloads = _iter_bounded_revision_payloads(db)
    try:
        reference_index = _build_media_reference_index(
            payload,
            revision_payloads,
            tracked_filenames=tracked_filenames,
        )
    finally:
        revision_payloads.close()
    media = [
        _media_metadata(path, reference_index)
        for path in snapshot.media_paths
    ]
    media.sort(
        key=lambda item: (item["uploadedAt"], item["filename"]),
        reverse=True,
    )
    return {"items": media, "total": len(media)}


@router.delete(
    "/admin/media/{filename}",
    dependencies=[Depends(require_same_origin), Depends(require_admin_writes_enabled)],
)
def delete_uploaded_media(
    filename: str,
    _admin=Depends(require_admin),
    db: Session = Depends(get_db),
):
    target = _upload_path(filename)
    content = _locked_site_content(db)
    if not target.exists() or not target.is_file() or target.is_symlink():
        raise HTTPException(status_code=404, detail="Media file not found")

    revision_payloads = _iter_bounded_revision_payloads(db)
    try:
        reference_index = _build_media_reference_index(
            content.payload if content else {},
            revision_payloads,
            tracked_filenames={filename},
        )
    finally:
        revision_payloads.close()
    references = reference_index.get(filename, [])
    if references:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=api_error_detail(
                MEDIA_STILL_REFERENCED,
                "Media file is still referenced by site content",
                details={"references": references},
            ),
        )

    target.unlink()
    return {"deleted": True, "filename": filename}


@router.post(
    "/admin/uploads",
    dependencies=[Depends(require_same_origin), Depends(require_admin_writes_enabled)],
)
async def upload_image(
    image: UploadFile = File(...),
    _admin=Depends(require_admin),
):
    max_bytes = settings.MAX_UPLOAD_MB * 1024 * 1024
    try:
        stored = await anyio.to_thread.run_sync(
            partial(
                _store_uploaded_image,
                image.file,
                max_bytes=max_bytes,
                max_files=settings.MAX_MEDIA_FILES,
                max_pixels=settings.MAX_IMAGE_PIXELS,
                max_dimension=settings.MAX_IMAGE_DIMENSION,
                max_frames=settings.MAX_IMAGE_FRAMES,
                max_total_pixels=settings.MAX_IMAGE_TOTAL_PIXELS,
            ),
            abandon_on_cancel=False,
            limiter=UPLOAD_PROCESSING_LIMITER,
        )
    finally:
        await image.close()

    return {
        "url": f"/backend/uploads/{stored.filename}",
        "filename": stored.filename,
        "contentType": stored.content_type,
        "sizeBytes": stored.size_bytes,
        "uploadedAt": stored.uploaded_at,
    }
