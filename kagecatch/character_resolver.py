"""Conservative local anime-to-character candidate resolution."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Sequence

from .models.spawn import CharacterMetadata

logger = logging.getLogger(__name__)
_DEFAULT_MAPPING_PATH = Path(__file__).parent / "data" / "anime_character_map.json"


@dataclass(frozen=True, slots=True)
class ResolvedCharacter:
    """A suggestion result; candidates are not a confirmed character identity."""

    character_name: str | None
    confidence: float
    source: str
    candidates: tuple[str, ...] = ()


class CharacterResolver:
    """Resolve anime titles to candidate names using an injected or JSON mapping.

    A title-to-cast mapping cannot identify which character appears in a frame.
    Therefore this resolver never selects a candidate automatically and caps
    its confidence at 50 percent, regardless of the number of mapped names.
    """

    MAX_MAPPING_CONFIDENCE = 50.0

    def __init__(
        self,
        local_mapping: Mapping[str, Sequence[str]] | None = None,
        *,
        mapping_path: str | Path | None = None,
    ) -> None:
        if local_mapping is not None and mapping_path is not None:
            raise ValueError("Provide local_mapping or mapping_path, not both.")
        if mapping_path is not None:
            mapping = self._load_mapping(Path(mapping_path))
        elif local_mapping is not None:
            mapping = local_mapping
        else:
            mapping = self._load_mapping(_DEFAULT_MAPPING_PATH)
        self.local_mapping = self._validate_mapping(mapping)

    @staticmethod
    def _normalize_text(value: str) -> str:
        return " ".join(value.casefold().strip().split())

    @staticmethod
    def _load_mapping(path: Path) -> Mapping[str, Sequence[str]]:
        try:
            with path.open("r", encoding="utf-8") as mapping_file:
                data = json.load(mapping_file)
        except FileNotFoundError:
            logger.warning("Character mapping file not found: %s", path)
            return {}
        except (OSError, json.JSONDecodeError) as exc:
            raise ValueError(f"Unable to load character mapping: {path}") from exc
        if not isinstance(data, dict):
            raise ValueError("Character mapping JSON must contain an object.")
        return data

    @classmethod
    def _validate_mapping(
        cls, mapping: Mapping[str, Sequence[str]]
    ) -> dict[str, tuple[str, ...]]:
        validated: dict[str, tuple[str, ...]] = {}
        normalized_keys: set[str] = set()
        for anime_name, characters in mapping.items():
            if not isinstance(anime_name, str) or not cls._normalize_text(anime_name):
                raise ValueError("Anime mapping keys must be non-empty strings.")
            key = cls._normalize_text(anime_name)
            if key in normalized_keys:
                raise ValueError(f"Duplicate normalized anime mapping key: {anime_name}")
            if isinstance(characters, (str, bytes)) or not isinstance(characters, Sequence):
                raise ValueError(f"Characters for {anime_name!r} must be a list.")
            names = tuple(
                name.strip()
                for name in characters
                if isinstance(name, str) and name.strip()
            )
            if len(names) != len(characters) or not names:
                raise ValueError(f"Characters for {anime_name!r} must be non-empty strings.")
            if len({name.casefold() for name in names}) != len(names):
                raise ValueError(f"Duplicate character names for {anime_name!r}.")
            normalized_keys.add(key)
            validated[key] = names
        return validated

    async def resolve(
        self, metadata: CharacterMetadata
    ) -> ResolvedCharacter | None:
        anime_name = metadata.anime_name
        if not isinstance(anime_name, str) or not self._normalize_text(anime_name):
            return None

        candidates = self.local_mapping.get(self._normalize_text(anime_name))
        if not candidates:
            return None

        return ResolvedCharacter(
            character_name=None,
            confidence=self.MAX_MAPPING_CONFIDENCE,
            source="local_mapping",
            candidates=candidates,
        )
