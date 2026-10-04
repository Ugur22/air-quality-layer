from datetime import datetime
from typing import Annotated, Any, Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

# Starting values from ADR 0010; tunable without a new ADR.
MAX_BBOX_SPAN_DEGREES = 2.0
# Coordinates carry 4 decimals, and 145.7473 - 143.7473 is 2.0000000000000284 in floating point:
# the limit must not reject a box that is exactly 2 degrees wide because of that noise.
SPAN_TOLERANCE = 1e-9

# strict: JSON numbers only, so "4.85" and true are rejected instead of silently converted.
Coordinate = Annotated[float, Field(allow_inf_nan=False, strict=True)]


class RegionCreate(BaseModel):
    # Swagger prefills its request body from this, so it must be a valid request.
    model_config = ConfigDict(
        json_schema_extra={"examples": [{"name": "Amsterdam", "bbox": [4.85, 52.35, 4.95, 52.40]}]}
    )

    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
    bbox: Annotated[list[Coordinate], Field(min_length=4, max_length=4)]

    @model_validator(mode="after")
    def bbox_is_a_usable_box(self) -> Self:
        min_lon, min_lat, max_lon, max_lat = self.bbox
        if not (-180 <= min_lon <= 180 and -180 <= max_lon <= 180):
            raise ValueError("bbox longitudes must be within -180 and 180")
        if not (-90 <= min_lat <= 90 and -90 <= max_lat <= 90):
            raise ValueError("bbox latitudes must be within -90 and 90")
        # Strict: a zero-area box has no stations to find, and a min above max is how a box
        # crossing the antimeridian would arrive, which is not supported (api-contracts.md).
        if min_lon >= max_lon or min_lat >= max_lat:
            raise ValueError("bbox must be [min_lon, min_lat, max_lon, max_lat] with min < max")
        limit = MAX_BBOX_SPAN_DEGREES + SPAN_TOLERANCE
        if max_lon - min_lon > limit or max_lat - min_lat > limit:
            raise ValueError(f"bbox may span at most {MAX_BBOX_SPAN_DEGREES} degrees per side")
        return self


class RegionOut(BaseModel):
    id: UUID
    project_id: UUID
    name: str
    bbox: list[float]
    created_at: datetime


class RegionResponse(BaseModel):
    region: RegionOut


class RegionListResponse(BaseModel):
    regions: list[RegionOut]
    next_cursor: str | None


class ProjectOut(BaseModel):
    id: UUID
    name: str


class ProjectListResponse(BaseModel):
    projects: list[ProjectOut]


class ErrorDetail(BaseModel):
    code: str
    message: str
    details: list[Any]


class ErrorResponse(BaseModel):
    error: ErrorDetail


class SyncError(BaseModel):
    code: str
    message: str


class SyncJobOut(BaseModel):
    id: UUID
    region_id: UUID
    # A plain string, not an enum: clients must cope with values added later (api-contracts.md).
    status: str
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    station_count: int | None
    # The layer is derived from the sync job, so its id is the job's id (ADR 0010).
    map_layer_id: UUID | None
    errors: list[SyncError]
    # Only on a succeeded job that is missing part of its data (ADR 0017).
    warnings: list[SyncError]


class SyncJobResponse(BaseModel):
    sync_job: SyncJobOut


class ReadingOut(BaseModel):
    value: float
    unit: str
    observed_at: datetime
    # A layer stored before a second source existed has no source on its readings (ADR 0017).
    source: str = "openaq"


class StationProperties(BaseModel):
    name: str
    sources: list[str]
    readings: dict[str, ReadingOut]


class PointGeometry(BaseModel):
    type: Literal["Point"] = "Point"
    # [longitude, latitude] (api-contracts.md)
    coordinates: list[float]


class StationFeature(BaseModel):
    type: Literal["Feature"] = "Feature"
    # The stored reading's own id: identical in filtered and unfiltered responses.
    id: UUID
    geometry: PointGeometry
    properties: StationProperties


class StationCollection(BaseModel):
    type: Literal["FeatureCollection"] = "FeatureCollection"
    features: list[StationFeature]


class MapLayerOut(BaseModel):
    # The sync job's id; the layer is derived from the job (ADR 0010).
    id: UUID
    region_id: UUID
    # station_count and property_keys describe the whole layer, not the filtered subset.
    station_count: int
    bbox: list[float]
    property_keys: list[str]


class MapLayerResponse(BaseModel):
    map_layer: MapLayerOut
    stations: StationCollection


class NationalLayerOut(BaseModel):
    """The layer of a country's newest national refresh (ADR 0018, 0019): no region, a country and
    a refresh time."""

    id: UUID
    region_id: None = None
    country: str
    refreshed_at: datetime
    station_count: int
    bbox: list[float]
    property_keys: list[str]


class NationalLayerResponse(BaseModel):
    map_layer: NationalLayerOut
    stations: StationCollection


class CountryOut(BaseModel):
    code: str
    name: str
    bbox: list[float]
    refreshed_at: datetime | None
    station_count: int | None


class CountryListResponse(BaseModel):
    countries: list[CountryOut]


class SyncJobListResponse(BaseModel):
    sync_jobs: list[SyncJobOut]
    next_cursor: str | None


class PlaceOut(BaseModel):
    id: str
    name: str
    detail: str
    kind: str
    point: list[float]
    # A box that is already a valid region, or null when the place is too large to be one.
    bbox: list[float] | None


class PlaceListResponse(BaseModel):
    places: list[PlaceOut]


class HistoryPointOut(BaseModel):
    # The end of the hour the value covers (OpenAQ period.datetimeTo), UTC.
    at: datetime
    value: float


class HistoryOut(BaseModel):
    property: str
    # None only when the station has no sensor for the property.
    unit: str | None
    interval: Literal["hour"] = "hour"
    # The window asked for: `to` is when the answer was made.
    from_: datetime = Field(serialization_alias="from")
    to: datetime
    points: list[HistoryPointOut]


class HistoryResponse(BaseModel):
    history: HistoryOut
