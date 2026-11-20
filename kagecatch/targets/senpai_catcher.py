"""SenpaiCatcher video-spawn recognition with independent anime and character lookup.

trace.moe supplies anime-scene context only. A separately injected character
recognizer may attach a catalog-verified identity; ambiguous or unknown results
never become catchable character names.
"""

from __future__ import annotations

import asyncio
import math
import shutil
from types import SimpleNamespace
from typing import Any, Mapping, Protocol

from ..models.spawn import CharacterMetadata
from ..recognition.character_catalog import CharacterRecord, CharacterRecognitionResult
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


class TelethonFrameExtractor:
    """Download a Telethon message's video safely, then extract its first frame."""

    def __init__(
        self,
        *,
        frame_extractor: FrameExtractor | None = None,
        download_timeout: float = 60.0,
        max_video_bytes: int = 25 * 1024 * 1024,
    ) -> None:
        if download_timeout <= 0 or max_video_bytes <= 0:
            raise ValueError("download_timeout and max_video_bytes must be positive")
        self.frame_extractor = frame_extractor or FFmpegFrameExtractor()
        self.download_timeout = download_timeout
        self.max_video_bytes = max_video_bytes

    async def extract_first_frame(self, event: Any) -> bytes:
        message = getattr(event, "message", event)
        client = getattr(event, "client", None) or getattr(message, "client", None)
        media_file = getattr(message, "file", None)
        declared_size = getattr(media_file, "size", None)
        if isinstance(declared_size, int) and declared_size > self.max_video_bytes:
            raise MetadataLookupError("Video exceeds the configured download size limit")

        iter_download = getattr(client, "iter_download", None)
        if not callable(iter_download):
            raise MetadataLookupError(
                "Telethon client does not support bounded streaming downloads"
            )

        try:
            stream = iter_download(message, request_size=64 * 1024)

            async def collect_bounded_video() -> bytes:
                chunks: list[bytes] = []
                total_bytes = 0
                try:
                    async for chunk in stream:
                        if not isinstance(chunk, (bytes, bytearray, memoryview)):
                            raise MetadataLookupError(
                                "Telegram video stream returned an invalid chunk"
                            )
                        chunk_bytes = bytes(chunk)
                        total_bytes += len(chunk_bytes)
                        if total_bytes > self.max_video_bytes:
                            raise MetadataLookupError(
                                "Downloaded video exceeds the configured size limit"
                            )
                        chunks.append(chunk_bytes)
                finally:
                    close = getattr(stream, "aclose", None)
                    if callable(close):
                        try:
                            await close()
                        except Exception:
                            # A failed cleanup must not mask the bounded-download result.
                            pass
                return b"".join(chunks)

            video = await asyncio.wait_for(
                collect_bounded_video(),
                timeout=self.download_timeout,
            )
        except MetadataLookupError:
            raise
        except asyncio.TimeoutError as exc:
            raise MetadataLookupError("Telegram video download timed out") from exc
        except Exception as exc:
            raise MetadataLookupError("Telegram video download failed") from exc

        if not video:
            raise MetadataLookupError("Telegram returned no video bytes")

        return await self.frame_extractor.extract_first_frame(
            SimpleNamespace(video_bytes=video)
        )


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
            import json

            async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=False,
                                         transport=self.transport) as client:
                async with client.stream(
                    "POST",
                    self.endpoint,
                    files={"image": ("frame.jpg", image, "image/jpeg")},
                    headers={"Accept": "application/json"},
                ) as response:
                    response.raise_for_status()
                    response_body = bytearray()
                    async for chunk in response.aiter_bytes(chunk_size=8192):
                        if len(chunk) > self.max_response_bytes - len(response_body):
                            raise MetadataLookupError(
                                "trace.moe response exceeded the configured size limit"
                            )
                        response_body.extend(chunk)
                payload = json.loads(response_body)
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
                 trace_client: TraceMoeClient | None = None,
                 character_recognizer: Any = None,
                 catch_command_template: str | None = None) -> None:
        if sender_id is None and not sender_username:
            raise ValueError("Configure sender_id or sender_username for SenpaiCatcher")
        self.sender_id = sender_id
        self.sender_username = sender_username.lstrip("@").casefold() if sender_username else None
        self.frame_extractor = frame_extractor or TelethonFrameExtractor()
        self.trace_client = trace_client or HttpxTraceMoeClient()
        if character_recognizer is not None and not callable(
            getattr(character_recognizer, "recognize", None)
        ):
            raise ValueError("character_recognizer must expose async recognize(image, media_type=...)")
        self.character_recognizer = character_recognizer
        if catch_command_template is not None:
            if not isinstance(catch_command_template, str) or "{character_name}" not in catch_command_template:
                raise ValueError("catch_command_template must contain {character_name}")
            self.catch_command_template = catch_command_template
        else:
            self.catch_command_template = None

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
        except MetadataLookupError:
            raise
        except Exception as exc:
            # Do not log event contents, media, or exception payloads.
            raise MetadataLookupError("Senpai frame extraction failed") from exc

        scene_lookup_status = "available"
        try:
            payload = await self.trace_client.search(bytes(frame))
        except Exception:
            # trace.moe is optional anime context; character recognition can still run.
            payload = {"result": []}
            scene_lookup_status = "unavailable"
        results = payload.get("result") if isinstance(payload, Mapping) else None
        if not isinstance(results, list):
            raise MetadataLookupError("trace.moe returned an invalid response")
        first = results[0] if results else {}
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

        character_name = None
        character_confidence = 0.0
        recognition_status = (
            "not_run_no_scene_match" if not results else "not_configured"
        )
        recognition_reason = None
        if self.character_recognizer is not None:
            try:
                recognition = await self.character_recognizer.recognize(
                    bytes(frame), media_type="image/jpeg"
                )
                if isinstance(recognition, CharacterRecognitionResult):
                    recognition_status = recognition.status
                    recognition_reason = recognition.reason
                    confidence = recognition.confidence
                    record = recognition.character
                    if (
                        recognition.status == "known"
                        and isinstance(record, CharacterRecord)
                        and isinstance(confidence, (int, float))
                        and not isinstance(confidence, bool)
                        and math.isfinite(float(confidence))
                        and 0.0 <= float(confidence) <= 1.0
                    ):
                        character_name = record.canonical_name
                        character_confidence = float(confidence)
                else:
                    recognition_status = "invalid_model_output"
            except Exception:
                # Anime-scene metadata remains useful; character identity fails closed.
                recognition_status = "model_unavailable"
                recognition_reason = None

        additional = {
            key: first[key] for key in ("from", "to", "anilist") if key in first
        }
        additional["scene_lookup_status"] = (
            "matched" if results else
            ("unavailable" if scene_lookup_status == "unavailable" else "no_match")
        )
        additional["character_recognition_status"] = recognition_status
        if recognition_reason is not None:
            additional["character_recognition_reason"] = recognition_reason
        if recognition_status == "review" and isinstance(
            getattr(recognition, "proposed_name", None), str
        ):
            proposed_name = recognition.proposed_name.strip()
            if (
                proposed_name
                and len(proposed_name) <= 100
                and not any(
                    ord(char) < 32 or 127 <= ord(char) < 160
                    for char in proposed_name
                )
            ):
                additional["proposed_character_name"] = proposed_name
        return CharacterMetadata(
            anime_name=anime_name, source=self.target_name,
            character_name=character_name, episode=episode,
            similarity=similarity, anime_confidence=similarity,
            character_confidence=character_confidence,
            additional=additional,
        )

    def get_catch_command(self, character_name: str) -> str:
        name = character_name.strip()
        if not name or any(ord(char) < 32 for char in name):
            raise ValueError("character_name must be non-empty and contain no control characters")
        if self.catch_command_template is None:
            raise RuntimeError("Catch command is disabled until the target bot command is verified")
        return self.catch_command_template.format(character_name=name)
