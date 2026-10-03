"""One-shot startup step: Alembic migrations and Procrastinate schema."""

import asyncio

import psycopg
from alembic import command
from alembic.config import Config

from airlayer.config import get_settings
from airlayer.jobs import app


async def _apply_procrastinate_schema() -> None:
    with psycopg.connect(get_settings().database_url) as conn:
        exists = conn.execute("SELECT to_regclass('procrastinate_jobs')").fetchone()
    if exists and exists[0] is not None:
        return
    async with app.open_async():
        await app.schema_manager.apply_schema_async()


def main() -> None:
    command.upgrade(Config("alembic.ini"), "head")
    asyncio.run(_apply_procrastinate_schema())


if __name__ == "__main__":
    main()
