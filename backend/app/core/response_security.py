from starlette.responses import Response


ADMIN_API_PREFIX = "/api/v1/admin"


def is_admin_api_path(path: str) -> bool:
    return path == ADMIN_API_PREFIX or path.startswith(f"{ADMIN_API_PREFIX}/")


def apply_admin_response_headers(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"
    vary_values = {
        value.strip().casefold(): value.strip()
        for value in response.headers.get("Vary", "").split(",")
        if value.strip()
    }
    vary_values.setdefault("cookie", "Cookie")
    response.headers["Vary"] = ", ".join(vary_values.values())
