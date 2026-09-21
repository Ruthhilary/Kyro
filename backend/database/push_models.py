"""
Kyro — Push Notification Models

PushSubscription: stores a browser's Web Push subscription per user.
NotificationRule: per-user alert rule (which zone, which threshold).
"""

from __future__ import annotations

from sqlalchemy import Boolean, Column, DateTime, Float, ForeignKey, Integer, JSON, String, Text, func
from sqlalchemy.orm import relationship

from backend.database.models import Base


class PushSubscription(Base):
    """Web Push subscription endpoint + keys for one browser/device."""
    __tablename__ = "push_subscriptions"

    id         = Column(Integer, primary_key=True, index=True)
    user_id    = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    endpoint   = Column(Text, nullable=False, unique=True)
    p256dh     = Column(Text, nullable=False)   # browser public key
    auth       = Column(Text, nullable=False)   # auth secret
    user_agent = Column(String(256))
    is_active  = Column(Boolean, default=True)
    created_at = Column(DateTime, server_default=func.now())

    user  = relationship("User")
    rules = relationship("NotificationRule", back_populates="subscription", cascade="all, delete-orphan")


class NotificationRule(Base):
    """
    Which alerts to send to a specific push subscription.
    camera_id=None means 'all cameras'.
    """
    __tablename__ = "notification_rules"

    id              = Column(Integer, primary_key=True, index=True)
    subscription_id = Column(Integer, ForeignKey("push_subscriptions.id", ondelete="CASCADE"), nullable=False)
    camera_id       = Column(String(64), nullable=True)   # NULL = all cameras
    warn_threshold  = Column(Float, default=0.80)         # 80% → warning push
    crit_threshold  = Column(Float, default=0.90)         # 90% → critical push
    notify_offline  = Column(Boolean, default=True)       # push when camera goes offline
    is_active       = Column(Boolean, default=True)
    created_at      = Column(DateTime, server_default=func.now())

    subscription = relationship("PushSubscription", back_populates="rules")
