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


def build_default_spawn_detector(
    *,
    senpai_frame_extractor=None,
    senpai_trace_client=None,
):
    """Compose the approved source adapters into the functional detector.

    Optional Senpai dependencies are injectable so tests can use deterministic
    fixtures; production media/network access is not started by this factory.
    """
    from ..spawn_detector import SpawnDetector

    adapters = build_default_target_adapters()
    adapters["senpai_catcher"] = SenpaiCatcherAdapter(
        sender_username=DEFAULT_TARGET_USERNAMES["senpai_catcher"],
        frame_extractor=senpai_frame_extractor,
        trace_client=senpai_trace_client,
    )
    return SpawnDetector(adapters.values())
