"""Local, network-free KageCatch spawn-to-review flow simulator.

Run from the repository root with:
    python scripts/test_flow.py

No Telegram client, Cloudflare request, credentials, or Catch command is used.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone

from kagecatch.character_resolver import CharacterResolver
from kagecatch.manual_review_queue import ManualReviewQueue
from kagecatch.models.spawn import CharacterMetadata
from kagecatch.review_pipeline import ReviewPipeline
from kagecatch.spawn_detector import SpawnDetector


class DemoAdapter:
    target_name = "SenpaiCatcherBot"

    def is_spawn_message(self, event):
        return True

    async def extract_metadata(self, event):
        return CharacterMetadata(
            anime_name="KonoSuba",
            source="simulator",
            episode=3,
            similarity=0.94,
            anime_confidence=0.94,
        )


async def main() -> None:
    event = type("DemoEvent", (), {
        "id": 26001,
        "date": datetime.now(timezone.utc),
    })()
    queue = ManualReviewQueue()
    pipeline = ReviewPipeline(
        detector=SpawnDetector([DemoAdapter()]),
        resolver=CharacterResolver({
            "KonoSuba": ["Megumin", "Aqua", "Darkness"],
        }),
        review_queue=queue,
    )

    result = await pipeline.process(event=event, user_id="demo-user")
    pending = await queue.get_pending(user_id="demo-user")
    print(json.dumps({
        "pipeline_status": result["status"],
        "spawn_id": result.get("spawn_id"),
        "review_count": len(pending),
        "review_status": pending[0].status.value if pending else None,
        "candidates": list(pending[0].candidates) if pending else [],
        "telegram_connected": False,
        "catch_executed": False,
        "cloudflare_contacted": False,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
