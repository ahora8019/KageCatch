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
