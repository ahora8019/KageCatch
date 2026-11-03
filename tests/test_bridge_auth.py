import hashlib
import hmac

import pytest

from kagecatch.runtime.bridge_auth import (
    BridgeAuthError,
    InMemoryReplayGuard,
    sign_bridge_request,
    verify_bridge_request,
)


SECRET = b"test-bridge-secret-with-sufficient-entropy"
BODY = b'{"action":"status"}'


def signed_headers(*, method="POST", path="/internal/v1/commands", body=BODY, timestamp=1_800_000_000, nonce="a" * 32):
    return sign_bridge_request(
        secret=SECRET,
        method=method,
        path=path,
        body=body,
        timestamp=timestamp,
        nonce=nonce,
    )


@pytest.mark.asyncio
async def test_accepts_valid_signed_request_and_reserves_nonce():
    guard = InMemoryReplayGuard()
    headers = signed_headers()

    await verify_bridge_request(
        secret=SECRET,
        method="POST",
        path="/internal/v1/commands",
        body=BODY,
        headers=headers,
        replay_guard=guard,
        now=1_800_000_000,
    )


@pytest.mark.asyncio
async def test_rejects_replayed_nonce():
    guard = InMemoryReplayGuard()
    headers = signed_headers()
    kwargs = dict(
        secret=SECRET,
        method="POST",
        path="/internal/v1/commands",
        body=BODY,
        headers=headers,
        replay_guard=guard,
        now=1_800_000_000,
    )
    await verify_bridge_request(**kwargs)
    with pytest.raises(BridgeAuthError, match="replay"):
        await verify_bridge_request(**kwargs)


@pytest.mark.asyncio
@pytest.mark.parametrize("tamper", ["method", "path", "body", "signature", "nonce", "timestamp"])
async def test_rejects_tampered_request(tamper):
    headers = signed_headers()
    method, path, body = "POST", "/internal/v1/commands", BODY
    if tamper == "method":
        method = "PUT"
    elif tamper == "path":
        path = "/internal/v1/other"
    elif tamper == "body":
        body = b'{"action":"catch"}'
    elif tamper == "signature":
        headers["X-KageCatch-Signature"] = "0" * 64
    elif tamper == "nonce":
        headers["X-KageCatch-Nonce"] = "b" * 32
    elif tamper == "timestamp":
        headers["X-KageCatch-Timestamp"] = "1800000001"

    with pytest.raises(BridgeAuthError):
        await verify_bridge_request(
            secret=SECRET,
            method=method,
            path=path,
            body=body,
            headers=headers,
            replay_guard=InMemoryReplayGuard(),
            now=1_800_000_000,
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("timestamp", [1_799_999_699, 1_800_000_301])
async def test_rejects_timestamp_outside_allowed_skew(timestamp):
    headers = signed_headers(timestamp=timestamp)
    with pytest.raises(BridgeAuthError, match="timestamp"):
        await verify_bridge_request(
            secret=SECRET,
            method="POST",
            path="/internal/v1/commands",
            body=BODY,
            headers=headers,
            replay_guard=InMemoryReplayGuard(),
            now=1_800_000_000,
            max_clock_skew_seconds=300,
        )


@pytest.mark.asyncio
async def test_rejects_malformed_headers_and_short_secrets():
    for headers in ({}, {"X-KageCatch-Timestamp": "x", "X-KageCatch-Nonce": "x", "X-KageCatch-Signature": "x"}):
        with pytest.raises(BridgeAuthError):
            await verify_bridge_request(
                secret=SECRET,
                method="POST",
                path="/internal/v1/commands",
                body=BODY,
                headers=headers,
                replay_guard=InMemoryReplayGuard(),
                now=1_800_000_000,
            )
    with pytest.raises(ValueError, match="32 bytes"):
        sign_bridge_request(
            secret=b"too-short",
            method="POST",
            path="/internal/v1/commands",
            body=BODY,
            timestamp=1_800_000_000,
            nonce="c" * 32,
        )


@pytest.mark.asyncio
async def test_concurrent_replay_attempts_allow_exactly_one_request():
    import asyncio

    guard = InMemoryReplayGuard()
    headers = signed_headers()
    async def verify():
        try:
            await verify_bridge_request(
                secret=SECRET,
                method="POST",
                path="/internal/v1/commands",
                body=BODY,
                headers=headers,
                replay_guard=guard,
                now=1_800_000_000,
            )
            return True
        except BridgeAuthError:
            return False

    results = await asyncio.gather(*(verify() for _ in range(10)))
    assert sum(results) == 1
