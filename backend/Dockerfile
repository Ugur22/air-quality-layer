FROM python:3.13-slim

COPY --from=ghcr.io/astral-sh/uv:0.9.17 /uv /usr/local/bin/uv

# The venv lives outside /app so the bind-mounted source in compose cannot hide it.
ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_LINK_MODE=copy \
    PATH="/opt/venv/bin:$PATH" \
    PYTHONPATH=/app/src \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project

COPY alembic.ini ./
COPY alembic ./alembic
COPY src ./src
