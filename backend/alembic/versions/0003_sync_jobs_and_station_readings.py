"""sync jobs and station readings

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-03
"""

import sqlalchemy as sa
from alembic import op
from geoalchemy2 import Geometry
from sqlalchemy.dialects import postgresql

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_unique_constraint("uq_regions_id_organisation_id", "regions", ["id", "organisation_id"])
    op.create_table(
        "sync_jobs",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("organisation_id", sa.Uuid(), sa.ForeignKey("organisations.id"), nullable=False),
        sa.Column("region_id", sa.Uuid(), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("station_count", sa.Integer(), nullable=True),
        sa.Column(
            "errors",
            postgresql.JSONB(),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["region_id", "organisation_id"],
            ["regions.id", "regions.organisation_id"],
            name="fk_sync_jobs_region_organisation",
        ),
        sa.CheckConstraint(
            "status IN ('queued', 'processing', 'succeeded', 'failed')", name="ck_sync_jobs_status"
        ),
    )
    op.create_index("ix_sync_jobs_organisation_id", "sync_jobs", ["organisation_id"])
    op.create_index("ix_sync_jobs_region_created", "sync_jobs", ["region_id", "created_at", "id"])
    op.create_index(
        "uq_sync_jobs_one_in_flight_per_region",
        "sync_jobs",
        ["region_id"],
        unique=True,
        postgresql_where=sa.text("status IN ('queued', 'processing')"),
    )
    op.create_table(
        "station_readings",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("sync_job_id", sa.Uuid(), sa.ForeignKey("sync_jobs.id"), nullable=False),
        sa.Column("openaq_location_id", sa.BigInteger(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("geom", Geometry("POINT", srid=4326, spatial_index=False), nullable=False),
        sa.Column("readings", postgresql.JSONB(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint(
            "sync_job_id", "openaq_location_id", name="uq_station_readings_job_location"
        ),
    )
    op.create_index(
        "ix_station_readings_geom", "station_readings", ["geom"], postgresql_using="gist"
    )


def downgrade() -> None:
    op.drop_index("ix_station_readings_geom", table_name="station_readings", postgresql_using="gist")
    op.drop_table("station_readings")
    op.drop_index("uq_sync_jobs_one_in_flight_per_region", table_name="sync_jobs")
    op.drop_index("ix_sync_jobs_region_created", table_name="sync_jobs")
    op.drop_index("ix_sync_jobs_organisation_id", table_name="sync_jobs")
    op.drop_table("sync_jobs")
    op.drop_constraint("uq_regions_id_organisation_id", "regions", type_="unique")
