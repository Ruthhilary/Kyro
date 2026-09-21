"""Initial schema with all tables including users

Revision ID: 0001
Revises:
Create Date: 2026-07-31
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "cameras",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("camera_id", sa.String(64), nullable=False),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("stream_url", sa.Text(), nullable=False),
        sa.Column("location", sa.String(256), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=True, server_default="true"),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("now()")),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_cameras_camera_id", "cameras", ["camera_id"], unique=True)

    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("username", sa.String(64), nullable=False),
        sa.Column("display_name", sa.String(128), nullable=True),
        sa.Column("hashed_password", sa.String(256), nullable=False),
        sa.Column("role", sa.String(32), nullable=True, server_default="operator"),
        sa.Column("is_active", sa.Boolean(), nullable=True, server_default="true"),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("now()")),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_users_username", "users", ["username"], unique=True)

    op.create_table(
        "sessions",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("session_id", sa.String(64), nullable=False),
        sa.Column("camera_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(128), nullable=True),
        sa.Column("started_at", sa.DateTime(), nullable=False),
        sa.Column("ended_at", sa.DateTime(), nullable=True),
        sa.Column("venue_capacity", sa.Integer(), nullable=True, server_default="0"),
        sa.Column("peak_attendance", sa.Integer(), nullable=True, server_default="0"),
        sa.Column("total_entries", sa.Integer(), nullable=True, server_default="0"),
        sa.Column("total_exits", sa.Integer(), nullable=True, server_default="0"),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()")),
        sa.ForeignKeyConstraint(["camera_id"], ["cameras.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_sessions_session_id", "sessions", ["session_id"], unique=True)

    op.create_table(
        "attendance_events",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("session_id", sa.Integer(), nullable=False),
        sa.Column("recorded_at", sa.DateTime(), nullable=False),
        sa.Column("current_attendance", sa.Integer(), nullable=False),
        sa.Column("total_entries", sa.Integer(), nullable=False),
        sa.Column("total_exits", sa.Integer(), nullable=False),
        sa.Column("occupancy_percent", sa.Float(), nullable=False),
        sa.Column("seat_occupancy_json", sa.JSON(), nullable=True),
        sa.ForeignKeyConstraint(["session_id"], ["sessions.id"]),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "seat_layouts",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("camera_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("seats_json", sa.JSON(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=True, server_default="true"),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()")),
        sa.ForeignKeyConstraint(["camera_id"], ["cameras.id"]),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "analytics_summaries",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("date", sa.DateTime(), nullable=False),
        sa.Column("camera_id", sa.Integer(), nullable=False),
        sa.Column("avg_attendance", sa.Float(), nullable=True, server_default="0"),
        sa.Column("peak_attendance", sa.Integer(), nullable=True, server_default="0"),
        sa.Column("total_sessions", sa.Integer(), nullable=True, server_default="0"),
        sa.Column("avg_occupancy_pct", sa.Float(), nullable=True, server_default="0"),
        sa.Column("heatmap_json", sa.JSON(), nullable=True),
        sa.Column("arrival_pattern", sa.JSON(), nullable=True),
        sa.Column("departure_pattern", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()")),
        sa.ForeignKeyConstraint(["camera_id"], ["cameras.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_analytics_summaries_date", "analytics_summaries", ["date"])


def downgrade() -> None:
    op.drop_table("analytics_summaries")
    op.drop_table("seat_layouts")
    op.drop_table("attendance_events")
    op.drop_table("sessions")
    op.drop_table("users")
    op.drop_table("cameras")
