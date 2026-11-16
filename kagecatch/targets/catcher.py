"""Catcher chat-spawn recognition; no Telegram commands are sent."""
from __future__ import annotations

from typing import Any

from ..models.spawn import CharacterMetadata
from .base import BaseTargetAdapter
from ._caption_adapter import has_supported_media, sender_matches, text_of


class CatcherAdapter(BaseTargetAdapter):
    target_name = "catcher"
    SPAWN_MARKER = "A CHARACTER HAS SPAWNED IN THE CHAT!"

    def __init__(self, *, sender_id: int | None = None,
                 sender_username: str | None = None) -> None:
        if sender_id is None and not sender_username:
            raise ValueError("Configure sender_id or sender_username for Catcher")
        self.sender_id = sender_id
        self.sender_username = sender_username.lstrip("@").casefold() if sender_username else None

    def is_spawn_message(self, event: Any) -> bool:
        text = text_of(event).casefold()
        return (
            sender_matches(event, sender_id=self.sender_id,
                           sender_username=self.sender_username)
            and has_supported_media(event)
            and self.SPAWN_MARKER.casefold() in text
            and "/catch" in text
        )

    async def extract_metadata(self, event: Any) -> CharacterMetadata:
        if not self.is_spawn_message(event):
            raise ValueError("event is not a Catcher spawn")
        return CharacterMetadata(
            anime_name=None, source=self.target_name,
            character_name=None, character_confidence=0.0,
        )

    def get_catch_command(self, character_name: str) -> str:
        raise RuntimeError("Catch execution is disabled until command grammar and safety gates are verified")
