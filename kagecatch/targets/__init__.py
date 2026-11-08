"""Target-specific spawn recognition adapters."""

from .base import BaseTargetAdapter
from .senpai_catcher import SenpaiCatcherAdapter

__all__ = ["BaseTargetAdapter", "SenpaiCatcherAdapter"]
