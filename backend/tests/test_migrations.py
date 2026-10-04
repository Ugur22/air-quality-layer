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


def test_readings_stored_before_the_second_source_read_as_openaq_and_a_downgrade_keeps_the_rest(
    migration_db: None,
) -> None:
    alembic("upgrade", "0003")
    with psycopg.connect(MIGRATION_URL, autocommit=True) as conn:
        org, project = conn.execute("SELECT organisation_id, id FROM projects").fetchone() or (
            None,
            None,
        )
        conn.execute(
            "INSERT INTO regions (id, project_id, organisation_id, name, geom) VALUES "
            "('00000000-0000-4000-8000-0000000000c1', %s, %s, 'r', "
            "ST_MakeEnvelope(4.85, 52.35, 4.95, 52.40, 4326))",
            (project, org),
        )
        conn.execute(
            "INSERT INTO sync_jobs (id, organisation_id, region_id, status) VALUES "
            "('00000000-0000-4000-8000-0000000000d1', %s, "
            "'00000000-0000-4000-8000-0000000000c1', 'succeeded')",
            (org,),
        )
        conn.execute(
            "INSERT INTO station_readings (id, sync_job_id, openaq_location_id, name, geom, "
            "readings) VALUES ('00000000-0000-4000-8000-0000000000e1', "
            "'00000000-0000-4000-8000-0000000000d1', 7, 'Old', "
            "ST_SetSRID(ST_MakePoint(4.9, 52.37), 4326), '{}'::jsonb)"
        )

    alembic("upgrade", "head")

    with psycopg.connect(MIGRATION_URL, autocommit=True) as conn:
        row = conn.execute("SELECT sources, luchtmeetnet_number FROM station_readings").fetchone()
        assert row == (["openaq"], None)
        conn.execute(
            "INSERT INTO station_readings (id, sync_job_id, luchtmeetnet_number, name, geom, "
            "readings) VALUES ('00000000-0000-4000-8000-0000000000e2', "
            "'00000000-0000-4000-8000-0000000000d1', 'NL1', 'New', "
            "ST_SetSRID(ST_MakePoint(4.9, 52.37), 4326), '{}'::jsonb)"
        )

    # Rows only Luchtmeetnet knows have no OpenAQ id, so a downgrade stops instead of losing them.
    with pytest.raises(subprocess.CalledProcessError):
        alembic("downgrade", "0003")
    with psycopg.connect(MIGRATION_URL, autocommit=True) as conn:
        count = conn.execute("SELECT count(*) FROM station_readings").fetchone()
        conn.execute("DELETE FROM station_readings WHERE luchtmeetnet_number IS NOT NULL")
    assert count == (2,)

    alembic("downgrade", "0003")
    with psycopg.connect(MIGRATION_URL) as conn:
        assert conn.execute("SELECT openaq_location_id FROM station_readings").fetchall() == [(7,)]


def test_refreshes_stored_before_countries_are_the_netherlands_and_a_downgrade_keeps_them(
    migration_db: None,
) -> None:
    alembic("upgrade", "0005")
    with psycopg.connect(MIGRATION_URL, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO national_refreshes (id, status) "
            "VALUES ('00000000-0000-4000-8000-0000000000f1', 'succeeded')"
        )

    alembic("upgrade", "head")

    with psycopg.connect(MIGRATION_URL, autocommit=True) as conn:
        assert conn.execute("SELECT country_code FROM national_refreshes").fetchall() == [("NL",)]
        conn.execute(
            "INSERT INTO national_refreshes (id, status, country_code) "
            "VALUES ('00000000-0000-4000-8000-0000000000f2', 'succeeded', 'TR')"
        )

    # A Turkish refresh has no place in the single national layer, so a downgrade stops.
    with pytest.raises(subprocess.CalledProcessError):
        alembic("downgrade", "0005")
    with psycopg.connect(MIGRATION_URL, autocommit=True) as conn:
        conn.execute("DELETE FROM national_refreshes WHERE country_code = 'TR'")

    alembic("downgrade", "0005")
    with psycopg.connect(MIGRATION_URL) as conn:
        assert conn.execute("SELECT status FROM national_refreshes").fetchall() == [("succeeded",)]
