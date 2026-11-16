"""Default, username-pinned registry for the three approved spawn sources."""
from __future__ import annotations

from .catcher import CatcherAdapter
from .hentai_catcher import HentaiCatcherAdapter
from .senpai_catcher import SenpaiCatcherAdapter

DEFAULT_TARGET_USERNAMES = {
    "catcher": "Character_Catcher_Bot",
    "hentai_catcher": "HentaCatcherBot",
    "senpai_catcher": "SenpaiCatcherBot",
}


def build_default_target_adapters():
    """Build source adapters pinned to the bot usernames supplied by the owner.

    Usernames are routing hints, not proof of Telegram identity. A later live
    integration must resolve and pin numeric sender IDs before enabling actions.
    """
    return {
        "catcher": CatcherAdapter(
            sender_username=DEFAULT_TARGET_USERNAMES["catcher"],
        ),
        "hentai_catcher": HentaiCatcherAdapter(
            sender_username=DEFAULT_TARGET_USERNAMES["hentai_catcher"],
        ),
        "senpai_catcher": SenpaiCatcherAdapter(
            sender_username=DEFAULT_TARGET_USERNAMES["senpai_catcher"],
        ),
    }
