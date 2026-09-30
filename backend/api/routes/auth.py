"""
Kyro — Auth Routes

POST /api/v1/auth/token   — Exchange username + password for a JWT
GET  /api/v1/auth/me      — Verify token and return user info

Authentication priority:
1. Check DB users table (supports multiple users with roles)
2. Fall back to KYRO_DASHBOARD_USER / KYRO_DASHBOARD_PASS env vars (legacy)
"""

from __future__ import annotations

import hmac
import os
import time
from collections import deque
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy import select

from backend.auth.dependencies import create_jwt, require_jwt
from backend.auth.passwords import verify_password
from backend.database.connection import get_db
from backend.database.models import User
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/api/v1/auth", tags=["Auth"])

_DASHBOARD_USER = os.environ.get("KYRO_DASHBOARD_USER", "admin")
_DASHBOARD_PASS = os.environ.get("KYRO_DASHBOARD_PASS", "kyro-admin-change-me")

# ─── Rate limiter (per-IP sliding window) ────────────────────────────────────
# Deliberately in-memory + dependency-free. For a multi-worker deployment,
# swap for a Redis-backed limiter (e.g. slowapi with a Redis store) so the
# window is shared across workers.
_RATE_WINDOW_S   = int(os.environ.get("KYRO_LOGIN_RATE_WINDOW_S", "60"))
_RATE_MAX_HITS   = int(os.environ.get("KYRO_LOGIN_RATE_MAX_HITS", "10"))
_login_hits: dict[str, deque[float]] = {}

def _rate_limit(request: Request) -> None:
    """Raise 429 if the client IP has made too many login attempts recently."""
    ip = (request.client.host if request.client else None) or "unknown"
    now = time.monotonic()
    hits = _login_hits.setdefault(ip, deque(maxlen=_RATE_MAX_HITS + 1))
    # Drop stale hits outside the window
    while hits and now - hits[0] > _RATE_WINDOW_S:
        hits.popleft()
    if len(hits) >= _RATE_MAX_HITS:
        retry_after = int(_RATE_WINDOW_S - (now - hits[0])) + 1
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            f"Too many login attempts. Try again in {retry_after}s.",
            headers={"Retry-After": str(retry_after)},
        )
    hits.append(now)


class TokenRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int


class MeResponse(BaseModel):
    username: str
    display_name: str
    role: str
    authenticated_at: datetime


@router.post("/token", response_model=TokenResponse)
async def login(body: TokenRequest, request: Request, db: AsyncSession = Depends(get_db)):
    """Exchange credentials for a JWT. Checks DB users first, falls back to env vars."""
    _rate_limit(request)
    role = "admin"
    display_name = body.username

    # 1. Try DB users
    result = await db.execute(
        select(User).where(User.username == body.username, User.is_active == True)
    )
    db_user = result.scalar_one_or_none()

    if db_user:
        if not verify_password(body.password, db_user.hashed_password):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials")
        role = db_user.role
        display_name = db_user.display_name or db_user.username
    else:
        # 2. Fall back to env-var admin (constant-time comparisons)
        user_ok = hmac.compare_digest(body.username, _DASHBOARD_USER)
        pass_ok = hmac.compare_digest(body.password, _DASHBOARD_PASS)
        if not (user_ok and pass_ok):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials")

    token = create_jwt(body.username, role=role)
    return TokenResponse(
        access_token=token,
        expires_in=int(os.environ.get("KYRO_JWT_EXPIRY_HOURS", "24")) * 3600,
    )


@router.get("/me", response_model=MeResponse)
async def me(claims: dict = Depends(require_jwt)):
    return MeResponse(
        username=claims["sub"],
        display_name=claims.get("display_name", claims["sub"]),
        role=claims.get("role", "operator"),
        authenticated_at=datetime.now(timezone.utc),
    )
