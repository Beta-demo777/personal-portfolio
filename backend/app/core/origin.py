import ipaddress
import re
from dataclasses import dataclass
from typing import Optional, Sequence
from urllib.parse import urlsplit

from fastapi import HTTPException, Request, status

from app.core.login_limiter import IPNetwork, parse_trusted_proxy_cidrs


@dataclass(frozen=True)
class ParsedOrigin:
    scheme: str
    host: str
    port: int


def parse_origin(value: str) -> ParsedOrigin:
    if not value or any(character.isspace() or ord(character) < 32 for character in value):
        raise ValueError("origin is empty or contains invalid characters")
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("origin scheme must be http or https")
    if not parsed.hostname or parsed.username is not None or parsed.password is not None:
        raise ValueError("origin host is invalid")
    if parsed.path or parsed.query or parsed.fragment:
        raise ValueError("origin must contain only scheme, host, and port")
    try:
        port = parsed.port
    except ValueError as error:
        raise ValueError("origin port is invalid") from error
    if parsed.netloc.endswith(":") or (port is not None and port < 1):
        raise ValueError("origin port is invalid")

    host = parsed.hostname.rstrip(".").lower()
    if not host:
        raise ValueError("origin host is invalid")
    try:
        host = ipaddress.ip_address(host).compressed
    except ValueError:
        try:
            host = host.encode("idna").decode("ascii")
        except UnicodeError as error:
            raise ValueError("origin host is invalid") from error
        hostname_label = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
        if any(not hostname_label.fullmatch(label) for label in host.split(".")):
            raise ValueError("origin host is invalid")

    return ParsedOrigin(
        scheme=parsed.scheme,
        host=host,
        port=port if port is not None else (443 if parsed.scheme == "https" else 80),
    )


def parse_configured_origins(public_origin: Optional[str], trusted_origins: str) -> set[ParsedOrigin]:
    values = []
    if public_origin and public_origin.strip():
        values.append(public_origin.strip())
    values.extend(value.strip() for value in trusted_origins.split(",") if value.strip())
    return {parse_origin(value) for value in values}


def _peer_is_trusted(peer_host: Optional[str], trusted_proxies: Sequence[IPNetwork]) -> bool:
    if not peer_host:
        return False
    try:
        address = ipaddress.ip_address(peer_host)
    except ValueError:
        return False
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        address = address.ipv4_mapped
    return any(address.version == network.version and address in network for network in trusted_proxies)


def request_target_origin(
    request: Request,
    trusted_proxies: Sequence[IPNetwork] = (),
) -> ParsedOrigin:
    scheme = request.url.scheme.lower()
    peer_host = request.client.host if request.client else None
    forwarded_proto = request.headers.get("x-forwarded-proto")
    if forwarded_proto and _peer_is_trusted(peer_host, trusted_proxies):
        if forwarded_proto not in {"http", "https"}:
            raise ValueError("forwarded protocol is invalid")
        scheme = forwarded_proto
    if scheme not in {"http", "https"}:
        raise ValueError("request scheme is invalid")

    host = request.headers.get("host")
    if not host:
        raise ValueError("Host header is required")
    return parse_origin(f"{scheme}://{host}")


def validate_same_origin_request(
    request: Request,
    *,
    public_origin: Optional[str] = None,
    trusted_origins: str = "",
    trusted_proxies: Sequence[IPNetwork] = (),
) -> None:
    allowed = parse_configured_origins(public_origin, trusted_origins)
    allowed.add(request_target_origin(request, trusted_proxies))

    origin_header = request.headers.get("origin")
    if origin_header is not None:
        try:
            supplied_origin = parse_origin(origin_header)
        except ValueError as error:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Request Origin header is invalid",
            ) from error
        if supplied_origin not in allowed:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Cross-origin admin request rejected",
            )
        return

    fetch_site = request.headers.get("sec-fetch-site")
    if fetch_site == "same-origin":
        return
    if fetch_site in {"cross-site", "same-site"}:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Cross-origin admin request rejected",
        )

    referer = request.headers.get("referer")
    if referer:
        try:
            parsed_referer = urlsplit(referer)
            referer_origin = parse_origin(
                f"{parsed_referer.scheme}://{parsed_referer.netloc}"
            )
        except ValueError as error:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Request Referer header is invalid",
            ) from error
        if referer_origin in allowed:
            return

    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Admin writes require a same-origin Origin, Sec-Fetch-Site, or Referer header",
    )


def require_same_origin(request: Request) -> None:
    from app.core.config import settings

    try:
        trusted_proxies = parse_trusted_proxy_cidrs(settings.AUTH_TRUSTED_PROXY_CIDRS)
        validate_same_origin_request(
            request,
            public_origin=settings.PUBLIC_ORIGIN,
            trusted_origins=settings.CSRF_TRUSTED_ORIGINS,
            trusted_proxies=trusted_proxies,
        )
    except HTTPException:
        raise
    except ValueError as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Admin origin protection is misconfigured",
        ) from error
