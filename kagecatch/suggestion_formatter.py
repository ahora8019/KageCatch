"""Framework-neutral Telegram suggestion text and inline-keyboard payload."""

from __future__ import annotations

from dataclasses import dataclass
from html import escape

from .character_resolver import ResolvedCharacter


@dataclass(frozen=True, slots=True)
class SuggestionButton:
    text: str
    callback_data: str


@dataclass(frozen=True, slots=True)
class SuggestionMessage:
    text: str
    inline_keyboard: tuple[tuple[SuggestionButton, ...], ...]


def format_character_suggestion(
    resolved: ResolvedCharacter, *, anime_name: str, spawn_id: int
) -> SuggestionMessage:
    """Build a Telegram-compatible presentation payload; does not send it."""
    if not resolved.candidates:
        raise ValueError("At least one candidate is required.")
    if not isinstance(spawn_id, int) or spawn_id < 0:
        raise ValueError("spawn_id must be a non-negative integer.")

    buttons: list[SuggestionButton] = []
    for index, candidate in enumerate(resolved.candidates):
        if not candidate or not isinstance(candidate, str):
            raise ValueError("Candidate names must be non-empty strings.")
        callback_data = f"kc:s:{spawn_id}:{index}"
        if len(callback_data.encode("utf-8")) > 64:
            raise ValueError("Generated callback_data exceeds Telegram's 64-byte limit.")
        buttons.append(SuggestionButton(text=candidate, callback_data=callback_data))

    ignore_data = f"kc:i:{spawn_id}"
    if len(ignore_data.encode("utf-8")) > 64:
        raise ValueError("Generated callback_data exceeds Telegram's 64-byte limit.")
    buttons.append(SuggestionButton(text="Ignore", callback_data=ignore_data))

    text = (
        f"I found a spawn from {escape(anime_name)}. "
        "Which character is it?"
    )
    rows = tuple((button,) for button in buttons)
    return SuggestionMessage(text=text, inline_keyboard=rows)
