from httpx import AsyncClient

from airlayer.schemas import RegionCreate


async def test_openapi_documents_the_real_error_responses_not_fastapis_422(
    client: AsyncClient,
) -> None:
    schema = (await client.get("/openapi.json")).json()

    for path, methods in schema["paths"].items():
        for method, operation in methods.items():
            codes = set(operation["responses"])
            assert "422" not in codes, f"{method} {path} still documents 422"
            if path != "/api/v1/health":
                assert {"400", "401"} <= codes, f"{method} {path} must document 400 and 401"
    create = schema["paths"]["/api/v1/projects/{project_id}/regions"]["post"]["responses"]
    assert create["400"]["content"]["application/json"]["schema"]["$ref"].endswith("/ErrorResponse")
    assert "404" in create
    assert "HTTPValidationError" not in schema["components"]["schemas"]


def test_the_swagger_prefilled_region_example_is_a_valid_request() -> None:
    (example,) = RegionCreate.model_json_schema()["examples"]

    RegionCreate.model_validate(example)
