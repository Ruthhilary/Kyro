"""Add zone_type to exclusion_zones

Revision ID: 0002
Revises: 0001
Create Date: 2026-09-10
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0002"
down_revision: Union[str, None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "exclusion_zones",
        sa.Column("zone_type", sa.String(32), nullable=False, server_default="hold_seats"),
    )


def downgrade() -> None:
    op.drop_column("exclusion_zones", "zone_type")
