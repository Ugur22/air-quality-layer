import subprocess
import sys
from collections.abc import Iterator

import psycopg
import pytest
from psycopg import sql

from tests.conftest import ADMIN_URL

MIGRATION_DB = "airlayer_migration_test"
MIGRATION_URL = ADMIN_URL.rsplit("/", 1)[0] + f"/{MIGRATION_DB}"


def alembic(*args: str) -> None:
    # A separate process reads the database URL from its own environment, so this never touches
    # the database the other tests share.
    subprocess.run(  # noqa: S603 - fixed arguments from this file, no untrusted input
        [sys.executable, "-m", "alembic", *args],
        check=True,
        env={"AIRLAYER_DATABASE_URL": MIGRATION_URL, "PATH": ""},
    )


@pytest.fixture
def migration_db() -> Iterator[None]:
    with psycopg.connect(ADMIN_URL, autocommit=True) as conn:
        conn.execute(
            sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(MIGRATION_DB))
        )
        conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(MIGRATION_DB)))
    with psycopg.connect(MIGRATION_URL, autocommit=True) as conn:
        conn.execute("CREATE EXTENSION IF NOT EXISTS postgis")
    yield
    with psycopg.connect(ADMIN_URL, autocommit=True) as conn:
        conn.execute(
            sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(MIGRATION_DB))
        )


def tables() -> set[str]:
    with psycopg.connect(MIGRATION_URL) as conn:
        rows = conn.execute(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
        ).fetchall()
    return {r[0] for r in rows}


OURS = {
    "organisations",
    "projects",
    "regions",
    "audit_events",
    "sync_jobs",
    "station_readings",
}


def test_migrations_apply_cleanly_to_an_empty_database(migration_db: None) -> None:
    alembic("upgrade", "head")
    assert OURS <= tables()

    alembic("downgrade", "base")
    assert not OURS & tables()

    alembic("upgrade", "head")
    assert OURS <= tables()


def test_upgrade_seeds_the_development_organisation_and_project(migration_db: None) -> None:
    alembic("upgrade", "head")

    with psycopg.connect(MIGRATION_URL) as conn:
        org = conn.execute("SELECT name FROM organisations").fetchall()
        project = conn.execute("SELECT organisation_id, name FROM projects").fetchall()
    assert org == [("Development organisation",)]
    assert [name for _, name in project] == ["Development project"]
    assert str(project[0][0]) == "00000000-0000-4000-8000-000000000001"


def test_region_geometry_is_a_polygon_in_wgs84_with_a_spatial_index(migration_db: None) -> None:
    alembic("upgrade", "head")

    with psycopg.connect(MIGRATION_URL) as conn:
        geometry = conn.execute(
            "SELECT type, srid FROM geometry_columns WHERE f_table_name = 'regions'"
        ).fetchall()
        index = conn.execute(
            "SELECT indexdef FROM pg_indexes WHERE indexname = 'ix_regions_geom'"
        ).fetchone()
    assert geometry == [("POLYGON", 4326)]
    assert index is not None
    assert "gist" in index[0]


def test_models_match_the_migrations(migration_db: None) -> None:
    alembic("upgrade", "head")

    # Fails when a model changes without a migration (or the reverse).
    alembic("check")
