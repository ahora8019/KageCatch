import unittest

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

    def test_review_pipeline_is_exposed_on_application_state(self):
        pipeline = object()
        app = create_app(
            core_secret=SECRET, runtime=object(),
            session_manager=object(), review_pipeline=pipeline,
        )

        self.assertIs(app.state.review_pipeline, pipeline)


if __name__ == "__main__":
    unittest.main()
