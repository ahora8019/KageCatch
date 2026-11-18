import asyncio
import unittest

from kagecatch.recognition_worker import RecognitionWorker


class LifecycleQueue:
    def __init__(self):
        self.recovered = 0
    async def recover_expired(self):
        self.recovered += 1


class LifecycleWorker(RecognitionWorker):
    def __init__(self, stop_event, *, outcomes=()):
        self.stop_event = stop_event
        self.outcomes = list(outcomes)
        self.calls = 0
        self.queue = LifecycleQueue()
    async def run_once(self):
        self.calls += 1
        if self.outcomes:
            outcome = self.outcomes.pop(0)
            if outcome == "stop":
                self.stop_event.set()
                status = "idle"
            else:
                status = "review_queued"
        else:
            self.stop_event.set()
            status = "idle"
        return type("Result", (), {"status": status})()


class RecognitionWorkerLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_runner_processes_sequentially_and_stops_cleanly(self):
        stop = asyncio.Event()
        worker = LifecycleWorker(stop, outcomes=("work", "stop"))
        processed = await worker.run_forever(stop_event=stop, idle_sleep=0.001)
        self.assertEqual(processed, 1)
        self.assertEqual(worker.calls, 2)
        self.assertEqual(worker.queue.recovered, 2)

    async def test_runner_can_stop_while_idle(self):
        stop = asyncio.Event()
        worker = LifecycleWorker(stop)
        async def request_stop():
            await asyncio.sleep(0.01)
            stop.set()
        stopper = asyncio.create_task(request_stop())
        processed = await worker.run_forever(stop_event=stop, idle_sleep=0.05)
        await stopper
        self.assertEqual(processed, 0)
        self.assertEqual(worker.calls, 1)

    async def test_runner_rejects_invalid_idle_interval(self):
        stop = asyncio.Event()
        worker = LifecycleWorker(stop)
        with self.assertRaises(ValueError):
            await worker.run_forever(stop_event=stop, idle_sleep=0)


if __name__ == "__main__":
    unittest.main()
