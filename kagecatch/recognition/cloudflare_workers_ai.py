"""Cloudflare Workers AI vision provider, intentionally review-only.

This provider proposes a character name from an image but does not emit a
calibrated probability. CharacterModelAdapter therefore always downgrades its
results to human review, even if the local catalog recognizes the proposed name.
"""

from __future__ import annotations

import base64
import json
import re
from typing import Any

import httpx

from .character_catalog import RecognitionCandidate


_MODEL_ID = "@cf/meta/llama-4-scout-17b-16e-instruct"
_SUPPORTED_MEDIA_TYPES = frozenset({"image/jpeg", "image/png", "image/webp"})
_MAX_IMAGE_BYTES = 5 * 1024 * 1024
_MAX_RESPONSE_BYTES = 64 * 1024

_PROMPT = (
    "Identify the most clearly visible named anime character in this image. "
    "Return a name only when you can identify the character from visual evidence. "
    "Do not infer a name from an anime series, genre, watermark, or surrounding text. "
    "If no single character can be identified confidently, return null. "
    'Return exactly the required JSON object: {"character_name": string or null}.'
)

_RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "character_name": {"type": ["string", "null"]},
    },
    "required": ["character_name"],
    "additionalProperties": False,
}


class VisionModelProviderError(RuntimeError):
    """Raised when the remote vision provider fails or returns invalid output."""


class CloudflareWorkersAIVisionModel:
    """Call Cloudflare's hosted vision model for review-only name suggestions.

    The caller supplies account credentials explicitly. This class never reads
    environment variables, persists credentials, or sends images unless its
    predict method is called by an explicitly configured application.
    """

    requires_human_review = True

    def __init__(
        self,
        account_id: str,
        api_token: str,
        *,
        client: httpx.AsyncClient | None = None,
        timeout: float = 20.0,
        max_image_bytes: int = _MAX_IMAGE_BYTES,
    ) -> None:
        if not isinstance(account_id, str) or not re.fullmatch(
            r"[A-Fa-f0-9]{32}", account_id
        ):
            raise ValueError("account_id must be a 32-character Cloudflare account ID")
        if (
            not isinstance(api_token, str)
            or not api_token.strip()
            or api_token != api_token.strip()
            or any(char in api_token for char in "\r\n")
        ):
            raise ValueError("api_token must be a non-empty single-line string")
        if (
            isinstance(timeout, bool)
            or not isinstance(timeout, (int, float))
            or timeout <= 0
        ):
            raise ValueError("timeout must be positive")
        if (
            isinstance(max_image_bytes, bool)
            or not isinstance(max_image_bytes, int)
            or not 1 <= max_image_bytes <= _MAX_IMAGE_BYTES
        ):
            raise ValueError("max_image_bytes must be from 1 to 5242880")

        self._url = (
            "https://api.cloudflare.com/client/v4/accounts/"
            f"{account_id}/ai/run/{_MODEL_ID}"
        )
        self._api_token = api_token
        self._max_image_bytes = max_image_bytes
        self._client = client or httpx.AsyncClient(
            timeout=httpx.Timeout(float(timeout), connect=min(float(timeout), 5.0)),
            follow_redirects=False,
        )
        self._owns_client = client is None

    async def predict(
        self, image: bytes, *, media_type: str
    ) -> list[RecognitionCandidate]:
        if not isinstance(image, bytes) or not image:
            raise ValueError("image must be non-empty bytes")
        if len(image) > self._max_image_bytes:
            raise ValueError("image exceeds the configured byte limit")
        if not isinstance(media_type, str) or media_type not in _SUPPORTED_MEDIA_TYPES:
            raise ValueError("unsupported image media type")

        image_data = base64.b64encode(image).decode("ascii")
        payload: dict[str, Any] = {
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": _PROMPT},
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:{media_type};base64,{image_data}"
                        },
                    },
                ],
            }],
            "guided_json": _RESPONSE_SCHEMA,
            "temperature": 0,
            "max_tokens": 64,
        }

        response_body = bytearray()
        try:
            async with self._client.stream(
                "POST",
                self._url,
                json=payload,
                headers={"Authorization": f"Bearer {self._api_token}"},
            ) as response:
                response.raise_for_status()
                async for chunk in response.aiter_bytes(chunk_size=8192):
                    if len(response_body) + len(chunk) > _MAX_RESPONSE_BYTES:
                        raise VisionModelProviderError(
                            "Cloudflare vision response exceeded its size limit"
                        )
                    response_body.extend(chunk)
        except VisionModelProviderError:
            raise
        except httpx.HTTPError as exc:
            # Never include request headers, token values, or raw provider bodies.
            raise VisionModelProviderError("Cloudflare Workers AI request failed") from exc

        try:
            data = json.loads(response_body)
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise VisionModelProviderError(
                "Cloudflare Workers AI returned an invalid response envelope"
            ) from exc

        if not isinstance(data, dict) or data.get("success") is not True:
            raise VisionModelProviderError("Cloudflare Workers AI reported an unsuccessful inference")
        result = data.get("result")
        raw_output = result.get("response") if isinstance(result, dict) else None
        if not isinstance(raw_output, str):
            raise VisionModelProviderError("Cloudflare vision response has an invalid schema")

        try:
            parsed = json.loads(raw_output)
        except json.JSONDecodeError as exc:
            raise VisionModelProviderError("Cloudflare vision returned invalid JSON") from exc

        if not isinstance(parsed, dict) or set(parsed) != {"character_name"}:
            raise VisionModelProviderError("Cloudflare vision returned an invalid candidate object")

        name = parsed["character_name"]
        if name is None:
            return []
        if not isinstance(name, str):
            raise VisionModelProviderError("Cloudflare vision returned an invalid character name")

        name = name.strip()
        if (
            not name
            or len(name) > 100
            or any(ord(char) < 32 or 127 <= ord(char) < 160 for char in name)
        ):
            raise VisionModelProviderError("Cloudflare vision returned an invalid character name")

        # This is deliberately not a model confidence. The adapter enforces
        # human review for this provider regardless of the local threshold.
        return [RecognitionCandidate(name=name, confidence=0.5)]

    async def close(self) -> None:
        if self._owns_client:
            await self._client.aclose()
