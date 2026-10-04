"""Runs one national refresh now (ADR 0018): `python -m airlayer.refresh_national`.

The hourly task does this on a schedule; this is for the first fill and for trying it by hand."""

import asyncio

from airlayer.national import run_refresh


def main() -> None:
    asyncio.run(run_refresh())


if __name__ == "__main__":
    main()
