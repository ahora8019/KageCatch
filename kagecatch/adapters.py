"""Source-specific command configuration for the three supported catcher bots."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class CatchTarget:
    source: str
    username: str
    command: str
    media_kind: str
    enabled: bool


TARGETS: dict[str, CatchTarget] = {
    "senpai_catcher": CatchTarget(
        source="senpai_catcher",
        username="SenpaiCatcherBot",
        command="/pick",
        media_kind="video",
        enabled=False,  # Frozen/unavailable; retained in the architecture.
    ),
    "henta_catcher": CatchTarget(
        source="henta_catcher",
        username="HentaCatcherBot",
        command="/catch",
        media_kind="image",
        enabled=True,
    ),
    "character_catcher": CatchTarget(
        source="character_catcher",
        username="Character_Catcher_Bot",
        command="/catch",
        media_kind="image",
        enabled=True,
    ),
}


def build_catch_command(source: str, character_name: str) -> str:
    """Build a command only; sending it requires an authorized runtime adapter."""
    target = TARGETS.get(source)
    if target is None:
        raise ValueError("unsupported catch source")
    if not target.enabled:
        raise RuntimeError("catch source is currently frozen")
    name = character_name.strip()
    if not name or len(name) > 100 or any(char in name for char in "\r\n"):
        raise ValueError("invalid character name")
    return f"{target.command} {name}"
