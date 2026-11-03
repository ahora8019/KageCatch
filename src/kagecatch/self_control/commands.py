"""Parser for the user's private self-control commands."""

from dataclasses import dataclass
from enum import StrEnum


class CommandAction(StrEnum):
    PANEL = "panel"
    ENABLE_ALL = "enable_all"
    DISABLE_ALL = "disable_all"
    ENABLE_BOT = "enable_bot"
    DISABLE_BOT = "disable_bot"
    STATUS = "status"
    STATS = "stats"
    QUOTA = "quota"
    BOTS = "bots"
    HELP = "help"


@dataclass(frozen=True, slots=True)
class SelfControlCommand:
    action: CommandAction
    bot: str | None = None


_SIMPLE_COMMANDS = {
    ".پنل": CommandAction.PANEL,
    ".روشن": CommandAction.ENABLE_ALL,
    ".خاموش": CommandAction.DISABLE_ALL,
    ".وضعیت": CommandAction.STATUS,
    ".آمار": CommandAction.STATS,
    ".سهمیه": CommandAction.QUOTA,
    ".بات ها": CommandAction.BOTS,
    ".بات‌ها": CommandAction.BOTS,
    ".راهنما": CommandAction.HELP,
}

_BOT_ALIASES = {
    "سنپای": "senpai",
    "senpai": "senpai",
    "هنتا": "henta",
    "henta": "henta",
    "کاراکتر": "character",
    "character": "character",
}


def parse_command(text: str) -> SelfControlCommand | None:
    """Parse an exact supported command; never interpret arbitrary prose."""
    normalized = " ".join(text.strip().split())
    if normalized in _SIMPLE_COMMANDS:
        return SelfControlCommand(_SIMPLE_COMMANDS[normalized])

    parts = normalized.split(" ")
    if len(parts) != 2 or parts[0] not in (".روشن", ".خاموش"):
        return None

    bot = _BOT_ALIASES.get(parts[1].casefold())
    if bot is None:
        return None

    action = (
        CommandAction.ENABLE_BOT
        if parts[0] == ".روشن"
        else CommandAction.DISABLE_BOT
    )
    return SelfControlCommand(action=action, bot=bot)
