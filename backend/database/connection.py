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

# Load .env from the project root (Kyro/Kyro/.env) — must happen before
# os.environ.get calls so env vars are available at module import time.
_env_path = Path(__file__).parent.parent.parent / ".env"
load_dotenv(_env_path)

DATABASE_URL: str = os.environ.get(
    "DATABASE_URL",
    "postgresql+asyncpg://kyro:kyro@localhost:5433/kyro",
)

engine = create_async_engine(
    DATABASE_URL,
    echo=False,       # Set True for SQL debug logs
    pool_pre_ping=True,
    poolclass=NullPool,  # Safer for async — no connection sharing across coroutines
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
