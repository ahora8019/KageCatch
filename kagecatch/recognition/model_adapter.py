"""Provider-neutral async boundary for image-based character recognition.

Concrete model providers are injected by the application. This module never
selects a provider, reads credentials, downloads media, or sends images elsewhere.
"""

from __future__ import annotations

import asyncio
import math
from collections.abc import Iterable
from typing import Protocol

from .character_catalog import (
    CharacterRecognitionResult,
    CharacterRecognitionEngine,
    RecognitionCandidate,
)


_SUPPORTED_MEDIA_TYPES = frozenset({
    "image/jpeg",
    "image/png",
    "image/webp",
})
_DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024
_MAX_CONFIGURED_IMAGE_BYTES = 10 * 1024 * 1024
_DEFAULT_MODEL_TIMEOUT_SECONDS = 30.0
_MAX_MODEL_TIMEOUT_SECONDS = 120.0


class CharacterVisionModel(Protocol):
    """Injected model contract; implementations must return ranked candidates."""

    async def predict(
        self, image: bytes, *, media_type: str
    ) -> Iterable[RecognitionCandidate]:
        """Return ranked candidates without performing catch actions."""


class CharacterModelAdapter:
    """Validate image input, call an injected model, then apply local confidence gates."""

    def __init__(
        self,
        engine: CharacterRecognitionEngine,
        model: CharacterVisionModel,
        *,
        max_image_bytes: int = _DEFAULT_MAX_IMAGE_BYTES,
        timeout_seconds: float = _DEFAULT_MODEL_TIMEOUT_SECONDS,
    ) -> None:
        if not isinstance(engine, CharacterRecognitionEngine):
            raise TypeError("engine must be a CharacterRecognitionEngine")
        if not callable(getattr(model, "predict", None)):
            raise TypeError("model must expose async predict(image, media_type=...)")
        if (
            isinstance(max_image_bytes, bool)
            or not isinstance(max_image_bytes, int)
            or not 1 <= max_image_bytes <= _MAX_CONFIGURED_IMAGE_BYTES
        ):
            raise ValueError("max_image_bytes must be an integer from 1 to 10485760")
        timeout_value = None
        if not isinstance(timeout_seconds, bool) and isinstance(
            timeout_seconds, (int, float)
        ):
            try:
                timeout_value = float(timeout_seconds)
            except (OverflowError, TypeError, ValueError):
                timeout_value = None
        if (
            timeout_value is None
            or not math.isfinite(timeout_value)
            or not 0.0 < timeout_value <= _MAX_MODEL_TIMEOUT_SECONDS
        ):
            raise ValueError("timeout_seconds must be finite and from 0 to 120")

        self.engine = engine
        self.model = model
        self.max_image_bytes = max_image_bytes
        self.timeout_seconds = timeout_value

    async def recognize(
        self, image: bytes, *, media_type: str
    ) -> CharacterRecognitionResult:
        if not isinstance(image, bytes) or not image:
            return self._review("invalid_image")
        if len(image) > self.max_image_bytes:
            return self._review("image_too_large")
        if not isinstance(media_type, str) or media_type not in _SUPPORTED_MEDIA_TYPES:
            return self._review("unsupported_media_type")

        try:
            async with asyncio.timeout(self.timeout_seconds):
                candidates = await self.model.predict(image, media_type=media_type)
        except TimeoutError:
            return self._review("model_timeout")
        except Exception:
            # Do not leak provider errors, credentials, or request details.
            return self._review("model_unavailable")

        try:
            result = self.engine.recognize(candidates)
            if getattr(self.model, "requires_human_review", False) and result.status != "review":
                proposed_name = (
                    result.character.canonical_name
                    if result.status == "known" and result.character is not None
                    else result.proposed_name
                )
                return CharacterRecognitionResult(
                    status="review",
                    character=None,
                    confidence=result.confidence,
                    proposed_name=proposed_name,
                    reason="model_requires_human_review",
                )
            return result
        except Exception:
            # Invalid iterables, malformed candidate values, and unbounded
            # candidate lists all fail closed into human review.
            return self._review("invalid_model_output")

    @staticmethod
    def _review(reason: str) -> CharacterRecognitionResult:
        return CharacterRecognitionResult(
            status="review",
            character=None,
            confidence=0.0,
            reason=reason,
        )
