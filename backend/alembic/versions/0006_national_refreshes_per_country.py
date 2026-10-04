"""national refreshes belong to a country (ADR 0019)

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-04
"""

import sqlalchemy as sa
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Every refresh so far was the Netherlands.
    op.add_column(
        "national_refreshes",
        sa.Column("country_code", sa.String(2), server_default="NL", nullable=False),
    )
    op.alter_column("national_refreshes", "country_code", server_default=None)
    op.drop_index("uq_national_refreshes_one_processing", table_name="national_refreshes")
    op.drop_index("ix_national_refreshes_status_finished", table_name="national_refreshes")
    op.create_index(
        "ix_national_refreshes_country_status_finished",
        "national_refreshes",
        ["country_code", "status", "finished_at"],
    )
    op.create_index(
        "uq_national_refreshes_one_processing_per_country",
        "national_refreshes",
        ["country_code"],
        unique=True,
        postgresql_where=sa.text("status = 'processing'"),
    )


def downgrade() -> None:
    # Other countries' refreshes cannot be folded into the single national layer; deleting them
    # silently would lose data, so a downgrade stops until they are removed on purpose.
    other = (
        op.get_bind()
        .execute(sa.text("SELECT count(*) FROM national_refreshes WHERE country_code <> 'NL'"))
        .scalar_one()
    )
    if other:
        raise RuntimeError(
            f"{other} national refreshes belong to other countries; delete them before "
            "downgrading."
        )
    op.drop_index(
        "uq_national_refreshes_one_processing_per_country", table_name="national_refreshes"
    )
    op.drop_index("ix_national_refreshes_country_status_finished", table_name="national_refreshes")
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
    op.drop_column("national_refreshes", "country_code")
