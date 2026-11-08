"""SenpaiCatcher video-spawn recognition using trace.moe scene matching.

trace.moe identifies anime scenes. Its response is not treated as a character
recognition result; character_name therefore remains None unless a future,
separately validated character recognizer is integrated.
"""

from __future__ import annotations

import asyncio
import shutil
from typing import Any, Mapping, Protocol

from ..models.spawn import CharacterMetadata
from .base import BaseTargetAdapter

SPAWN_PHRASE = "A New Character Has Appeared!"
TRACE_MOE_URL = "https://api.trace.moe/search"


class MetadataLookupError(RuntimeError):
    """Raised when frame extraction or trace.moe lookup cannot be completed."""


class FrameExtractor(Protocol):
    async def extract_first_frame(self, event: Any) -> bytes: ...


class TraceMoeClient(Protocol):
    async def search(self, image: bytes) -> Mapping[str, Any]: ...


class FFmpegFrameExtractor:
    """Extract one JPEG frame from video bytes supplied on the event.

    Telegram media downloading intentionally lives outside this adapter. The
    event must expose downloaded bytes as video_bytes or video; production
    integration can inject a downloader-aware FrameExtractor instead.
    """

    def __init__(self, *, executable: str = "ffmpeg", timeout: float = 15.0) -> None:
        self.executable = executable
        self.timeout = timeout

    async def extract_first_frame(self, event: Any) -> bytes:
        if shutil.which(self.executable) is None:
            raise MetadataLookupError("FFmpeg executable is unavailable")
        video = getattr(event, "video_bytes", None)
        if video is None:
            video = getattr(event, "video", None)
        if not isinstance(video, (bytes, bytearray)) or not video:
            raise MetadataLookupError(
                "Downloaded video bytes are unavailable; inject a media-aware frame extractor"
            )
        process = await asyncio.create_subprocess_exec(
            self.executable, "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
            "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, _stderr = await asyncio.wait_for(
                process.communicate(bytes(video)), timeout=self.timeout
            )
        except asyncio.TimeoutError as exc:
            process.kill()
            await process.communicate()
            raise MetadataLookupError("FFmpeg frame extraction timed out") from exc
        if process.returncode != 0 or not stdout:
            raise MetadataLookupError("FFmpeg could not extract a video frame")
        return stdout


class HttpxTraceMoeClient:
    """Small async HTTP boundary for trace.moe."""

    def __init__(self, *, endpoint: str = TRACE_MOE_URL, timeout: float = 12.0,
                 max_response_bytes: int = 2_000_000, transport: Any = None) -> None:
        self.endpoint = endpoint
        self.timeout = timeout
        self.max_response_bytes = max_response_bytes
        self.transport = transport

    async def search(self, image: bytes) -> Mapping[str, Any]:
        try:
            import httpx
        except ImportError as exc:  # pragma: no cover - environment-specific
            raise MetadataLookupError("Install the project API dependencies to use trace.moe") from exc
        try:
            async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=False,
                                         transport=self.transport) as client:
                response = await client.post(
                    self.endpoint,
                    files={"image": ("frame.jpg", image, "image/jpeg")},
                    headers={"Accept": "application/json"},
                )
                response.raise_for_status()
                if len(response.content) > self.max_response_bytes:
                    raise MetadataLookupError("trace.moe response exceeded the configured size limit")
                payload = response.json()
        except MetadataLookupError:
            raise
        except (httpx.TimeoutException, httpx.HTTPError, ValueError) as exc:
            raise MetadataLookupError("trace.moe request failed") from exc
        if not isinstance(payload, dict) or not isinstance(payload.get("result"), list):
            raise MetadataLookupError("trace.moe returned an invalid response")
        return payload


