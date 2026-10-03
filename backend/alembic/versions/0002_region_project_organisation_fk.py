"""a region's organisation must be its project's organisation

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-03
"""

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # regions.organisation_id duplicates the project's organisation for single-table tenancy
    # filters (ADR 0003); the composite key makes the database refuse a mismatch.
    op.create_unique_constraint("uq_projects_id_organisation_id", "projects", ["id", "organisation_id"])
    op.drop_constraint("regions_project_id_fkey", "regions", type_="foreignkey")
    op.create_foreign_key(
        "fk_regions_project_organisation",
        "regions",
        "projects",
        ["project_id", "organisation_id"],
        ["id", "organisation_id"],
    )


def downgrade() -> None:
    op.drop_constraint("fk_regions_project_organisation", "regions", type_="foreignkey")
    op.create_foreign_key("regions_project_id_fkey", "regions", "projects", ["project_id"], ["id"])
    op.drop_constraint("uq_projects_id_organisation_id", "projects", type_="unique")
