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
    return bool(key) and key == _API_KEY


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

def create_jwt(username: str) -> str:
    """Issue a signed JWT for a dashboard user."""
    now = datetime.now(timezone.utc)
    payload = {
        "sub": username,
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
