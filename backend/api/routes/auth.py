"""
Kyro — Auth Routes

POST /api/v1/auth/token   — Exchange username + password for a JWT
GET  /api/v1/auth/me      — Verify token and return user info
"""

from __future__ import annotations

import os
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from backend.auth.dependencies import create_jwt, require_jwt

router = APIRouter(prefix="/api/v1/auth", tags=["Auth"])

# In production, replace this with a proper user store / Argon2 hash check.
_DASHBOARD_USER = os.environ.get("KYRO_DASHBOARD_USER", "admin")
_DASHBOARD_PASS = os.environ.get("KYRO_DASHBOARD_PASS", "kyro-admin-change-me")


class TokenRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int  # seconds


@router.post("/token", response_model=TokenResponse)
async def login(body: TokenRequest):
    """Exchange credentials for a JWT. Used by the dashboard login page."""
    if body.username != _DASHBOARD_USER or body.password != _DASHBOARD_PASS:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid credentials",
        )
    token = create_jwt(body.username)
    return TokenResponse(
        access_token=token,
        expires_in=int(os.environ.get("KYRO_JWT_EXPIRY_HOURS", "24")) * 3600,
    )


class MeResponse(BaseModel):
    username: str
    authenticated_at: datetime


@router.get("/me", response_model=MeResponse)
async def me(claims: dict = Depends(require_jwt)):
    """Verify a JWT and return the user info embedded in it."""
    return MeResponse(
        username=claims["sub"],
        authenticated_at=datetime.now(timezone.utc),
    )
