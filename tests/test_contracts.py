import unittest
from datetime import datetime, timezone

from kagecatch.contracts.models import (
    CatchReceipt,
    RecognitionCandidate,
    RecognitionResult,
    SpawnEnvelope,
    TargetDefinition,
    VerificationResult,
)


class TargetDefinitionTests(unittest.TestCase):
    def test_normalizes_bot_username_and_accepts_supported_media(self):
        target = TargetDefinition(
            source_id="henta_catcher",
            bot_username="@HentaCatcherBot",
            media_kind="image",
            command_prefix="/catch",
            enabled=True,
        )
        self.assertEqual(target.bot_username, "HentaCatcherBot")
        self.assertEqual(target.media_kind, "image")

    def test_rejects_empty_source_identifier(self):
        with self.assertRaises(ValueError):
            TargetDefinition(
                source_id=" ",
                bot_username="HentaCatcherBot",
                media_kind="image",
                command_prefix="/catch",
            )

    def test_rejects_unsupported_media_kind(self):
        with self.assertRaises(ValueError):
            TargetDefinition(
                source_id="senpai_catcher",
                bot_username="SenpaiCatcherBot",
                media_kind="document",
                command_prefix="/pick",
            )

    def test_rejects_command_prefix_without_slash(self):
        with self.assertRaises(ValueError):
            TargetDefinition(
                source_id="henta_catcher",
                bot_username="HentaCatcherBot",
                media_kind="image",
                command_prefix="catch",
            )


class SpawnEnvelopeTests(unittest.TestCase):
    def test_requires_user_scope_and_positive_message_id(self):
        with self.assertRaises(ValueError):
            SpawnEnvelope(
                user_id="",
                source_id="henta_catcher",
                chat_id=-100123,
                message_id=42,
                media_kind="image",
                occurred_at=datetime.now(timezone.utc),
            )

        with self.assertRaises(ValueError):
            SpawnEnvelope(
                user_id="user-1",
                source_id="henta_catcher",
                chat_id=-100123,
                message_id=0,
                media_kind="image",
                occurred_at=datetime.now(timezone.utc),
            )

    def test_rejects_naive_timestamp(self):
        with self.assertRaises(ValueError):
            SpawnEnvelope(
                user_id="user-1",
                source_id="henta_catcher",
                chat_id=-100123,
                message_id=42,
                media_kind="image",
                occurred_at=datetime(2026, 1, 1),
            )

    def test_accepts_negative_group_chat_id(self):
        envelope = SpawnEnvelope(
            user_id="user-1",
            source_id="henta_catcher",
            chat_id=-100123,
            message_id=42,
            media_kind="image",
            occurred_at=datetime.now(timezone.utc),
        )
        self.assertEqual(envelope.chat_id, -100123)


class RecognitionContractTests(unittest.TestCase):
    def test_candidate_confidence_must_be_finite_and_in_range(self):
        for confidence in (-0.1, 1.1, float("nan"), float("inf"), True):
            with self.subTest(confidence=confidence):
                with self.assertRaises(ValueError):
                    RecognitionCandidate(name="Sakura", confidence=confidence)

    def test_candidate_name_must_be_non_empty(self):
        with self.assertRaises(ValueError):
            RecognitionCandidate(name="  ", confidence=0.9)

    def test_anime_similarity_is_not_character_confidence(self):
        result = RecognitionResult(
            source="trace.moe",
            candidates=(),
            anime_name="Example Anime",
            anime_similarity=0.98,
        )
        self.assertEqual(result.anime_similarity, 0.98)
        self.assertEqual(result.candidates, ())


class CatchReceiptTests(unittest.TestCase):
    def test_receipt_requires_reference_and_character_name(self):
        with self.assertRaises(ValueError):
            CatchReceipt(reference="", character_name="Sakura")
        with self.assertRaises(ValueError):
            CatchReceipt(reference="bot:123", character_name=" ")


class VerificationResultTests(unittest.TestCase):
    def test_verified_result_requires_evidence_reference(self):
        with self.assertRaises(ValueError):
            VerificationResult(status="verified")

    def test_unverified_result_can_explain_missing_evidence(self):
        result = VerificationResult(status="unverified", reason="no matching reply")
        self.assertEqual(result.status, "unverified")


if __name__ == "__main__":
    unittest.main()
