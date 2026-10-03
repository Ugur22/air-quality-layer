import logging
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from airlayer import repositories as repo
from airlayer.db import get_session
from airlayer.errors import ApiError
from airlayer.identity import RequestContext, get_request_context
from airlayer.jobs import sync_region
from airlayer.layers import Comparator, parse_filter
from airlayer.places import PlaceSearch, ProviderUnavailable, RateLimited, get_place_search
from airlayer.schemas import (
    ErrorResponse,
    MapLayerResponse,
    PlaceListResponse,
    PlaceOut,
    ProjectListResponse,
    RegionCreate,
    RegionListResponse,
    RegionResponse,
    SyncJobListResponse,
    SyncJobResponse,
)
from airlayer.sync import fail_job

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1")

# FastAPI documents a 422 for validation errors; this API answers 400 in the shared error shape
# (api-contracts.md), so the real responses are declared here and the 422 is removed in main.py.
_R400 = {"model": ErrorResponse, "description": "validation_failed"}
_R401 = {"model": ErrorResponse, "description": "unauthorized (outside development)"}
_R503 = {
    "model": ErrorResponse,
    "description": "service_unavailable (a sync could not be queued, or place search is down)",
}
_R429 = {"model": ErrorResponse, "description": "rate_limited (too many place searches)"}
_R409 = {"model": ErrorResponse, "description": "conflict (a sync is already running)"}
_R404 = {"model": ErrorResponse, "description": "not_found (also for another organisation's data)"}

Context = Annotated[RequestContext, Depends(get_request_context)]
Session = Annotated[AsyncSession, Depends(get_session)]


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/projects", responses={400: _R400, 401: _R401})
async def list_projects(ctx: Context, session: Session) -> ProjectListResponse:
    return ProjectListResponse(projects=await repo.list_projects(session, ctx))


@router.post(
    "/projects/{project_id}/regions",
    status_code=201,
    responses={400: _R400, 401: _R401, 404: _R404},
)
async def create_region(
    project_id: str, body: RegionCreate, ctx: Context, session: Session
) -> RegionResponse:
    pid = repo.parse_id(project_id)
    if pid is None:
        raise repo.invalid_id("Project")
    if not await repo.project_exists(session, ctx, pid):
        raise repo.not_found("Project")
    region = await repo.create_region(session, ctx, pid, body.name, body.bbox)
    return RegionResponse(region=region)


@router.get("/projects/{project_id}/regions", responses={400: _R400, 401: _R401, 404: _R404})
async def list_regions(
    project_id: str,
    ctx: Context,
    session: Session,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    cursor: str | None = None,
) -> RegionListResponse:
    pid = repo.parse_id(project_id)
    if pid is None:
        raise repo.invalid_id("Project")
    if not await repo.project_exists(session, ctx, pid):
        raise repo.not_found("Project")
    regions, next_cursor = await repo.list_regions(session, ctx, pid, limit, cursor)
    return RegionListResponse(regions=regions, next_cursor=next_cursor)


@router.get("/regions/{region_id}", responses={400: _R400, 401: _R401, 404: _R404})
async def get_region(region_id: str, ctx: Context, session: Session) -> RegionResponse:
    rid = repo.parse_id(region_id)
    if rid is None:
        raise repo.invalid_id("Region")
    region = await repo.get_region(session, ctx, rid)
    if region is None:
        raise repo.not_found("Region")
    return RegionResponse(region=region)


@router.post(
    "/regions/{region_id}/syncs",
    status_code=202,
    responses={400: _R400, 401: _R401, 404: _R404, 409: _R409, 503: _R503},
)
async def start_sync(region_id: str, ctx: Context, session: Session) -> SyncJobResponse:
    rid = repo.parse_id(region_id)
    if rid is None:
        raise repo.invalid_id("Region")
    if await repo.get_region(session, ctx, rid) is None:
        raise repo.not_found("Region")
    job = await repo.create_sync_job(session, ctx, rid)
    try:
        await sync_region.defer_async(sync_job_id=str(job.id))
    except Exception:
        # Otherwise the job would sit queued and block the region until the reaper times it out.
        logger.exception("Could not enqueue sync %s", job.id)
        await fail_job(job.id, "processing_error", "The sync could not be queued.")
        raise ApiError(
            503, "service_unavailable", "The sync could not be queued. Try again shortly."
        ) from None
    return SyncJobResponse(sync_job=job)


@router.get("/syncs/{sync_job_id}", responses={400: _R400, 401: _R401, 404: _R404})
async def get_sync(sync_job_id: str, ctx: Context, session: Session) -> SyncJobResponse:
    jid = repo.parse_id(sync_job_id)
    if jid is None:
        raise repo.invalid_id("Sync job")
    job = await repo.get_sync_job(session, ctx, jid)
    if job is None:
        raise repo.not_found("Sync job")
    return SyncJobResponse(sync_job=job)


@router.get("/regions/{region_id}/syncs", responses={400: _R400, 401: _R401, 404: _R404})
async def list_syncs(
    region_id: str,
    ctx: Context,
    session: Session,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    cursor: str | None = None,
) -> SyncJobListResponse:
    rid = repo.parse_id(region_id)
    if rid is None:
        raise repo.invalid_id("Region")
    if await repo.get_region(session, ctx, rid) is None:
        raise repo.not_found("Region")
    jobs, next_cursor = await repo.list_sync_jobs(session, ctx, rid, limit, cursor)
    return SyncJobListResponse(sync_jobs=jobs, next_cursor=next_cursor)


@router.get("/map-layers/{map_layer_id}", responses={400: _R400, 401: _R401, 404: _R404})
async def get_map_layer(
    map_layer_id: str,
    ctx: Context,
    session: Session,
    property: Annotated[  # noqa: A002 - the public query parameter name (api-contracts.md)
        str | None, Query(description="A pollutant from the layer's property_keys, e.g. pm25.")
    ] = None,
    value: Annotated[str | None, Query(description="A number such as 10 or -3.5.")] = None,
    comparator: Annotated[
        Comparator | None, Query(description="Defaults to = when property is given.")
    ] = None,
) -> MapLayerResponse:
    lid = repo.parse_id(map_layer_id)
    if lid is None:
        raise repo.invalid_id("Map layer")
    layer_filter = parse_filter(property, value, comparator)
    layer = await repo.get_map_layer(session, ctx, lid, layer_filter)
    if layer is None:
        raise repo.not_found("Map layer")
    return layer


@router.get(
    "/places",
    # Needs an identity like every endpoint, so it is not an open proxy to Photon.
    dependencies=[Depends(get_request_context)],
    responses={400: _R400, 401: _R401, 429: _R429, 503: _R503},
)
async def search_places(
    q: Annotated[str, Query(description="A place name, 3 to 100 characters.")],
    search: Annotated[PlaceSearch, Depends(get_place_search)],
) -> PlaceListResponse:
    text = q.strip()
    if not 3 <= len(text) <= 100:
        raise ApiError(400, "validation_failed", "q must be 3 to 100 characters.")
    try:
        places = await search.search(text)
    except RateLimited:
        raise ApiError(
            429, "rate_limited", "Too many searches. Wait a moment and try again."
        ) from None
    except ProviderUnavailable:
        raise ApiError(
            503,
            "service_unavailable",
            "Place search is unavailable right now. Type the coordinates or draw the box instead.",
        ) from None
    return PlaceListResponse(
        places=[
            PlaceOut(
                id=p.id,
                name=p.name,
                detail=p.detail,
                kind=p.kind,
                point=list(p.point),
                bbox=list(p.bbox) if p.bbox else None,
            )
            for p in places
        ]
    )
