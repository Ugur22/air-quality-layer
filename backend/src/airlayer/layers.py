"""Map-layer filtering (api-contracts.md section 4)."""

import math
import operator
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

from airlayer.errors import ApiError

Comparator = Literal["=", ">", ">=", "<", "<="]

_COMPARE: dict[str, Callable[[float, float], bool]] = {
    "=": operator.eq,
    ">": operator.gt,
    ">=": operator.ge,
    "<": operator.lt,
    "<=": operator.le,
}
# ASCII digits only and fullmatch: \d would accept other scripts, and `$` would let a trailing
# newline through.
_NUMBER = re.compile(r"-?[0-9]+(\.[0-9]+)?")


@dataclass(frozen=True)
class LayerFilter:
    property: str
    comparator: Comparator
    value: float

    def matches(self, readings: dict[str, Any]) -> bool:
        reading = readings.get(self.property)
        # A station without the property is simply not a match, never an error.
        return reading is not None and _COMPARE[self.comparator](reading["value"], self.value)


def _invalid(message: str) -> ApiError:
    return ApiError(400, "validation_failed", message)


def parse_filter(
    property_: str | None, value: str | None, comparator: Comparator | None
) -> LayerFilter | None:
    if property_ is None and value is None:
        if comparator is not None:
            raise _invalid("comparator needs property and value.")
        return None
    if not property_ or value is None:
        raise _invalid("property and value must be given together.")
    if not _NUMBER.fullmatch(value):
        raise _invalid("value must be a number such as 10 or -3.5.")
    number = float(value)
    if not math.isfinite(number):
        raise _invalid("value is too large.")
    return LayerFilter(property_, comparator or "=", number)
