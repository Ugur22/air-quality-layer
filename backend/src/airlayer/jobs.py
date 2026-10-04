from uuid import UUID

import procrastinate
from procrastinate import JobContext, RetryStrategy

from airlayer.config import get_settings
from airlayer.national import run_refresh
from airlayer.openaq import TransientUpstreamError
from airlayer.sync import reap_stale_jobs, run_sync

settings = get_settings()

app = procrastinate.App(
    connector=procrastinate.PsycopgConnector(conninfo=settings.database_url),
    import_paths=["airlayer.jobs"],
)


# Only transient OpenAQ failures are retried (ADR 0002). `max_attempts` counts retries, so a job
# runs at most 1 + max_sync_retries times; run_sync fails the sync job itself on the last run.
@app.task(
    name="sync_region",
    pass_context=True,
    retry=RetryStrategy(
        max_attempts=settings.max_sync_retries,
        exponential_wait=settings.sync_retry_wait_seconds,
        retry_exceptions=[TransientUpstreamError],
    ),
)
async def sync_region(context: JobContext, sync_job_id: str) -> None:
    await run_sync(
        UUID(sync_job_id), final_attempt=context.job.attempts >= settings.max_sync_retries
    )


@app.periodic(cron="* * * * *")
@app.task(name="reap_stale_sync_jobs")
async def reap_stale_sync_jobs(timestamp: int) -> None:
    await reap_stale_jobs()


# Hourly, a few minutes past, since both sources publish on the hour (ADR 0018). The queueing lock
# only stops a second refresh from being queued; two running at once are refused by the database.
@app.periodic(cron="7 * * * *")
@app.task(name="refresh_national", queue="national", queueing_lock="refresh_national")
async def refresh_national(timestamp: int) -> None:
    await run_refresh()
