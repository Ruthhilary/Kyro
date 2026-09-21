"""
Kyro — Auth Dependencies

Two-layer auth strategy:
1. API Key (X-API-Key header or ?api_key= query param) — simple, for machine clients and workers.
2. JWT Bearer token — for dashboard users (issued by /api/v1/auth/token).

FastAPI dependency inject pattern:
    @router.get("/...", dependencies=[Depends(require_api_key)])
    or
    @router.get("/...", dependencies=[Depends(require_jwt)])
"""

from __future__ import annotations

import hmac
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import Depends, HTTPException, Security, status
from fastapi.security import APIKeyHeader, APIKeyQuery, HTTPAuthorizationCredentials, HTTPBearer

import jwt

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Config — read from env, never hardcoded
# ---------------------------------------------------------------------------
_API_KEY: str = os.environ.get("KYRO_API_KEY", "kyro-dev-key-change-in-production")
_JWT_SECRET: str = os.environ.get("KYRO_JWT_SECRET", "kyro-jwt-secret-change-in-production")
_JWT_ALGORITHM = "HS256"
_JWT_EXPIRY_HOURS = int(os.environ.get("KYRO_JWT_EXPIRY_HOURS", "24"))

# ---------------------------------------------------------------------------
# API Key schemes
# ---------------------------------------------------------------------------
_api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)
_api_key_query  = APIKeyQuery(name="api_key", auto_error=False)
_bearer_scheme  = HTTPBearer(auto_error=False)


def validate_api_key_value(key: str) -> bool:
    """Pure function — safe to call outside FastAPI dependency injection."""
    return bool(key) and hmac.compare_digest(key, _API_KEY)


async def require_api_key(
    header_key: Optional[str] = Security(_api_key_header),
    query_key:  Optional[str] = Security(_api_key_query),
) -> str:
    """
    FastAPI dependency: validates X-API-Key header or ?api_key= query param.
    Use on any route that should be machine-protected.
    """
    key = header_key or query_key
    if not validate_api_key_value(key or ""):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing API key",
            headers={"WWW-Authenticate": "ApiKey"},
        )
    return key  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# JWT
# ---------------------------------------------------------------------------

def create_jwt(username: str, role: str = "operator") -> str:
    """Issue a signed JWT for a dashboard user."""
    now = datetime.now(timezone.utc)
    payload = {
        "sub": username,
        "role": role,
        "iat": now,
        "exp": now + timedelta(hours=_JWT_EXPIRY_HOURS),
    }
    return jwt.encode(payload, _JWT_SECRET, algorithm=_JWT_ALGORITHM)


def decode_jwt(token: str) -> dict:
    """Decode and verify a JWT. Raises HTTPException on failure."""
    try:
        return jwt.decode(token, _JWT_SECRET, algorithms=[_JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")


async def require_jwt(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer_scheme),
) -> dict:
    """
    FastAPI dependency: validates Bearer JWT token.
    Use on dashboard-facing routes.
    """
    if not credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Bearer token required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return decode_jwt(credentials.credentials)


async def require_jwt_header_or_query(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer_scheme),
    token: Optional[str] = None,
) -> dict:
    """
    Like require_jwt, but also accepts the token as a `?token=` query param.

    Scoped to routes an <img>/<video> tag needs to hit directly (e.g. the
    MJPEG stream endpoint) — browsers cannot attach an Authorization header
    to a plain element src, only to fetch()/XHR requests. Query-param tokens
    can leak via browser history, proxy/access logs, and the Referer header,
    so this is intentionally NOT used on the general JWT dependency — only
    where a header truly can't be sent.
    """
    if credentials:
        return decode_jwt(credentials.credentials)
    if token:
        return decode_jwt(token)
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Bearer token required",
        headers={"WWW-Authenticate": "Bearer"},
    )


async def require_admin_or_operator(claims: dict = Depends(require_jwt)) -> dict:
    """
    Restricts a route to admin and operator roles only.
    Viewers (ushers) get 403.
    """
    if claims.get("role", "viewer") not in ("admin", "operator"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access restricted — admin or operator role required",
        )
    return claims


async def require_jwt_or_api_key(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer_scheme),
    header_key:  Optional[str] = Security(_api_key_header),
    query_key:   Optional[str] = Security(_api_key_query),
) -> dict:
    """
    Accepts EITHER a dashboard JWT bearer token OR a machine API key.

    Used on read routes that both the dashboard (JWT) and the AI worker
    (X-API-Key) need to call — e.g. camera info, zones, rota, reserved seats,
    spatial memory. Returns the JWT claims when a token is used, or a
    synthetic worker identity when the API key is used.
    """
    # Prefer a valid API key (worker path)
    key = header_key or query_key
    if key and validate_api_key_value(key):
        return {"sub": "worker", "role": "worker"}

    # Otherwise fall back to JWT (dashboard path)
    if credentials:
        return decode_jwt(credentials.credentials)

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Bearer token or API key required",
        headers={"WWW-Authenticate": "Bearer"},
    )
