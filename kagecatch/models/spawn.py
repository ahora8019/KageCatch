"""Framework-independent spawn recognition models."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any


@dataclass(frozen=True, slots=True)
class CharacterMetadata:
    """Recognition metadata; anime similarity is not character confidence."""

    anime_name: str | None
    source: str
    character_name: str | None = None
    episode: int | float | str | None = None
    similarity: float | None = None
    anime_confidence: float | None = None
    character_confidence: float = 0.0
    additional: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class SpawnEvent:
    """Normalized spawn candidate emitted by a target adapter."""

    message_id: int
    character_name: str | None
    confidence_score: float
    metadata: CharacterMetadata
    target_name: str
    timestamp: datetime | None = None
