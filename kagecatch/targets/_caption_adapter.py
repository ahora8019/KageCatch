"""Shared, conservative parsing helpers for caption-based target adapters."""
from __future__ import annotations

from typing import Any


def message_of(event: Any) -> Any:
    return getattr(event, "message", event)


def text_of(event: Any) -> str:
    message = message_of(event)
    for obj, attr in ((event, "raw_text"), (event, "text"), (message, "message")):
        value = getattr(obj, attr, None)
        if isinstance(value, str):
            return value
    return ""


def sender_matches(event: Any, *, sender_id: int | None,
                   sender_username: str | None) -> bool:
    message = message_of(event)
    actual_id = getattr(event, "sender_id", None)
    if actual_id is None:
        actual_id = getattr(message, "sender_id", None)
    sender = getattr(event, "sender", None) or getattr(message, "sender", None)
    actual_username = getattr(event, "sender_username", None)
    if actual_username is None:
        actual_username = getattr(sender, "username", None)

    if sender_id is not None and actual_id != sender_id:
        return False
    if sender_username is not None:
        if not isinstance(actual_username, str):
            return False
        if actual_username.lstrip("@").casefold() != sender_username:
            return False
    return True


def has_supported_media(event: Any) -> bool:
    message = message_of(event)
    for attr in ("photo", "video", "animation", "audio", "document"):
        if getattr(message, attr, None) is not None:
            return True
    media = getattr(message, "media", None)
    if media is None:
        return False
    media_name = type(media).__name__.casefold()
    if any(token in media_name for token in ("photo", "document")):
        return True
    document = getattr(media, "document", None)
    return document is not None
