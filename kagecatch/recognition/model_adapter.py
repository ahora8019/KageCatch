"""Provider-neutral async boundary for image-based character recognition.

Concrete model providers are injected by the application. This module never
selects a provider, reads credentials, downloads media, or sends images elsewhere.
"""

from __future__ import annotations

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

        self.engine = engine
        self.model = model
        self.max_image_bytes = max_image_bytes

    async def recognize(
        self, image: bytes, *, media_type: str
    ) -> CharacterRecognitionResult:
        if not isinstance(image, bytes) or not image:
            return self._review("invalid_image")
        if len(image) > self.max_image_bytes:
            return self._review("image_too_large")
        if media_type not in _SUPPORTED_MEDIA_TYPES:
            return self._review("unsupported_media_type")

        try:
            candidates = await self.model.predict(image, media_type=media_type)
        except Exception:
            # Do not leak provider errors, credentials, or request details.
            return self._review("model_unavailable")

        try:
            return self.engine.recognize(candidates)
        except (TypeError, ValueError):
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
