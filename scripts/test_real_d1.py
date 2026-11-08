"""Real Worker + D1 Preview integration check (no Telegram or Catch).

Required environment:
  KAGECATCH_PREVIEW_WORKER_URL=https://<preview-worker-host>
  KAGECATCH_CORE_SECRET=<same value as Preview Worker's CORE_API_SECRET>
  KAGECATCH_PREVIEW_CONFIRM=I_AM_USING_PREVIEW_D1

Run:
  python scripts/test_real_d1.py

The script creates one short-lived synthetic review row, reads it back through
the authenticated Worker API, then rejects it so it no longer appears in the
pending queue. It never calls Telethon or any Telegram API.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

import httpx


PATH = "/internal/manual-review"
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


def _signed_headers(payload: dict, secret: str) -> tuple[bytes, dict[str, str]]:
    body = json.dumps(
        payload, separators=(",", ":"), ensure_ascii=True
    ).encode("utf-8")
    timestamp = str(int(datetime.now(timezone.utc).timestamp()))
    nonce = uuid.uuid4().hex
    body_hash = hashlib.sha256(body).hexdigest()
    signing_text = f"{timestamp}\n{nonce}\nPOST\n{PATH}\n{body_hash}"
    signature = hmac.new(
        secret.encode("utf-8"), signing_text.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return body, {
        "content-type": "application/json",
        "X-KageCatch-Timestamp": timestamp,
        "X-KageCatch-Nonce": nonce,
        "X-KageCatch-Signature": signature,
    }


async def _post(
    client: httpx.AsyncClient, base_url: str, secret: str, payload: dict
) -> tuple[int, dict]:
    body, headers = _signed_headers(payload, secret)
    response = await client.post(base_url + PATH, content=body, headers=headers)
    try:
        data = response.json()
    except ValueError:
        data = {"error": "non_json_response"}
    return response.status_code, data


async def main() -> None:
    base_url, secret = _configuration()
    unique = uuid.uuid4().hex
    user_id = "preview-test-" + unique
    review_id = unique
    now = datetime.now(timezone.utc)
    created_at = now.isoformat().replace("+00:00", "Z")
    expires_at = (now + timedelta(minutes=5)).isoformat().replace("+00:00", "Z")
    create_payload = {
        "action": "create",
        "review_id": review_id,
        "user_id": user_id,
        "spawn_id": int(now.timestamp()),
        "anime_name": "KageCatch Preview Integration Test",
        "candidates": ["Preview Candidate A", "Preview Candidate B"],
        "created_at": created_at,
        "expires_at": expires_at,
    }

    created = False
    async with httpx.AsyncClient(
        timeout=httpx.Timeout(10.0, connect=5.0),
        follow_redirects=False,
    ) as client:
        try:
            status, body = await _post(client, base_url, secret, create_payload)
            if status != 201 or body.get("status") != "created":
                raise RuntimeError(
                    f"CREATE failed: HTTP {status}, error={body.get('error', 'unknown')}"
                )
            created = True
            print("PASS: Worker accepted signed create request.")

            status, body = await _post(
                client, base_url, secret, {"action": "list", "user_id": user_id}
            )
            if status != 200:
                raise RuntimeError(
                    f"LIST failed: HTTP {status}, error={body.get('error', 'unknown')}"
                )
            matches = [
                item for item in body.get("items", [])
                if isinstance(item, dict) and item.get("review_id") == review_id
            ]
            if len(matches) != 1:
                raise RuntimeError(
                    "D1 read-after-write failed: unique review row was not returned."
                )
            item = matches[0]
            expected = {
                "user_id": user_id,
                "spawn_id": create_payload["spawn_id"],
                "anime_name": create_payload["anime_name"],
                "candidates": create_payload["candidates"],
                "status": "pending",
            }
            mismatches = [
                key for key, value in expected.items() if item.get(key) != value
            ]
            if mismatches:
                raise RuntimeError(
                    "D1 read-after-write returned mismatched fields: "
                    + ", ".join(mismatches)
                )
            print("PASS: unique row was read back from the Worker/D1 path.")
        finally:
            if created:
                try:
                    status, body = await _post(
                        client,
                        base_url,
                        secret,
                        {
                            "action": "reject",
                            "user_id": user_id,
                            "review_id": review_id,
                        },
                    )
                    if status == 200 and body.get("item", {}).get("status") == "rejected":
                        print("PASS: test row marked rejected (not pending).")
                    else:
                        print(
                            "WARNING: cleanup did not confirm rejection; "
                            f"HTTP {status}, error={body.get('error', 'unknown')}"
                        )
                except httpx.HTTPError:
                    print("WARNING: cleanup request failed; row will expire after 5 minutes.")

    print(json.dumps({
        "result": "preview_d1_round_trip_passed",
        "worker": base_url,
        "telegram_connected": False,
        "catch_executed": False,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
