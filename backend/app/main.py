from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime, timezone
import json
import logging
from pathlib import Path
import re
import secrets
import time

from fastapi import FastAPI, HTTPException, Request, Response, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.exc import SQLAlchemyError

from app.api.content import router as content_router
from app.core.config import settings
from app.core.response_security import apply_admin_response_headers, is_admin_api_path
from app.db.session import check_database_readiness


REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$")
request_logger = logging.getLogger("uvicorn.error.portfolio.request")


def _request_id(request: Request) -> str:
    existing = getattr(request.state, "request_id", None)
    if isinstance(existing, str) and REQUEST_ID_PATTERN.fullmatch(existing):
        return existing
    candidate = request.headers.get("x-request-id", "")
    request_id = (
        candidate if REQUEST_ID_PATTERN.fullmatch(candidate) else secrets.token_hex(16)
    )
    request.state.request_id = request_id
    return request_id


def _log_request_event(event: str, request: Request, **fields: object) -> None:
    payload = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "service": "portfolio-backend",
        "request_id": _request_id(request),
        "method": request.method,
        "route": request.url.path,
        "event": event,
        **fields,
    }
    request_logger.info("%s", json.dumps(payload, separators=(",", ":")))


async def request_context(request: Request, call_next):
    request_id = _request_id(request)
    started_at = time.perf_counter()
    response = await call_next(request)
    response.headers["X-Request-ID"] = request_id
    _log_request_event(
        "http_request",
        request,
        status=response.status_code,
        duration_ms=round((time.perf_counter() - started_at) * 1000, 3),
    )
    return response


async def secure_admin_responses(request: Request, call_next):
    response = await call_next(request)
    if is_admin_api_path(request.url.path):
        apply_admin_response_headers(response)
    return response


async def sanitized_request_validation_error(
    request: Request,
    error: RequestValidationError,
) -> JSONResponse:
    detail = []
    for item in error.errors():
        error_type = str(item.get("type", "validation_error"))
        location = list(item.get("loc", ()))
        if error_type == "extra_forbidden" and location:
            location[-1] = "<unexpected-field>"
        detail.append(
            {
                "type": error_type,
                "loc": location,
                "msg": str(item.get("msg", "Invalid request value")),
            }
        )
    response = JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        content={"detail": detail},
    )
    response.headers["X-Request-ID"] = _request_id(request)
    if is_admin_api_path(request.url.path):
        apply_admin_response_headers(response)
    return response


async def sanitized_internal_server_error(
    request: Request,
    error: Exception,
) -> JSONResponse:
    _log_request_event(
        "unhandled_exception",
        request,
        status=status.HTTP_500_INTERNAL_SERVER_ERROR,
        error_type=type(error).__name__,
    )
    response = JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"detail": "Internal server error"},
    )
    response.headers["X-Request-ID"] = _request_id(request)
    if is_admin_api_path(request.url.path):
        apply_admin_response_headers(response)
    return response


def root():
    return {"status": "ok", "service": "portfolio-cms-api"}


def health_live(response: Response):
    response.headers["Cache-Control"] = "no-store"
    return {"status": "ok"}


def health_ready(response: Response):
    response.headers["Cache-Control"] = "no-store"
    try:
        check_database_readiness()
    except SQLAlchemyError as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database is not ready",
            headers={"Cache-Control": "no-store"},
        ) from error
    return {"status": "ready"}


def create_app() -> FastAPI:
    upload_directory = Path(settings.UPLOAD_DIR)

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        upload_directory.mkdir(parents=True, exist_ok=True)
        if not getattr(application.state, "uploads_mounted", False):
            application.mount(
                "/uploads",
                StaticFiles(directory=upload_directory),
                name="uploads",
            )
            application.state.uploads_mounted = True
        yield

    docs_url = "/docs" if settings.API_DOCS_ENABLED else None
    allowed_hosts = [
        host.strip() for host in settings.ALLOWED_HOSTS.split(",") if host.strip()
    ]
    application = FastAPI(
        title="Portfolio CMS API",
        version="1.1.0",
        docs_url=docs_url,
        redoc_url="/redoc" if settings.API_DOCS_ENABLED else None,
        openapi_url="/openapi.json" if settings.API_DOCS_ENABLED else None,
        lifespan=lifespan,
    )
    application.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts)
    application.middleware("http")(secure_admin_responses)
    application.middleware("http")(request_context)
    application.add_exception_handler(
        RequestValidationError,
        sanitized_request_validation_error,
    )
    application.add_exception_handler(Exception, sanitized_internal_server_error)
    application.include_router(content_router)
    application.add_api_route("/", root, methods=["GET"])
    application.add_api_route(
        "/health/live",
        health_live,
        methods=["GET"],
        include_in_schema=False,
    )
    application.add_api_route(
        "/health/ready",
        health_ready,
        methods=["GET"],
        include_in_schema=False,
    )
    return application


app = create_app()
