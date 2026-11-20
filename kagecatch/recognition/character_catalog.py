"""Local character catalog and confidence-gated recognition decisions.

The catalog is deliberately independent of any vision model or Telegram client.
A model adapter can provide ranked name candidates; this module only resolves
those candidates against trusted local records and fails closed on uncertainty.
"""

from __future__ import annotations

import math
import unicodedata
from dataclasses import dataclass
from itertools import islice
from typing import Iterable, Literal


def _normalize_name(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value)
    return " ".join(normalized.casefold().split())


@dataclass(frozen=True, slots=True)
class CharacterRecord:
    character_id: str
    canonical_name: str
    anime_name: str
    aliases: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        for field_name in ("character_id", "canonical_name", "anime_name"):
            value = getattr(self, field_name)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"{field_name} must be a non-empty string")
        if not isinstance(self.aliases, tuple) or any(
            not isinstance(alias, str) or not alias.strip() for alias in self.aliases
        ):
            raise ValueError("aliases must be a tuple of non-empty strings")


@dataclass(frozen=True, slots=True)
class RecognitionCandidate:
    name: str
    confidence: float

    def __post_init__(self) -> None:
        if not isinstance(self.name, str) or not self.name.strip():
            raise ValueError("candidate name must be a non-empty string")
        if (
            isinstance(self.confidence, bool)
            or not isinstance(self.confidence, (int, float))
            or not math.isfinite(float(self.confidence))
            or not 0.0 <= float(self.confidence) <= 1.0
        ):
            raise ValueError("candidate confidence must be a finite number from 0 to 1")


@dataclass(frozen=True, slots=True)
class CharacterRecognitionResult:
    status: Literal["known", "unknown", "review"]
    character: CharacterRecord | None
    confidence: float
    proposed_name: str | None = None
    reason: str | None = None


class CharacterCatalog:
    """Immutable-in-practice alias index for trusted, locally known characters."""

    def __init__(self, records: Iterable[CharacterRecord] = ()) -> None:
        self._records: dict[str, CharacterRecord] = {}
        self._aliases: dict[str, CharacterRecord] = {}
        for record in records:
            self.add(record)

    def add(self, record: CharacterRecord) -> None:
        if not isinstance(record, CharacterRecord):
            raise TypeError("record must be a CharacterRecord")
        if record.character_id in self._records:
            raise ValueError(f"duplicate character_id: {record.character_id}")

        names = (record.canonical_name, *record.aliases)
        normalized_names = [_normalize_name(name) for name in names]
        if any(not name for name in normalized_names):
            raise ValueError("character names and aliases must not normalize to empty")
        if len(set(normalized_names)) != len(normalized_names):
            raise ValueError("a character cannot repeat the same name or alias")
        collisions = [name for name in normalized_names if name in self._aliases]
        if collisions:
            raise ValueError(f"character alias already exists: {collisions[0]}")

        self._records[record.character_id] = record
        for name in normalized_names:
            self._aliases[name] = record

    def resolve(self, name: str) -> CharacterRecord | None:
        if not isinstance(name, str):
            return None
        return self._aliases.get(_normalize_name(name))

    def get(self, character_id: str) -> CharacterRecord | None:
        return self._records.get(character_id)

    def __len__(self) -> int:
        return len(self._records)


class CharacterRecognitionEngine:
    """Resolve ranked model labels without inventing identities."""

    def __init__(
        self,
        catalog: CharacterCatalog,
        *,
        confidence_threshold: float = 0.85,
        min_margin: float = 0.08,
        max_candidates: int = 20,
    ) -> None:
        if not isinstance(catalog, CharacterCatalog):
            raise TypeError("catalog must be a CharacterCatalog")
        for name, value in (
            ("confidence_threshold", confidence_threshold),
            ("min_margin", min_margin),
        ):
            if (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(float(value))
                or not 0.0 <= float(value) <= 1.0
            ):
                raise ValueError(f"{name} must be a finite number from 0 to 1")
        if isinstance(max_candidates, bool) or not isinstance(max_candidates, int) or not 1 <= max_candidates <= 100:
            raise ValueError("max_candidates must be an integer from 1 to 100")
        self.catalog = catalog
        self.confidence_threshold = float(confidence_threshold)
        self.min_margin = float(min_margin)
        self.max_candidates = max_candidates

    def recognize(
        self, candidates: Iterable[RecognitionCandidate]
    ) -> CharacterRecognitionResult:
        # Consume at most one item beyond the configured cap so an untrusted or
        # accidental infinite candidate stream cannot exhaust memory.
        ranked = list(islice(iter(candidates), self.max_candidates + 1))
        if len(ranked) > self.max_candidates:
            raise ValueError(f"recognition accepts at most {self.max_candidates} candidates")
        if any(not isinstance(item, RecognitionCandidate) for item in ranked):
            raise TypeError("candidates must contain RecognitionCandidate values")
        if not ranked:
            return CharacterRecognitionResult(
                status="review", character=None, confidence=0.0,
                reason="no_candidate",
            )

        ranked.sort(key=lambda item: item.confidence, reverse=True)

        # Multiple labels/aliases can refer to the same catalog entry. They are
        # corroborating labels, not competing identity hypotheses.
        distinct: list[tuple[RecognitionCandidate, CharacterRecord | None]] = []
        seen: set[tuple[str, str]] = set()
        for item in ranked:
            record = self.catalog.resolve(item.name)
            identity = (
                ("known", record.character_id)
                if record is not None
                else ("unknown", _normalize_name(item.name))
            )
            if identity in seen:
                continue
            seen.add(identity)
            distinct.append((item, record))

        top, record = distinct[0]
        second = distinct[1][0] if len(distinct) > 1 else None
        if second is not None and top.confidence - second.confidence < self.min_margin:
            return CharacterRecognitionResult(
                status="review", character=None, confidence=top.confidence,
                proposed_name=top.name, reason="ambiguous_candidates",
            )

        if top.confidence < self.confidence_threshold:
            return CharacterRecognitionResult(
                status="review", character=None, confidence=top.confidence,
                proposed_name=top.name, reason="low_confidence",
            )

        if record is None:
            return CharacterRecognitionResult(
                status="unknown", character=None, confidence=top.confidence,
                proposed_name=top.name, reason="not_in_catalog",
            )

        return CharacterRecognitionResult(
            status="known", character=record, confidence=top.confidence,
        )
