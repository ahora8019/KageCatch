"""Framework-independent value objects shared by KageCatch domains."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal, Mapping

MediaKind = Literal["image", "video"]
VerificationStatus = Literal["verified", "unverified", "pending", "failed"]


def _required_text(value: str, field_name: str, *, max_length: int = 256) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field_name} must be a string")
    normalized = value.strip()
    if not normalized or len(normalized) > max_length:
        raise ValueError(f"{field_name} must be non-empty and at most {max_length} characters")
    if any(ord(char) < 32 for char in normalized):
        raise ValueError(f"{field_name} must not contain control characters")
    return normalized


def _validate_media_kind(value: str) -> None:
    if value not in ("image", "video"):
        raise ValueError("media_kind must be 'image' or 'video'")


@dataclass(frozen=True, slots=True)
class TargetDefinition:
    """Canonical identity and command configuration for one target bot."""

    source_id: str
    bot_username: str
    media_kind: MediaKind
    command_prefix: str
    enabled: bool = False

    def __post_init__(self) -> None:
        object.__setattr__(self, "source_id", _required_text(self.source_id, "source_id", max_length=64))
        username = _required_text(self.bot_username, "bot_username", max_length=64).lstrip("@")
        if not username or any(char.isspace() for char in username):
            raise ValueError("bot_username must be a valid non-empty username")
        object.__setattr__(self, "bot_username", username)
        _validate_media_kind(self.media_kind)
        command = _required_text(self.command_prefix, "command_prefix", max_length=32)
        if not command.startswith("/") or any(char.isspace() for char in command):
            raise ValueError("command_prefix must start with '/' and contain no whitespace")
        object.__setattr__(self, "command_prefix", command)
        if not isinstance(self.enabled, bool):
            raise ValueError("enabled must be a boolean")


@dataclass(frozen=True, slots=True)
class SpawnEnvelope:
    """User-scoped, normalized reference to a Telegram spawn event."""

    user_id: str
    source_id: str
    chat_id: int
    message_id: int
    media_kind: MediaKind
    occurred_at: datetime
    payload_ref: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "user_id", _required_text(self.user_id, "user_id", max_length=128))
        object.__setattr__(self, "source_id", _required_text(self.source_id, "source_id", max_length=64))
        if isinstance(self.chat_id, bool) or not isinstance(self.chat_id, int) or self.chat_id == 0:
            raise ValueError("chat_id must be a non-zero integer")
        if isinstance(self.message_id, bool) or not isinstance(self.message_id, int) or self.message_id <= 0:
            raise ValueError("message_id must be a positive integer")
        _validate_media_kind(self.media_kind)
        if not isinstance(self.occurred_at, datetime) or self.occurred_at.tzinfo is None:
            raise ValueError("occurred_at must be a timezone-aware datetime")
        if self.payload_ref is not None:
            object.__setattr__(self, "payload_ref", _required_text(self.payload_ref, "payload_ref", max_length=512))


@dataclass(frozen=True, slots=True)
class RecognitionCandidate:
    """A single character hypothesis; confidence is character-level confidence."""

    name: str
    confidence: float
    evidence: Mapping[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "name", _required_text(self.name, "name", max_length=100))
        confidence = self.confidence
        if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
            raise ValueError("confidence must be a finite number between 0 and 1")
        if not math.isfinite(confidence) or not 0.0 <= confidence <= 1.0:
            raise ValueError("confidence must be a finite number between 0 and 1")
        object.__setattr__(self, "confidence", float(confidence))
        if not isinstance(self.evidence, Mapping):
            raise ValueError("evidence must be a mapping")


@dataclass(frozen=True, slots=True)
class RecognitionResult:
    """Recognition output with anime-scene similarity kept separate from character confidence."""

    source: str
    candidates: tuple[RecognitionCandidate, ...]
    anime_name: str | None = None
    anime_similarity: float | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "source", _required_text(self.source, "source", max_length=64))
        candidates = tuple(self.candidates)
        if any(not isinstance(item, RecognitionCandidate) for item in candidates):
            raise ValueError("candidates must contain RecognitionCandidate values")
        object.__setattr__(self, "candidates", candidates)
        if self.anime_name is not None:
            object.__setattr__(self, "anime_name", _required_text(self.anime_name, "anime_name", max_length=256))
        if self.anime_similarity is not None:
            value = self.anime_similarity
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError("anime_similarity must be a finite number between 0 and 1")
            if not math.isfinite(value) or not 0.0 <= value <= 1.0:
                raise ValueError("anime_similarity must be a finite number between 0 and 1")
            object.__setattr__(self, "anime_similarity", float(value))


@dataclass(frozen=True, slots=True)
class CatchReceipt:
    """Identifier for an outbound catch attempt, not proof of success."""

    reference: str
    character_name: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "reference", _required_text(self.reference, "reference", max_length=512))
        object.__setattr__(self, "character_name", _required_text(self.character_name, "character_name", max_length=100))


@dataclass(frozen=True, slots=True)
class VerificationResult:
    """Explicit verification outcome; a verified result must cite evidence."""

    status: VerificationStatus
    evidence_reference: str | None = None
    reason: str | None = None

    def __post_init__(self) -> None:
        if self.status not in ("verified", "unverified", "pending", "failed"):
            raise ValueError("unsupported verification status")
        if self.evidence_reference is not None:
            object.__setattr__(
                self, "evidence_reference",
                _required_text(self.evidence_reference, "evidence_reference", max_length=512),
            )
        if self.reason is not None:
            object.__setattr__(self, "reason", _required_text(self.reason, "reason", max_length=256))
        if self.status == "verified" and self.evidence_reference is None:
            raise ValueError("verified results require evidence_reference")