class SenpaiCatcherAdapter(BaseTargetAdapter):
    target_name = "senpai_catcher"

    def __init__(self, *, sender_id: int | None = None, sender_username: str | None = None,
                 frame_extractor: FrameExtractor | None = None,
                 trace_client: TraceMoeClient | None = None) -> None:
        if sender_id is None and not sender_username:
            raise ValueError("Configure sender_id or sender_username for SenpaiCatcher")
        self.sender_id = sender_id
        self.sender_username = sender_username.lstrip("@").casefold() if sender_username else None
        self.frame_extractor = frame_extractor or FFmpegFrameExtractor()
        self.trace_client = trace_client or HttpxTraceMoeClient()

    @staticmethod
    def _message(event: Any) -> Any:
        return getattr(event, "message", event)

    def _sender_matches(self, event: Any) -> bool:
        message = self._message(event)
        actual_id = getattr(event, "sender_id", None)
        if actual_id is None:
            actual_id = getattr(message, "sender_id", None)
        actual_username = getattr(event, "sender_username", None)
        if actual_username is None:
            sender = getattr(event, "sender", None) or getattr(message, "sender", None)
            actual_username = getattr(sender, "username", None)
        if self.sender_id is not None and actual_id != self.sender_id:
            return False
        if self.sender_username is not None:
            if not isinstance(actual_username, str):
                return False
            if actual_username.lstrip("@").casefold() != self.sender_username:
                return False
        return True

    @classmethod
    def _has_video(cls, event: Any) -> bool:
        message = cls._message(event)
        video_bytes = getattr(event, "video_bytes", None)
        if isinstance(video_bytes, (bytes, bytearray)) and video_bytes:
            return True
        video = getattr(event, "video", None) or getattr(message, "video", None)
        if video is not None:
            return True
        media = getattr(message, "media", None)
        document = getattr(media, "document", None)
        mime_type = getattr(document, "mime_type", "")
        return isinstance(mime_type, str) and mime_type.startswith("video/")

    @classmethod
    def _text(cls, event: Any) -> str:
        message = cls._message(event)
        value = getattr(event, "raw_text", None)
        if value is None:
            value = getattr(event, "text", None)
        if value is None:
            value = getattr(message, "message", "")
        return value if isinstance(value, str) else ""

    def is_spawn_message(self, event: Any) -> bool:
        return self._sender_matches(event) and self._has_video(event) and SPAWN_PHRASE in self._text(event)

    async def extract_metadata(self, event: Any) -> CharacterMetadata:
        try:
            frame = await self.frame_extractor.extract_first_frame(event)
            if not isinstance(frame, (bytes, bytearray)) or not frame:
                raise MetadataLookupError("Frame extractor returned no image bytes")
            payload = await self.trace_client.search(bytes(frame))
        except MetadataLookupError:
            raise
        except Exception as exc:
            # Do not log event contents, media, or exception payloads.
            raise MetadataLookupError("Senpai metadata extraction failed") from exc
        results = payload.get("result") if isinstance(payload, Mapping) else None
        if not isinstance(results, list):
            raise MetadataLookupError("trace.moe returned an invalid response")
        if not results:
            return CharacterMetadata(anime_name=None, source="trace.moe", character_name=None,
                                     character_confidence=0.0)
        first = results[0]
        if not isinstance(first, Mapping):
            raise MetadataLookupError("trace.moe result entry is invalid")
        anilist = first.get("anilist")
        title = anilist.get("title") if isinstance(anilist, Mapping) else None
        if not isinstance(title, Mapping):
            title = {}
        anime_name = title.get("english") or title.get("romaji") or title.get("native")
        if not isinstance(anime_name, str):
            anime_name = None
        similarity = first.get("similarity")
        if not isinstance(similarity, (int, float)) or isinstance(similarity, bool):
            similarity = None
        else:
            similarity = float(similarity)
            if not 0.0 <= similarity <= 1.0:
                similarity = None
        episode = first.get("episode")
        if not isinstance(episode, (int, float, str)) or isinstance(episode, bool):
            episode = None
        return CharacterMetadata(
            anime_name=anime_name, source="trace.moe", character_name=None,
            episode=episode, similarity=similarity, anime_confidence=similarity,
            character_confidence=0.0,
            additional={key: first[key] for key in ("from", "to", "anilist") if key in first},
        )

    def get_catch_command(self, character_name: str) -> str:
        name = character_name.strip()
        if not name or any(ord(char) < 32 for char in name):
            raise ValueError("character_name must be non-empty and contain no control characters")
        return f"/pick {name}"
