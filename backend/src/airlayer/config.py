from functools import lru_cache
from uuid import UUID

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="AIRLAYER_")

    # Defaults to production so the placeholder identity (ADR 0003) is off unless opted in.
    environment: str = "production"
    database_url: str
    # Required by the worker (ADR 0002); unset is fine for the API process and tests that mock
    # the OpenAQ call.
    openaq_api_key: SecretStr = SecretStr("")
    # Retries after the first run, matching Procrastinate's `max_attempts`; total runs = 1 + this.
    max_sync_retries: int = 3
    openaq_base_url: str = "https://api.openaq.org/v3"
    openaq_timeout_seconds: float = 20.0
    # Place search (ADR 0013): Photon, a public OpenStreetMap geocoder with no key. It asks for
    # fair use, so the app identifies itself and limits its own calls; both are starting values.
    places_base_url: str = "https://photon.komoot.io"
    places_timeout_seconds: float = 5.0
    places_user_agent: str = "AirLayer/0.1 (portfolio project, local development)"
    places_cache_seconds: float = 600.0
    places_max_upstream_per_window: int = 20
    places_window_seconds: float = 10.0
    # After a failure Photon is not asked again for this long.
    places_cooldown_seconds: float = 30.0
    # Starting values from ADR 0010; one sync costs 1 + N OpenAQ calls against a 60/min limit.
    max_stations_per_sync: int = 50
    # A job still queued or processing after this long was abandoned (dead worker, lost enqueue).
    sync_timeout_minutes: int = 10
    # Base of the exponential backoff between retries (2 gives 2s, 4s, 8s); tests set it to 0.
    sync_retry_wait_seconds: int = 2
    # Station history (ADR 0014): fetched from OpenAQ per request, cached in memory this long.
    history_cache_seconds: float = 300.0
    dev_organisation_id: UUID = UUID("00000000-0000-4000-8000-000000000001")
    dev_actor_id: UUID = UUID("00000000-0000-4000-8000-0000000000a1")

    @property
    def sqlalchemy_url(self) -> str:
        return self.database_url.replace("postgresql://", "postgresql+psycopg://", 1)


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]  # database_url comes from the environment
