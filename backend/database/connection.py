"""
Kyro — Database Connection

Async SQLAlchemy engine using asyncpg driver.
Connection string is read from environment — never hardcoded.
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from backend.database.models import Base

# Load .env from the project root (Kyro/Kyro/.env) — only for local dev.
# Docker environment variables take priority (override=False).
_env_path = Path(__file__).parent.parent.parent / ".env"
load_dotenv(_env_path, override=False)

DATABASE_URL: str = os.environ.get(
    "DATABASE_URL",
    "postgresql+asyncpg://kyro:kyro@localhost:5433/kyro",
)

# Strip any existing ssl param from URL — we set it via connect_args below
_db_url_clean = DATABASE_URL.split("?")[0]

engine = create_async_engine(
    _db_url_clean,
    echo=False,
    pool_pre_ping=True,
    poolclass=NullPool,
    connect_args={"ssl": False},  # Disable SSL — Docker Postgres has no cert
)

AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


async def create_tables() -> None:
    """Create all tables on startup (dev/test). Use Alembic for production migrations."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def get_db() -> AsyncSession:  # type: ignore[return]
    """FastAPI dependency: yields an async database session."""
    async with AsyncSessionLocal() as session:
        yield session
