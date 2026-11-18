"""Target-specific spawn recognition adapters."""

from .base import BaseTargetAdapter
from .catcher import CatcherAdapter
from .hentai_catcher import HentaiCatcherAdapter
from .senpai_catcher import SenpaiCatcherAdapter

__all__ = [
    "BaseTargetAdapter",
    "CatcherAdapter",
    "HentaiCatcherAdapter",
    "SenpaiCatcherAdapter",
]
