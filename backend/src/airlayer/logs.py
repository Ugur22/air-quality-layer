import logging
import re

# What a person typed into place search is theirs; it must not end up in log files.
_SEARCH_TEXT = re.compile(r"(/api/v1/places\?(?:[^ ]*&)?q=)[^& ]*")


class RedactSearchText(logging.Filter):
    """For uvicorn's access log, which writes the whole request URL."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple):
            record.args = tuple(
                _SEARCH_TEXT.sub(r"\1[redacted]", a) if isinstance(a, str) else a
                for a in record.args
            )
        return True


def protect_search_text() -> None:
    logging.getLogger("uvicorn.access").addFilter(RedactSearchText())
    # httpx logs every request URL at INFO, query included.
    for name in ("httpx", "httpcore"):
        logging.getLogger(name).setLevel(logging.WARNING)
