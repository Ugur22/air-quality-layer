import logging

from airlayer.logs import RedactSearchText


def record(path: str) -> logging.LogRecord:
    return logging.LogRecord(
        "uvicorn.access",
        logging.INFO,
        __file__,
        1,
        '%s - "%s %s HTTP/%s" %d',
        ("127.0.0.1:5000", "GET", path, "1.1", 200),
        None,
    )


def test_the_search_text_of_a_place_search_is_not_written_to_the_access_log() -> None:
    r = record("/api/v1/places?q=my%20secret%20street&limit=3")

    assert RedactSearchText().filter(r) is True
    assert "secret" not in r.getMessage()
    assert "/api/v1/places?q=[redacted]&limit=3" in r.getMessage()


def test_other_requests_are_logged_as_they_are() -> None:
    r = record("/api/v1/projects?limit=3&q=keep")

    RedactSearchText().filter(r)

    assert "/api/v1/projects?limit=3&q=keep" in r.getMessage()


def test_a_log_record_with_unexpected_arguments_is_left_alone() -> None:
    r = logging.LogRecord("x", logging.INFO, __file__, 1, "plain message", None, None)

    assert RedactSearchText().filter(r) is True
    assert r.getMessage() == "plain message"
