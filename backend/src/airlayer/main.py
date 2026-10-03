from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI
from fastapi.openapi.utils import get_openapi

from airlayer.errors import install_error_handlers
from airlayer.history import close_history_provider
from airlayer.jobs import app as jobs_app
from airlayer.logs import protect_search_text
from airlayer.places import close_place_search
from airlayer.routes import router


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    protect_search_text()
    try:
        async with jobs_app.open_async():
            yield
    finally:
        await close_place_search()
        await close_history_provider()


app = FastAPI(title="AirLayer API", lifespan=lifespan)
install_error_handlers(app)
app.include_router(router)


def _openapi() -> dict[str, Any]:
    if app.openapi_schema:
        return app.openapi_schema
    schema = get_openapi(title=app.title, version=app.version, routes=app.routes)
    for path in schema["paths"].values():
        for operation in path.values():
            operation["responses"].pop("422", None)
    for unused in ("HTTPValidationError", "ValidationError"):
        schema.get("components", {}).get("schemas", {}).pop(unused, None)
    app.openapi_schema = schema
    return schema


app.openapi = _openapi  # type: ignore[method-assign]
