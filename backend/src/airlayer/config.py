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
    # Luchtmeetnet (ADR 0017): no key, fair use, 100 calls per 5 minutes.
    luchtmeetnet_base_url: str = "https://api.luchtmeetnet.nl/open_api"
    luchtmeetnet_timeout_seconds: float = 20.0
    # All Luchtmeetnet calls of one sync together; past it the sync goes on without them. Added to
    # OpenAQ's half of the sync timeout this stays under the whole timeout (ADR 0017).
    luchtmeetnet_budget_seconds: float = 120.0
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
    # National layers (ADR 0018, 0019): one pass over all countries is a few hundred paced calls an
    # hour, so it has its own caps and budgets. Starting values. The cap is per country: France had
    # more than 1000 OpenAQ locations when measured, the Netherlands 273.
    max_stations_national: int = 3000
    # The newest succeeded refreshes kept per country; older ones are deleted (ADR 0019).
    national_refreshes_kept: int = 3
    # OpenAQ allows 60 calls a minute and the history endpoint shares the key, so a little under it.
    national_openaq_interval_seconds: float = 1.2
    # One 5xx in hundreds of calls must not fail every country for the hour (ADR 0019): a call is
    # retried this many times, waiting 2, 4, 8 seconds, or what the rate limit says.
    national_openaq_retries: int = 3
    national_openaq_retry_wait_seconds: float = 2.0
    # All upstream calls of one refresh; past it the refresh is failed and the old layer stays.
    national_refresh_budget_seconds: float = 1500.0
    national_luchtmeetnet_budget_seconds: float = 900.0
    # A refresh still processing after this long was abandoned (dead worker).
    national_refresh_timeout_minutes: int = 40
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
