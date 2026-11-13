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
class SpawnContext:
    """Minimal trusted Telegram origin metadata needed by the execution adapter."""

    source: str
    chat_id: int
    message_id: int
    media_kind: str

    def __post_init__(self) -> None:
        if not isinstance(self.source, str) or not self.source or len(self.source) > 80:
            raise ValueError("source must contain 1 to 80 characters")
        if isinstance(self.chat_id, bool) or not isinstance(self.chat_id, int) or abs(self.chat_id) > (2**53 - 1):
            raise ValueError("chat_id must be a safe integer")
        if isinstance(self.message_id, bool) or not isinstance(self.message_id, int) or not 0 <= self.message_id <= (2**53 - 1):
            raise ValueError("message_id must be a non-negative safe integer")
        if self.media_kind not in {"photo", "video", "document", "animation", "audio"}:
            raise ValueError("unsupported media_kind")


@dataclass(frozen=True, slots=True)
class SpawnEvent:
    """Normalized spawn candidate emitted by a target adapter."""

    message_id: int
    character_name: str | None
    confidence_score: float
    metadata: CharacterMetadata
    target_name: str
    timestamp: datetime | None = None
    spawn_context: SpawnContext | None = None
