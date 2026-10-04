"""second data source: Luchtmeetnet columns and sync warnings (ADR 0017)

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-04
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "sync_jobs",
        sa.Column(
            "warnings", postgresql.JSONB(), server_default=sa.text("'[]'::jsonb"), nullable=False
        ),
    )
    # Every existing row came from OpenAQ, which is what the default says.
    op.add_column(
        "station_readings",
        sa.Column(
            "sources",
            postgresql.JSONB(),
            server_default=sa.text("""'["openaq"]'::jsonb"""),
            nullable=False,
        ),
    )
    op.add_column("station_readings", sa.Column("luchtmeetnet_number", sa.Text(), nullable=True))
    op.alter_column("station_readings", "openaq_location_id", nullable=True)
    op.create_unique_constraint(
        "uq_station_readings_job_luchtmeetnet",
        "station_readings",
        ["sync_job_id", "luchtmeetnet_number"],
    )
    op.create_check_constraint(
        "ck_station_readings_has_source_id",
        "station_readings",
        "openaq_location_id IS NOT NULL OR luchtmeetnet_number IS NOT NULL",
    )


def downgrade() -> None:
    # Rows that only Luchtmeetnet knows have no OpenAQ id to fall back on; deleting them silently
    # would lose data, so a downgrade stops until they are removed on purpose.
    bind = op.get_bind()
    only_luchtmeetnet = bind.execute(
        sa.text("SELECT count(*) FROM station_readings WHERE openaq_location_id IS NULL")
    ).scalar_one()
    if only_luchtmeetnet:
        raise RuntimeError(
            f"{only_luchtmeetnet} station readings have no OpenAQ location id; "
            "delete them before downgrading."
        )
    op.drop_constraint("ck_station_readings_has_source_id", "station_readings", type_="check")
    op.drop_constraint("uq_station_readings_job_luchtmeetnet", "station_readings", type_="unique")
    op.alter_column("station_readings", "openaq_location_id", nullable=False)
    op.drop_column("station_readings", "luchtmeetnet_number")
    op.drop_column("station_readings", "sources")
    op.drop_column("sync_jobs", "warnings")
