"""
Kyro — Web Push API Routes

POST   /api/v1/push/subscribe          — Register a push subscription + rules
DELETE /api/v1/push/subscribe          — Unregister current subscription
GET    /api/v1/push/vapid-public-key   — Return VAPID public key (needed by browser)
GET    /api/v1/push/rules              — List rules for current user's subscriptions
PUT    /api/v1/push/rules/{id}         — Update a rule
POST   /api/v1/push/test               — Send a test push to current subscription
"""

from __future__ import annotations

import logging
import os
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.auth.dependencies import require_jwt, decode_jwt
from backend.database.connection import get_db
from backend.database.models import User
from backend.database.push_models import PushSubscription, NotificationRule

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/push", tags=["Push Notifications"])

VAPID_PUBLIC_KEY = os.environ.get("VAPID_PUBLIC_KEY", "")
_bearer = HTTPBearer(auto_error=False)


async def _optional_jwt(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> dict | None:
    """JWT is optional — returns None if missing or invalid (used for push subscribe)."""
    if not credentials:
        return None
    try:
        return decode_jwt(credentials.credentials)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class PushKeys(BaseModel):
    p256dh: str
    auth: str


class SubscribeRequest(BaseModel):
    endpoint: str
    keys: PushKeys
    # Notification rules — defaults apply if not provided
    camera_id:      Optional[str] = None   # None = all cameras
    warn_threshold: float = 0.80
    crit_threshold: float = 0.90
    notify_offline: bool  = True


class RuleResponse(BaseModel):
    id:             int
    camera_id:      Optional[str]
    warn_threshold: float
    crit_threshold: float
    notify_offline: bool
    is_active:      bool


class SubscriptionResponse(BaseModel):
    subscription_id: int
    endpoint_tail:   str   # last 30 chars for display (don't expose full endpoint)
    is_active:       bool
    rules:           list[RuleResponse]


class RuleUpdate(BaseModel):
    camera_id:      Optional[str] = None
    warn_threshold: Optional[float] = None
    crit_threshold: Optional[float] = None
    notify_offline: Optional[bool]  = None
    is_active:      Optional[bool]  = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

from backend.auth.passwords import hash_password as _hash_password

_ENV_DASHBOARD_USER = os.environ.get("KYRO_DASHBOARD_USER", "admin")

async def _get_user(claims: dict, db: AsyncSession) -> User:
    username = claims["sub"]
    result = await db.execute(select(User).where(User.username == username))
    user = result.scalar_one_or_none()
    if not user:
        env_user = os.environ.get("KYRO_DASHBOARD_USER", "admin")
        env_pass = os.environ.get("KYRO_DASHBOARD_PASS", "")
        if username != env_user:
            raise HTTPException(404, "User not found")
        user   = User(
            username        = username,
            display_name    = username,
            hashed_password = _hash_password(env_pass),
            role            = claims.get("role", "admin"),
            is_active       = True,
        )
        db.add(user)
        await db.commit()
        await db.refresh(user)
    return user


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/vapid-public-key")
async def get_vapid_public_key():
    """Return the VAPID public key so the browser can subscribe."""
    if not VAPID_PUBLIC_KEY:
        raise HTTPException(503, "Push notifications not configured (missing VAPID_PUBLIC_KEY)")
    return {"publicKey": VAPID_PUBLIC_KEY}


@router.post("/subscribe", response_model=SubscriptionResponse, status_code=201)
async def subscribe(
    body: SubscribeRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    claims: dict = Depends(require_jwt),
):
    """Register (or update) a push subscription for the current user."""
    user = await _get_user(claims, db)

    # Upsert subscription by endpoint
    result = await db.execute(
        select(PushSubscription).where(PushSubscription.endpoint == body.endpoint)
    )
    sub = result.scalar_one_or_none()

    ua = request.headers.get("user-agent", "")[:256]

    if sub:
        # Update keys in case they rotated
        sub.p256dh     = body.keys.p256dh
        sub.auth       = body.keys.auth
        sub.is_active  = True
        sub.user_agent = ua
    else:
        sub = PushSubscription(
            user_id    = user.id,
            endpoint   = body.endpoint,
            p256dh     = body.keys.p256dh,
            auth       = body.keys.auth,
            user_agent = ua,
        )
        db.add(sub)
        await db.flush()  # get sub.id

    # Always add/update a rule for this subscription
    rule_result = await db.execute(
        select(NotificationRule).where(
            NotificationRule.subscription_id == sub.id,
            NotificationRule.camera_id == body.camera_id,
        )
    )
    rule = rule_result.scalar_one_or_none()
    if rule:
        rule.warn_threshold = body.warn_threshold
        rule.crit_threshold = body.crit_threshold
        rule.notify_offline = body.notify_offline
        rule.is_active      = True
    else:
        rule = NotificationRule(
            subscription_id = sub.id,
            camera_id       = body.camera_id,
            warn_threshold  = body.warn_threshold,
            crit_threshold  = body.crit_threshold,
            notify_offline  = body.notify_offline,
        )
        db.add(rule)

    await db.commit()

    # Reload sub with rules eagerly — lazy loading breaks in async context
    from sqlalchemy.orm import selectinload
    result2 = await db.execute(
        select(PushSubscription)
        .options(selectinload(PushSubscription.rules))
        .where(PushSubscription.id == sub.id)
    )
    sub = result2.scalar_one()

    logger.info("Push subscription saved | user=%s endpoint=...%s", user.username, body.endpoint[-20:])
    return _to_response(sub)


@router.delete("/subscribe", status_code=204)
async def unsubscribe(
    endpoint: str,
    db: AsyncSession = Depends(get_db),
    claims: dict = Depends(require_jwt),
):
    """Deactivate a push subscription by endpoint URL."""
    result = await db.execute(
        select(PushSubscription).where(PushSubscription.endpoint == endpoint)
    )
    sub = result.scalar_one_or_none()
    if sub:
        sub.is_active = False
        await db.commit()


@router.get("/subscriptions", response_model=list[SubscriptionResponse])
async def list_subscriptions(
    db: AsyncSession = Depends(get_db),
    claims: dict = Depends(require_jwt),
):
    from sqlalchemy.orm import selectinload
    user = await _get_user(claims, db)
    result = await db.execute(
        select(PushSubscription)
        .options(selectinload(PushSubscription.rules))
        .where(PushSubscription.user_id == user.id, PushSubscription.is_active == True)
    )
    subs = result.scalars().all()
    return [_to_response(s) for s in subs]


@router.put("/rules/{rule_id}", response_model=RuleResponse)
async def update_rule(
    rule_id: int,
    body: RuleUpdate,
    db: AsyncSession = Depends(get_db),
    claims: dict = Depends(require_jwt),
):
    result = await db.execute(select(NotificationRule).where(NotificationRule.id == rule_id))
    rule = result.scalar_one_or_none()
    if not rule:
        raise HTTPException(404, "Rule not found")

    for field, value in body.model_dump(exclude_none=True).items():
        setattr(rule, field, value)
    await db.commit()
    await db.refresh(rule)
    return _rule_to_response(rule)


@router.post("/test", status_code=202)
async def send_test_push(
    endpoint: str,
    db: AsyncSession = Depends(get_db),
    claims: dict = Depends(require_jwt),
):
    """Send a test notification to a specific subscription."""
    result = await db.execute(
        select(PushSubscription).where(
            PushSubscription.endpoint == endpoint,
            PushSubscription.is_active == True,
        )
    )
    sub = result.scalar_one_or_none()
    if not sub:
        raise HTTPException(404, "Subscription not found or inactive")

    from backend.services.push_sender import send_push
    ok = send_push(sub.endpoint, sub.p256dh, sub.auth, {
        "title": "✅ Kyro notifications active",
        "body":  "You'll get alerts for overcrowding and camera issues.",
        "tag":   "kyro-test",
    })
    if not ok:
        raise HTTPException(503, "Push delivery failed — check VAPID keys")
    return {"sent": True}


@router.post("/demo-alerts", status_code=202)
async def trigger_demo_alerts(
    claims: dict = Depends(require_jwt),
):
    """
    Fire a sequence of realistic demo push notifications across all demo cameras.
    Use this to verify the full notification pipeline works end-to-end.
    Fires in the background so the response returns immediately.
    """
    from backend.services.alert_watcher import fire_demo_alerts
    import asyncio
    asyncio.create_task(fire_demo_alerts())
    return {
        "fired": True,
        "message": "Demo alerts queued — you should receive 5 notifications over the next ~10 seconds",
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _rule_to_response(r: NotificationRule) -> RuleResponse:
    return RuleResponse(
        id             = r.id,
        camera_id      = r.camera_id,
        warn_threshold = r.warn_threshold,
        crit_threshold = r.crit_threshold,
        notify_offline = r.notify_offline,
        is_active      = r.is_active,
    )


def _to_response(s: PushSubscription) -> SubscriptionResponse:
    return SubscriptionResponse(
        subscription_id = s.id,
        endpoint_tail   = "…" + s.endpoint[-30:],
        is_active       = s.is_active,
        rules           = [_rule_to_response(r) for r in (s.rules or [])],
    )
