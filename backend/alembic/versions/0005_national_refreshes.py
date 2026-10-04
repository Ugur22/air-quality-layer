"""national layer: refreshes and the readings that belong to them (ADR 0018)

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-04
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "national_refreshes",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("station_count", sa.Integer(), nullable=True),
        sa.Column(
            "errors", postgresql.JSONB(), server_default=sa.text("'[]'::jsonb"), nullable=False
        ),
        sa.Column(
            "warnings", postgresql.JSONB(), server_default=sa.text("'[]'::jsonb"), nullable=False
        ),
        sa.CheckConstraint(
            "status IN ('processing', 'succeeded', 'failed')", name="ck_national_refreshes_status"
        ),
    )
    op.create_index(
        "ix_national_refreshes_status_finished", "national_refreshes", ["status", "finished_at"]
    )
    op.create_index(
        "uq_national_refreshes_one_processing",
        "national_refreshes",
        ["status"],
        unique=True,
        postgresql_where=sa.text("status = 'processing'"),
    )
    op.add_column(
        "station_readings",
        sa.Column("national_refresh_id", sa.Uuid(), sa.ForeignKey("national_refreshes.id")),
    )
    op.create_index(
        "ix_station_readings_national_refresh_id", "station_readings", ["national_refresh_id"]
    )
    op.alter_column("station_readings", "sync_job_id", nullable=True)
    op.create_unique_constraint(
        "uq_station_readings_refresh_location",
        "station_readings",
        ["national_refresh_id", "openaq_location_id"],
    )
    op.create_unique_constraint(
        "uq_station_readings_refresh_luchtmeetnet",
        "station_readings",
        ["national_refresh_id", "luchtmeetnet_number"],
    )
    op.create_check_constraint(
        "ck_station_readings_one_parent",
        "station_readings",
        "(sync_job_id IS NULL) <> (national_refresh_id IS NULL)",
    )


def downgrade() -> None:
    # Readings of a national refresh have no sync job to fall back on; deleting them silently
    # would lose data, so a downgrade stops until they are removed on purpose.
    bind = op.get_bind()
    national = bind.execute(
        sa.text("SELECT count(*) FROM station_readings WHERE national_refresh_id IS NOT NULL")
    ).scalar_one()
    if national:
        raise RuntimeError(
            f"{national} station readings belong to national refreshes; delete them before "
            "downgrading."
        )
    op.drop_constraint("ck_station_readings_one_parent", "station_readings", type_="check")
    op.drop_constraint("uq_station_readings_refresh_luchtmeetnet", "station_readings", type_="unique")
    op.drop_constraint("uq_station_readings_refresh_location", "station_readings", type_="unique")
    op.alter_column("station_readings", "sync_job_id", nullable=False)
    op.drop_index("ix_station_readings_national_refresh_id", table_name="station_readings")
    op.drop_column("station_readings", "national_refresh_id")
    op.drop_index("uq_national_refreshes_one_processing", table_name="national_refreshes")
    op.drop_index("ix_national_refreshes_status_finished", table_name="national_refreshes")
    op.drop_table("national_refreshes")
