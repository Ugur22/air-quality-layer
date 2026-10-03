.PHONY: up down logs backend-check backend-fix frontend-check frontend-fix check e2e

up:
	docker compose up -d --build

down:
	docker compose down

logs:
	docker compose logs -f api worker

# Tests need the compose database (`make up`); they create and use their own airlayer_test DB.
backend-check:
	cd backend && uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest -q

backend-fix:
	cd backend && uv run ruff check --fix . && uv run ruff format .

frontend-check:
	cd frontend && npm run typecheck && npm run lint && npm run format:check && npm test

frontend-fix:
	cd frontend && npx eslint --fix . && npm run format

check: backend-check frontend-check

# Needs the stack (`make up`); added once the first vertical slice has a flow to exercise.
e2e:
	cd frontend && npx playwright test
