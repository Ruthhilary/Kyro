"""
Kyro — User Management Routes

GET    /api/v1/users           — List all users (admin only)
POST   /api/v1/users           — Create a new user (admin only)
GET    /api/v1/users/{id}      — Get user detail
PUT    /api/v1/users/{id}      — Update user (admin only)
DELETE /api/v1/users/{id}      — Deactivate user (admin only)
POST   /api/v1/users/change-password — Change own password
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.auth.dependencies import require_jwt
from backend.auth.passwords import hash_password as _hash_password
from backend.auth.passwords import verify_password as _verify_password
from backend.database.connection import get_db
from backend.database.models import User

router = APIRouter(prefix="/api/v1/users", tags=["Users"])

# Password hashing now lives in backend.auth.passwords (PBKDF2-HMAC-SHA256)
# so every call site shares one implementation instead of each re-rolling
# its own (previously weaker, single-round SHA-256) version.

# Export so auth module can use it
verify_password = _verify_password


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class UserCreate(BaseModel):
    username: str
    display_name: Optional[str] = None
    password: str
    role: str = "operator"

    @field_validator("role")
    @classmethod
    def validate_role(cls, v: str) -> str:
        if v not in ("admin", "operator", "viewer"):
            raise ValueError("role must be admin, operator, or viewer")
        return v

    @field_validator("password")
    @classmethod
    def validate_password(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("password must be at least 8 characters")
        return v


class UserUpdate(BaseModel):
    display_name: Optional[str] = None
    role: Optional[str] = None
    is_active: Optional[bool] = None

    @field_validator("role")
    @classmethod
    def validate_role(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v not in ("admin", "operator", "viewer"):
            raise ValueError("role must be admin, operator, or viewer")
        return v


class UserResponse(BaseModel):
    id: int
    username: str
    display_name: Optional[str]
    role: str
    is_active: bool
    created_at: datetime


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str

    @field_validator("new_password")
    @classmethod
    def validate_new_password(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("new password must be at least 8 characters")
        return v


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _require_admin(claims: dict) -> None:
    if claims.get("role") != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Admin role required")


def _to_response(u: User) -> UserResponse:
    return UserResponse(
        id=u.id,
        username=u.username,
        display_name=u.display_name,
        role=u.role,
        is_active=u.is_active,
        created_at=u.created_at or datetime.now(timezone.utc),
    )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("", response_model=list[UserResponse])
async def list_users(
    db: AsyncSession = Depends(get_db),
    claims: dict = Depends(require_jwt),
):
    _require_admin(claims)
    result = await db.execute(select(User).where(User.is_active == True))
    return [_to_response(u) for u in result.scalars().all()]


@router.post("", response_model=UserResponse, status_code=201)
async def create_user(
    body: UserCreate,
    db: AsyncSession = Depends(get_db),
    claims: dict = Depends(require_jwt),
):
    _require_admin(claims)

    # Check uniqueness
    existing = await db.execute(select(User).where(User.username == body.username))
    if existing.scalar_one_or_none():
        raise HTTPException(409, f"Username '{body.username}' already exists")

    user = User(
        username=body.username,
        display_name=body.display_name or body.username,
        hashed_password=_hash_password(body.password),
        role=body.role,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return _to_response(user)


@router.get("/{user_id}", response_model=UserResponse)
async def get_user(
    user_id: int,
    db: AsyncSession = Depends(get_db),
    claims: dict = Depends(require_jwt),
):
    # Users can view their own profile; admins can view any
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(404, "User not found")
    if claims.get("role") != "admin" and claims.get("sub") != user.username:
        raise HTTPException(403, "Forbidden")
    return _to_response(user)


@router.put("/{user_id}", response_model=UserResponse)
async def update_user(
    user_id: int,
    body: UserUpdate,
    db: AsyncSession = Depends(get_db),
    claims: dict = Depends(require_jwt),
):
    _require_admin(claims)
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(404, "User not found")
    for field, value in body.model_dump(exclude_none=True).items():
        setattr(user, field, value)
    await db.commit()
    await db.refresh(user)
    return _to_response(user)


@router.delete("/{user_id}", status_code=204)
async def deactivate_user(
    user_id: int,
    db: AsyncSession = Depends(get_db),
    claims: dict = Depends(require_jwt),
):
    _require_admin(claims)
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(404, "User not found")
    user.is_active = False
    await db.commit()


@router.post("/change-password", status_code=200)
async def change_password(
    body: ChangePasswordRequest,
    db: AsyncSession = Depends(get_db),
    claims: dict = Depends(require_jwt),
):
    """Authenticated user changes their own password."""
    result = await db.execute(select(User).where(User.username == claims["sub"]))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(404, "User not found")
    if not _verify_password(body.current_password, user.hashed_password):
        raise HTTPException(401, "Current password is incorrect")
    user.hashed_password = _hash_password(body.new_password)
    await db.commit()
    return {"changed": True}
