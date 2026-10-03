"""organisations, projects, regions, audit events, and the development seed

Revision ID: 0001
Revises:
Create Date: 2026-10-03
"""

import sqlalchemy as sa
from alembic import op
from geoalchemy2 import Geometry

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

# Must equal the defaults in airlayer.config (dev_organisation_id); ADR 0010 seeds one development
# organisation and project, reachable only through the development-only placeholder identity.
DEV_ORGANISATION_ID = "00000000-0000-4000-8000-000000000001"
DEV_PROJECT_ID = "00000000-0000-4000-8000-0000000000b1"


def upgrade() -> None:
    op.create_table(
        "organisations",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_table(
        "projects",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("organisation_id", sa.Uuid(), sa.ForeignKey("organisations.id"), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_index("ix_projects_organisation_id", "projects", ["organisation_id"])
    op.create_table(
        "regions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("project_id", sa.Uuid(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("organisation_id", sa.Uuid(), sa.ForeignKey("organisations.id"), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("geom", Geometry("POLYGON", srid=4326, spatial_index=False), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_index("ix_regions_organisation_id", "regions", ["organisation_id"])
    op.create_index("ix_regions_geom", "regions", ["geom"], postgresql_using="gist")
    op.create_index(
        "ix_regions_project_created", "regions", ["project_id", "created_at", "id"]
    )
    op.create_table(
        "audit_events",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("organisation_id", sa.Uuid(), sa.ForeignKey("organisations.id"), nullable=False),
        sa.Column("actor_id", sa.Uuid(), nullable=False),
        sa.Column("action", sa.String(100), nullable=False),
        sa.Column("entity_type", sa.String(50), nullable=False),
        sa.Column("entity_id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_index("ix_audit_events_organisation_id", "audit_events", ["organisation_id"])

    op.execute(
        sa.text("INSERT INTO organisations (id, name) VALUES (CAST(:id AS uuid), 'Development organisation')")
        .bindparams(id=DEV_ORGANISATION_ID)
    )
    op.execute(
        sa.text(
            "INSERT INTO projects (id, organisation_id, name) "
            "VALUES (CAST(:id AS uuid), CAST(:org AS uuid), 'Development project')"
        ).bindparams(id=DEV_PROJECT_ID, org=DEV_ORGANISATION_ID)
    )


def downgrade() -> None:
    op.drop_index("ix_audit_events_organisation_id", table_name="audit_events")
    op.drop_table("audit_events")
    op.drop_index("ix_regions_project_created", table_name="regions")
    op.drop_index("ix_regions_geom", table_name="regions", postgresql_using="gist")
    op.drop_index("ix_regions_organisation_id", table_name="regions")
    op.drop_table("regions")
    op.drop_index("ix_projects_organisation_id", table_name="projects")
    op.drop_table("projects")
    op.drop_table("organisations")
