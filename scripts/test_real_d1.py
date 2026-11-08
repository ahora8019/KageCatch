"""Real Worker + D1 Preview round-trip and queue-restart test.

Required environment:
  KAGECATCH_PREVIEW_WORKER_URL=https://<preview-worker-host>
  # For wrangler.preview.toml local execution: http://127.0.0.1:8787
  KAGECATCH_CORE_SECRET=<same value as Preview Worker's CORE_API_SECRET>
  KAGECATCH_PREVIEW_CONFIRM=I_AM_USING_PREVIEW_D1

Run:
  python scripts/test_real_d1.py

The test creates a synthetic review through the real D1ManualReviewStore,
closes that HTTP client/queue instance, constructs a fresh store/queue, and
reads the row back. It then rejects the row so it no longer appears in Pending.
No Telegram API, Telethon session, or Catch command is used.
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

import httpx

from kagecatch.d1_manual_review_store import D1ManualReviewStore
from kagecatch.manual_review_queue import ReviewStatus
from kagecatch.persistent_manual_review_queue import PersistentManualReviewQueue


PRODUCTION_HOSTS = {"kagecatch-control.ahora-project.workers.dev"}
CONFIRMATION = "I_AM_USING_PREVIEW_D1"


def _configuration() -> tuple[str, str]:
    base_url = os.getenv("KAGECATCH_PREVIEW_WORKER_URL", "").strip().rstrip("/")
    secret = os.getenv("KAGECATCH_CORE_SECRET", "")
    confirmation = os.getenv("KAGECATCH_PREVIEW_CONFIRM", "")

    if not base_url or not secret:
        raise SystemExit(
            "Set KAGECATCH_PREVIEW_WORKER_URL and KAGECATCH_CORE_SECRET."
        )
    if len(secret.encode("utf-8")) < 32:
        raise SystemExit("KAGECATCH_CORE_SECRET must contain at least 32 bytes.")
    if confirmation != CONFIRMATION:
        raise SystemExit(
            "Refusing to write: set KAGECATCH_PREVIEW_CONFIRM="
            + CONFIRMATION
        )

    parsed = urlparse(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise SystemExit("Preview Worker URL must be an absolute HTTP(S) URL.")
    if parsed.hostname in PRODUCTION_HOSTS:
        raise SystemExit("Refusing to write to the known production Worker host.")
    if parsed.scheme != "https" and parsed.hostname not in {"localhost", "127.0.0.1"}:
        raise SystemExit("Non-local Preview Worker URLs must use HTTPS.")
    return base_url, secret


async def main() -> None:
    base_url, secret = _configuration()
    unique = uuid.uuid4().hex
    user_id = "preview-test-" + unique
    now = datetime.now(timezone.utc)

    # First process/runtime instance: create the durable row.
    first_store = D1ManualReviewStore(base_url, secret)
    first_queue = PersistentManualReviewQueue(
        store=first_store,
        default_ttl=timedelta(minutes=5),
    )
    try:
        created_item = await first_queue.enqueue(
            user_id=user_id,
            spawn_id=int(now.timestamp()),
            anime_name="KageCatch Preview Integration Test",
            candidates=("Preview Candidate A", "Preview Candidate B"),
        )
        print("PASS: first queue instance persisted a synthetic review.")
    finally:
        await first_store.close()

    # Simulate a Core restart: no queue object or HTTPX client is reused.
    second_store = D1ManualReviewStore(base_url, secret)
    second_queue = PersistentManualReviewQueue(store=second_store)
    cleanup_confirmed = False
    try:
        pending = await second_queue.get_pending(user_id=user_id)
        matches = [item for item in pending if item.review_id == created_item.review_id]
        if len(matches) != 1:
            raise RuntimeError(
                "Restart read-after-write failed: D1 did not return the persisted row."
            )

        restored = matches[0]
        expected = {
            "user_id": user_id,
            "spawn_id": created_item.spawn_id,
            "anime_name": "KageCatch Preview Integration Test",
            "candidates": ("Preview Candidate A", "Preview Candidate B"),
            "status": ReviewStatus.PENDING,
        }
        actual = {
            "user_id": restored.user_id,
            "spawn_id": restored.spawn_id,
            "anime_name": restored.anime_name,
            "candidates": restored.candidates,
            "status": restored.status,
        }
        if actual != expected:
            raise RuntimeError("Restart restored a record with mismatched fields.")

        print("PASS: a fresh queue/store instance restored the record from D1.")

        rejected = await second_queue.reject(
            user_id=user_id,
            review_id=restored.review_id,
        )
        if rejected.status is not ReviewStatus.REJECTED:
            raise RuntimeError("Cleanup failed: D1 did not persist rejected status.")
        cleanup_confirmed = True
        print("PASS: test row marked rejected; no longer pending.")
    finally:
        if not cleanup_confirmed:
            try:
                await second_queue.reject(
                    user_id=user_id,
                    review_id=created_item.review_id,
                )
                print("Cleanup: synthetic row marked rejected.")
            except (httpx.HTTPError, LookupError, RuntimeError):
                print("WARNING: cleanup failed; synthetic row expires after 5 minutes.")
        await second_store.close()

    print(json.dumps({
        "result": "preview_d1_restart_round_trip_passed",
        "worker": base_url,
        "queue_instances": 2,
        "telegram_connected": False,
        "catch_executed": False,
        "cleanup_confirmed": cleanup_confirmed,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
