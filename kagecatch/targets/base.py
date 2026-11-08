"""Abstract interface for target-specific spawn recognition."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from ..models.spawn import CharacterMetadata


class BaseTargetAdapter(ABC):
    """Recognition-only interface; implementations must not send catch commands."""

    target_name: str

    @abstractmethod
    def is_spawn_message(self, event: Any) -> bool:
        """Return whether an event is a spawn message for this target."""

    @abstractmethod
    async def extract_metadata(self, event: Any) -> CharacterMetadata:
        """Extract metadata without executing any target command."""

    @abstractmethod
    def get_catch_command(self, character_name: str) -> str:
        """Build the target's command string; this method must not send it."""
