"""Provider-neutral, bounded visual recognition boundary for spawn images.

This module never downloads Telegram media and never chooses a character
automatically. Callers must supply image bytes from an approved media adapter.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Protocol

from .models.spawn import CharacterMetadata


class VisualRecognitionClient(Protocol):
    async def recognize(self, image: bytes) -> Mapping[str, Any]: ...


class VisualRecognitionError(RuntimeError):
    """Raised when a visual recognition provider cannot return safe metadata."""


class VisualRecognitionResolver:
    def __init__(
        self,
        client: VisualRecognitionClient,
        *,
        max_image_bytes: int = 8 * 1024 * 1024,
        max_candidates: int = 5,
    ) -> None:
        if isinstance(max_image_bytes, bool) or not isinstance(max_image_bytes, int) or max_image_bytes <= 0:
            raise ValueError("max_image_bytes must be a positive integer")
        if isinstance(max_candidates, bool) or not isinstance(max_candidates, int) or not 1 <= max_candidates <= 10:
            raise ValueError("max_candidates must be between 1 and 10")
        self.client = client
        self.max_image_bytes = max_image_bytes
        self.max_candidates = max_candidates

    async def resolve(self, image: bytes) -> CharacterMetadata:
        if not isinstance(image, (bytes, bytearray)) or not image:
            raise ValueError("image must contain bytes")
        if len(image) > self.max_image_bytes:
            raise ValueError("image exceeds the configured size limit")
        try:
            payload = await self.client.recognize(bytes(image))
        except Exception as exc:
            raise VisualRecognitionError("visual recognition failed") from exc
        if not isinstance(payload, Mapping):
            raise VisualRecognitionError("visual recognition returned an invalid response")

        anime_name = payload.get("anime_name")
        if not isinstance(anime_name, str) or not anime_name.strip():
            anime_name = None
        else:
            anime_name = anime_name.strip()[:200]

        anime_confidence = self._confidence(payload.get("anime_confidence"))
        raw_candidates = payload.get("character_candidates", [])
        if not isinstance(raw_candidates, (list, tuple)):
            raise ValueError("character_candidates must be a list")

        candidates: list[tuple[str, float]] = []
        seen: set[str] = set()
        for candidate in raw_candidates:
            if not isinstance(candidate, Mapping):
                continue
            name = candidate.get("name")
            confidence = self._confidence(candidate.get("confidence"))
            if not isinstance(name, str):
                continue
            name = name.strip()
            if not name or len(name) > 120 or confidence is None:
                continue
            key = name.casefold()
            if key in seen:
                continue
            seen.add(key)
            candidates.append((name, confidence))
            if len(candidates) >= self.max_candidates:
                break

        return CharacterMetadata(
            anime_name=anime_name,
            source="visual_recognition",
            character_name=None,
            anime_confidence=anime_confidence,
            character_confidence=0.0,
            additional={"character_candidates": tuple(candidates)},
        )

    @staticmethod
    def _confidence(value: Any) -> float | None:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        if not 0.0 <= float(value) <= 1.0:
            return None
        return float(value)
