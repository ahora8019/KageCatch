import unittest
from datetime import datetime, timezone
from types import SimpleNamespace

from kagecatch.recognition_job_producer import RecognitionJobProducer


class FakeDetector:
    def __init__(self, spawn=None, error=None):
        self.spawn, self.error = spawn, error
        self.calls = 0

    async def detect(self, event):
        self.calls += 1
        if self.error:
            raise self.error
        return self.spawn


class FakeQueue:
    def __init__(self):
        self.calls = []

    async def enqueue(self, job_type, payload, **kwargs):
        self.calls.append((job_type, payload, kwargs))
        return SimpleNamespace(job_id="job-123")


def spawn(anime_name="KonoSuba"):
    metadata = SimpleNamespace(
        anime_name=anime_name, anime_confidence=0.93, source="trace.moe",
    )
    return SimpleNamespace(
        message_id=91, target_name="SenpaiCatcherBot", metadata=metadata,
    )


class RecognitionJobProducerTests(unittest.IsolatedAsyncioTestCase):
    async def test_spawn_becomes_typed_idempotent_recognition_job(self):
        queue = FakeQueue()
        producer = RecognitionJobProducer(detector=FakeDetector(spawn()), queue=queue)
        event = SimpleNamespace(chat_id=-1001, message=SimpleNamespace(chat_id=-1001))

        result = await producer.process("12345", event)

        self.assertEqual(result, {"status": "queued", "job_id": "job-123"})
        job_type, payload, options = queue.calls[0]
        self.assertEqual(job_type, "spawn.recognize")
        self.assertEqual(options["idempotency_key"], "spawn:12345:-1001:91")
        self.assertEqual(payload["recognition"]["anime_name"], "KonoSuba")
        self.assertEqual(payload["recognition"]["anime_confidence"], 0.93)
        self.assertNotIn("character_name", payload["recognition"])

    async def test_no_spawn_and_no_anime_match_do_not_enqueue(self):
        queue = FakeQueue()
        no_spawn = RecognitionJobProducer(detector=FakeDetector(), queue=queue)
        self.assertEqual(await no_spawn.process("12345", object()), {"status": "no_spawn"})
        no_match = RecognitionJobProducer(detector=FakeDetector(spawn(None)), queue=queue)
        result = await no_match.process("12345", SimpleNamespace(chat_id=-1001))
        self.assertEqual(result["status"], "no_anime_match")
        self.assertEqual(queue.calls, [])

    async def test_invalid_origin_is_not_enqueued(self):
        queue = FakeQueue()
        producer = RecognitionJobProducer(detector=FakeDetector(spawn()), queue=queue)
        result = await producer.process("12345", SimpleNamespace(chat_id=None))
        self.assertEqual(result["status"], "invalid_origin")
        self.assertEqual(queue.calls, [])

    async def test_detector_failure_is_reported_without_leaking_event_data(self):
        queue = FakeQueue()
        producer = RecognitionJobProducer(
            detector=FakeDetector(error=RuntimeError("private payload")), queue=queue,
        )
        result = await producer.process("12345", object())
        self.assertEqual(result, {"status": "enqueue_failed"})
        self.assertEqual(queue.calls, [])


    async def test_process_spawn_queues_existing_detection_without_running_detector(self):
        queue = FakeQueue()
        detector = FakeDetector(spawn())
        producer = RecognitionJobProducer(detector=detector, queue=queue)

        result = await producer.process_spawn(
            user_id="12345", spawn=spawn(), chat_id=-1001,
        )

        self.assertEqual(result, {"status": "queued", "job_id": "job-123"})
        self.assertEqual(detector.calls, 0)
        job_type, payload, options = queue.calls[0]
        self.assertEqual(job_type, "spawn.recognize")
        self.assertEqual(options["idempotency_key"], "spawn:12345:-1001:91")
        self.assertEqual(payload["origin"]["source"], "SenpaiCatcherBot")
        self.assertNotIn("event", payload)
        self.assertNotIn("session", payload)

    async def test_process_spawn_rejects_invalid_chat_id_without_queueing(self):
        queue = FakeQueue()
        detector = FakeDetector(spawn())
        producer = RecognitionJobProducer(detector=detector, queue=queue)

        result = await producer.process_spawn(
            user_id="12345", spawn=spawn(), chat_id=True,
        )

        self.assertEqual(result, {"status": "invalid_origin"})
        self.assertEqual(detector.calls, 0)
        self.assertEqual(queue.calls, [])

    async def test_invalid_user_id_is_rejected(self):
        producer = RecognitionJobProducer(detector=FakeDetector(), queue=FakeQueue())
        with self.assertRaises(ValueError):
            await producer.process("", object())


if __name__ == "__main__":
    unittest.main()
