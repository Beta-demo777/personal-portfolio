from typing import Any, NotRequired, TypedDict


CONTENT_VERSION_CONFLICT = "CONTENT_VERSION_CONFLICT"
MEDIA_REFERENCE_MISSING = "MEDIA_REFERENCE_MISSING"
MEDIA_STILL_REFERENCED = "MEDIA_STILL_REFERENCED"
REVISION_INCOMPATIBLE = "REVISION_INCOMPATIBLE"


class ApiErrorDetail(TypedDict):
    code: str
    message: str
    details: NotRequired[dict[str, Any]]


def api_error_detail(
    code: str,
    message: str,
    *,
    details: dict[str, Any] | None = None,
) -> ApiErrorDetail:
    detail: ApiErrorDetail = {"code": code, "message": message}
    if details is not None:
        detail["details"] = details
    return detail
