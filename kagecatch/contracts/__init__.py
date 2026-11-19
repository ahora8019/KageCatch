"""Stable shared contracts for gradual KageCatch refactoring."""

from .models import (
    CatchReceipt,
    MediaKind,
    RecognitionCandidate,
    RecognitionResult,
    SpawnEnvelope,
    TargetDefinition,
    VerificationResult,
    VerificationStatus,
)
from .protocols import (
    CatchAdapter,
    Deduplicator,
    QuotaGate,
    RecognitionProvider,
    ReviewStore,
    SessionAccessPolicy,
    TargetRegistry,
)

__all__ = [
    "CatchAdapter",
    "CatchReceipt",
    "Deduplicator",
    "MediaKind",
    "QuotaGate",
    "RecognitionCandidate",
    "RecognitionProvider",
    "RecognitionResult",
    "ReviewStore",
    "SessionAccessPolicy",
    "SpawnEnvelope",
    "TargetDefinition",
    "TargetRegistry",
    "VerificationResult",
    "VerificationStatus",
]
