import os
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from kagecatch.core_api import create_app


SECRET = "core-test-secret-0123456789abcdef"


class ClosableStore:
    def __init__(self):
        self.closed = False

    async def close(self):
        self.closed = True


class CoreApiReviewLifecycleTests(unittest.TestCase):
    def test_injected_review_store_is_exposed_and_closed_on_shutdown(self):
        store = ClosableStore()
        app = create_app(
            core_secret=SECRET, runtime=object(),
            session_manager=object(), review_store=store,
        )

        self.assertIs(app.state.review_store, store)
        with TestClient(app):
            self.assertFalse(store.closed)
        self.assertTrue(store.closed)



    def test_runtime_composes_pipeline_when_detector_and_resolver_are_injected(self):
        detector = object()
        resolver = object()
        queue = object()
        app = create_app(
            core_secret=SECRET, runtime=object(),
            session_manager=object(), review_queue=queue,
            spawn_detector=detector, character_resolver=resolver,
        )
        with TestClient(app):
            pipeline = app.state.review_pipeline
            self.assertIsNotNone(pipeline)
            self.assertIs(pipeline.detector, detector)
            self.assertIs(pipeline.resolver, resolver)
            self.assertIs(pipeline.review_queue, queue)

    def test_environment_configured_store_is_created_at_startup_and_closed(self):
        with patch.dict(os.environ, {
            "KAGECATCH_SESSION_STORE_URL": "https://control.example.test",
            "KAGECATCH_CORE_SECRET": SECRET,
        }):
            app = create_app(
                core_secret=SECRET, runtime=object(),
                session_manager=object(),
            )
            self.assertIsNone(app.state.review_store)
            with TestClient(app):
                store = app.state.review_store
                self.assertIsNotNone(store)
                self.assertIsNotNone(app.state.review_queue)
                self.assertFalse(store._client.is_closed)
            self.assertTrue(store._client.is_closed)



    def test_queue_worker_is_started_and_incoming_events_enqueue_only_detected_spawns(self):
        import asyncio
        from types import SimpleNamespace
        from kagecatch.models.spawn import CharacterMetadata, SpawnEvent

        class Controller:
            def set_incoming_handler(self, handler):
                self.incoming_handler = handler

        class Runtime:
            def __init__(self):
                self._selfbot_controller = Controller()

        class Queue:
            def __init__(self):
                self.enqueued = []
                self.closed = False
            async def enqueue(self, job_type, payload, **kwargs):
                self.enqueued.append((job_type, payload, kwargs))
                return SimpleNamespace(job_id="job-1")
            async def claim_next(self, *args, **kwargs):
                return None
            async def recover_expired(self):
                return 0
            async def close(self):
                self.closed = True

        class Detector:
            async def detect(self, event):
                return SpawnEvent(
                    message_id=77, character_name=None, confidence_score=0.0,
                    metadata=CharacterMetadata(
                        anime_name="KonoSuba", source="test", anime_confidence=0.9,
                    ),
                    target_name="SenpaiCatcherBot",
                )

        class Resolver:
            async def resolve(self, metadata):
                raise AssertionError("resolver work must run in the background worker")

        runtime, queue = Runtime(), Queue()
        app = create_app(
            core_secret=SECRET, runtime=runtime, session_manager=object(),
            review_queue=object(), spawn_detector=Detector(),
            character_resolver=Resolver(), job_queue=queue,
        )
        with TestClient(app):
            self.assertIsNotNone(app.state.recognition_worker)
            self.assertIsNotNone(app.state.recognition_worker_task)
            result = runtime._selfbot_controller.incoming_handler(
                "12345", SimpleNamespace(chat_id=-1001, media_kind="video"),
            )
            asyncio.run(result)
            self.assertEqual(len(queue.enqueued), 1)
            self.assertEqual(queue.enqueued[0][0], "spawn.recognize")
            self.assertEqual(queue.enqueued[0][1]["origin"]["chat_id"], -1001)
            self.assertEqual(queue.enqueued[0][1]["origin"]["media_kind"], "video")
            self.assertEqual(queue.enqueued[0][2]["idempotency_key"], "spawn:12345:-1001:77")
        self.assertTrue(app.state.recognition_worker_stop.is_set())
        self.assertTrue(app.state.recognition_worker_task.done())
        self.assertTrue(queue.closed)

    def test_review_resources_use_fastapi_lifespan_not_deprecated_event_hooks(self):
        app = create_app(
            core_secret=SECRET, runtime=object(),
            session_manager=object(),
        )

        self.assertEqual(app.router.on_startup, [])
        self.assertEqual(app.router.on_shutdown, [])

    def test_review_pipeline_is_exposed_on_application_state(self):
        pipeline = object()
        app = create_app(
            core_secret=SECRET, runtime=object(),
            session_manager=object(), review_pipeline=pipeline,
        )

        self.assertIs(app.state.review_pipeline, pipeline)


if __name__ == "__main__":
    unittest.main()
