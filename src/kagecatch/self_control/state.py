"""In-memory, per-user Auto Catch state with safety gates.

This module deliberately does not manage Telegram sessions, queues, or persistence.
Those boundaries are implemented by higher-level services.
"""

from dataclasses import dataclass, field
from enum import StrEnum


class BotName(StrEnum):
    SENPAI = "senpai"
    HENTA = "henta"
    CHARACTER = "character"


@dataclass(slots=True)
class ControlState:
    """Control flags for exactly one user; never share across user accounts."""

    user_id: str
    listener_connected: bool = False
    auto_catch_enabled: bool = False
    bot_enabled: dict[BotName, bool] = field(
        default_factory=lambda: {bot: False for bot in BotName}
    )

    def __post_init__(self) -> None:
        if not self.user_id.strip():
            raise ValueError("user_id must not be empty")
        for bot in BotName:
            self.bot_enabled.setdefault(bot, False)

    def enable_global(self) -> None:
        self.auto_catch_enabled = True

    def disable_global(self) -> None:
        """Pause automation only; keep the listener available for commands."""
        self.auto_catch_enabled = False

    def enable_bot(self, bot: BotName) -> None:
        self.bot_enabled[bot] = True

    def disable_bot(self, bot: BotName) -> None:
        self.bot_enabled[bot] = False

    def can_auto_catch(
        self,
        bot: BotName,
        *,
        safety_locked: bool = False,
        quota_available: bool = True,
        flood_wait: bool = False,
    ) -> bool:
        """Return whether a catch may start; safety gates always take priority."""
        return all(
            (
                self.auto_catch_enabled,
                self.bot_enabled[bot],
                not safety_locked,
                quota_available,
                not flood_wait,
            )
        )
