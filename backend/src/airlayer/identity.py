from dataclasses import dataclass
from typing import Annotated
from uuid import UUID

from fastapi import Depends, Header

from airlayer.config import Settings, get_settings
from airlayer.errors import ApiError


@dataclass(frozen=True)
class RequestContext:
    organisation_id: UUID
    actor_id: UUID


async def get_request_context(
    settings: Annotated[Settings, Depends(get_settings)],
    x_dev_organisation_id: Annotated[
        str | None,
        Header(description="Development only: act as another organisation (ADR 0003)."),
    ] = None,
) -> RequestContext:
    """The single place identity is resolved (ADR 0003); real authentication replaces it later."""
    if settings.environment != "development":
        raise ApiError(401, "unauthorized", "Authentication is required.")
    organisation_id = settings.dev_organisation_id
    if x_dev_organisation_id is not None:
        try:
            organisation_id = UUID(x_dev_organisation_id)
        except ValueError:
            raise ApiError(
                400, "validation_failed", "X-Dev-Organisation-Id must be a UUID."
            ) from None
    return RequestContext(organisation_id=organisation_id, actor_id=settings.dev_actor_id)
