from datetime import datetime
from enum import StrEnum
from typing import Any
from uuid import UUID, uuid4

from geoalchemy2 import Geometry
from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Organisation(Base):
    __tablename__ = "organisations"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    name: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Project(Base):
    __tablename__ = "projects"
    __table_args__ = (
        UniqueConstraint("id", "organisation_id", name="uq_projects_id_organisation_id"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    organisation_id: Mapped[UUID] = mapped_column(ForeignKey("organisations.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Region(Base):
    __tablename__ = "regions"
    __table_args__ = (
        UniqueConstraint("id", "organisation_id", name="uq_regions_id_organisation_id"),
        ForeignKeyConstraint(
            ["project_id", "organisation_id"],
            ["projects.id", "projects.organisation_id"],
            name="fk_regions_project_organisation",
        ),
        Index("ix_regions_geom", "geom", postgresql_using="gist"),
        Index("ix_regions_project_created", "project_id", "created_at", "id"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    project_id: Mapped[UUID]
    # Copied from the project so every tenancy filter is a single-table check (ADR 0003);
    # the repository sets it from the request context, never from client input.
    organisation_id: Mapped[UUID] = mapped_column(ForeignKey("organisations.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    # The bbox is stored as its envelope polygon; the API derives [min_lon, min_lat, max_lon,
    # max_lat] from it. The GiST index is declared above because GeoAlchemy2's automatic one is
    # not emitted by Alembic's create_table.
    geom: Mapped[str] = mapped_column(Geometry("POLYGON", srid=4326, spatial_index=False))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AuditEvent(Base):
    __tablename__ = "audit_events"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    organisation_id: Mapped[UUID] = mapped_column(ForeignKey("organisations.id"), index=True)
    actor_id: Mapped[UUID]
    action: Mapped[str] = mapped_column(String(100))
    entity_type: Mapped[str] = mapped_column(String(50))
    entity_id: Mapped[UUID]
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class SyncStatus(StrEnum):
    QUEUED = "queued"
    PROCESSING = "processing"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


IN_FLIGHT = (SyncStatus.QUEUED, SyncStatus.PROCESSING)
IN_FLIGHT_INDEX = "uq_sync_jobs_one_in_flight_per_region"


class SyncJob(Base):
    __tablename__ = "sync_jobs"
    __table_args__ = (
        ForeignKeyConstraint(
            ["region_id", "organisation_id"],
            ["regions.id", "regions.organisation_id"],
            name="fk_sync_jobs_region_organisation",
        ),
        CheckConstraint(
            "status IN ('queued', 'processing', 'succeeded', 'failed')", name="ck_sync_jobs_status"
        ),
        # The database, not just the API, guarantees one in-flight sync per region (ADR 0010).
        Index(
            IN_FLIGHT_INDEX,
            "region_id",
            unique=True,
            postgresql_where=text("status IN ('queued', 'processing')"),
        ),
        Index("ix_sync_jobs_region_created", "region_id", "created_at", "id"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    organisation_id: Mapped[UUID] = mapped_column(ForeignKey("organisations.id"), index=True)
    region_id: Mapped[UUID]
    status: Mapped[str] = mapped_column(String(20), default=SyncStatus.QUEUED.value)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    station_count: Mapped[int | None]
    errors: Mapped[list[dict[str, str]]] = mapped_column(JSONB, server_default=text("'[]'::jsonb"))


class StationReading(Base):
    __tablename__ = "station_readings"
    __table_args__ = (
        UniqueConstraint(
            "sync_job_id", "openaq_location_id", name="uq_station_readings_job_location"
        ),
        Index("ix_station_readings_geom", "geom", postgresql_using="gist"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    # Readings are only reachable through an organisation-scoped sync job lookup, so they carry
    # no organisation column of their own.
    sync_job_id: Mapped[UUID] = mapped_column(ForeignKey("sync_jobs.id"))
    openaq_location_id: Mapped[int] = mapped_column(BigInteger)
    name: Mapped[str] = mapped_column(Text)
    geom: Mapped[str] = mapped_column(Geometry("POINT", srid=4326, spatial_index=False))
    # {"pm25": {"value": 12.4, "unit": "µg/m³", "observed_at": "..."}} (ADR 0010)
    readings: Mapped[dict[str, Any]] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
