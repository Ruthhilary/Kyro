"""
Kyro — Web Push Sender

Wraps pywebpush to send encrypted Web Push messages.
VAPID keys are read from environment variables.

VAPID claims:
  - sub: must be a mailto: URI (safest — works with all push services)
  - The audience is derived automatically from the endpoint URL by pywebpush
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY", "")
VAPID_PUBLIC_KEY  = os.environ.get("VAPID_PUBLIC_KEY", "")
# sub must be a mailto: — push servers use it as a contact address
VAPID_SUB = os.environ.get("VAPID_SUBJECT", "mailto:admin@kyro.local")
if not VAPID_SUB.startswith("mailto:") and not VAPID_SUB.startswith("https://"):
    VAPID_SUB = "mailto:" + VAPID_SUB


def send_push(endpoint: str, p256dh: str, auth: str, payload: dict[str, Any]) -> bool:
    """Send a JSON push payload to one subscription. Returns True on success."""
    if not VAPID_PRIVATE_KEY:
        logger.warning("VAPID_PRIVATE_KEY not set — push notifications disabled")
        return False

    try:
        from pywebpush import webpush, WebPushException

        # pywebpush derives the VAPID audience automatically from the endpoint
        # so we only need sub here
        webpush(
            subscription_info={
                "endpoint": endpoint,
                "keys": {"p256dh": p256dh, "auth": auth},
            },
            data=json.dumps(payload),
            vapid_private_key=VAPID_PRIVATE_KEY,
            vapid_claims={"sub": VAPID_SUB},
        )
        return True

    except Exception as exc:
        logger.warning("Push send failed: %s", exc)
        return False
