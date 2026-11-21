"""Durable D1-backed recognition queue accessed through the signed Control Worker API."""
from __future__ import annotations

import hashlib
import hmac
import json
import math
import re
import time
import uuid
from urllib.parse import urlsplit

import httpx

from .job_queue import IdempotencyConflictError, Job


class D1JobQueue:
    PATH = "/internal/job-queue"

    def __init__(self, base_url: str, secret: str, *, client: httpx.AsyncClient | None = None,
                 clock=time.time, nonce_factory=uuid.uuid4) -> None:
        parsed = urlsplit(base_url) if isinstance(base_url, str) else None
        loopback = bool(parsed and parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
                        and parsed.port and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment)
        if not parsed or (parsed.scheme != "https" and not loopback):
            raise ValueError("job queue URL must use HTTPS except for loopback development")
        if not isinstance(secret, str) or len(secret.encode()) < 32:
            raise ValueError("job queue secret must contain at least 32 bytes")
        self._base_url = base_url.rstrip("/")
        self._secret = secret.encode()
        self._client = client or httpx.AsyncClient(timeout=httpx.Timeout(10, connect=5), follow_redirects=False)
        self._owns_client = client is None
        self._clock, self._nonce_factory = clock, nonce_factory

    async def enqueue(self, job_type: str, payload: dict, *, priority: int = 0,
                      idempotency_key: str | None = None, max_attempts: int = 3,
                      run_after: float | None = None) -> Job:
        if not isinstance(job_type, str) or not job_type.strip() or len(job_type) > 128:
            raise ValueError("job_type must contain 1 to 128 characters")
        if not isinstance(payload, dict): raise ValueError("payload must be a JSON object")
        if isinstance(priority, bool) or not isinstance(priority, int): raise ValueError("priority must be an integer")
        if isinstance(max_attempts, bool) or not isinstance(max_attempts, int) or not 1 <= max_attempts <= 20:
            raise ValueError("max_attempts must be between 1 and 20")
        if idempotency_key is not None and (not isinstance(idempotency_key, str) or not idempotency_key.strip() or len(idempotency_key) > 256):
            raise ValueError("invalid idempotency_key")
        if run_after is not None and (isinstance(run_after, bool) or not isinstance(run_after, (int, float)) or not math.isfinite(float(run_after))):
            raise ValueError("run_after must be a finite timestamp")
        return self._job((await self._request({"action":"enqueue", "job_type":job_type.strip(), "payload":payload,
            "priority":priority, "idempotency_key":idempotency_key, "max_attempts":max_attempts, "run_after":run_after}, expected="job"))["job"])

    async def claim_next(self, worker_id: str, *, lease_seconds: float = 60, job_types=None) -> Job | None:
        if not isinstance(worker_id, str) or not worker_id.strip() or len(worker_id) > 128:
            raise ValueError("worker_id must contain 1 to 128 characters")
        if isinstance(lease_seconds, bool) or not isinstance(lease_seconds, (int,float)) or not math.isfinite(float(lease_seconds)) or not 1 <= lease_seconds <= 3600:
            raise ValueError("lease_seconds must be between 1 and 3600")
        if job_types is not None and (isinstance(job_types, (str,bytes)) or not isinstance(job_types, (list,tuple,set)) or not job_types or any(not isinstance(x,str) or not x.strip() or len(x)>128 for x in job_types)):
            raise ValueError("job_types must contain valid job type names")
        data = await self._request({"action":"claim", "worker_id":worker_id.strip(), "lease_seconds":lease_seconds,
                                    "job_types":list(job_types) if job_types is not None else None})
        return self._job(data["job"]) if data.get("job") is not None else None

    async def complete(self, job_id: str, worker_id: str, *, lease_generation: int) -> None:
        await self._transition("complete", job_id, worker_id, lease_generation)

    async def dead_letter(self, job_id: str, worker_id: str, *, lease_generation: int) -> None:
        await self._transition("dead_letter", job_id, worker_id, lease_generation)

    async def _transition(self, action: str, job_id: str, worker_id: str, lease_generation: int) -> None:
        self._validate_transition_inputs(job_id, worker_id, lease_generation)
        await self._request({"action":action, "job_id":job_id, "worker_id":worker_id, "lease_generation":lease_generation})

    @staticmethod
    def _validate_transition_inputs(job_id: str, worker_id: str, lease_generation: int) -> None:
        if not isinstance(job_id, str) or not job_id.strip() or len(job_id) > 128:
            raise ValueError("job_id must contain 1 to 128 characters")
        if not isinstance(worker_id, str) or not worker_id.strip() or len(worker_id) > 128:
            raise ValueError("worker_id must contain 1 to 128 characters")
        if isinstance(lease_generation, bool) or not isinstance(lease_generation, int) or lease_generation < 0:
            raise ValueError("lease_generation must be a non-negative integer")

    async def renew_lease(self, job_id: str, worker_id: str, *, lease_generation: int, lease_seconds: float = 60) -> float:
        self._validate_transition_inputs(job_id, worker_id, lease_generation)
        if isinstance(lease_seconds,bool) or not isinstance(lease_seconds,(int,float)) or not math.isfinite(float(lease_seconds)) or not 1 <= lease_seconds <= 3600:
            raise ValueError("lease_seconds must be between 1 and 3600")
        result = await self._request({"action":"renew", "job_id":job_id, "worker_id":worker_id,
                                      "lease_generation":lease_generation, "lease_seconds":lease_seconds})
        return float(result["lease_until"])

    async def fail(self, job_id: str, worker_id: str, *, lease_generation: int, retry_delay: float = 0) -> str:
        self._validate_transition_inputs(job_id, worker_id, lease_generation)
        if isinstance(retry_delay,bool) or not isinstance(retry_delay,(int,float)) or not math.isfinite(float(retry_delay)) or retry_delay < 0:
            raise ValueError("retry_delay must be a finite non-negative number")
        result = await self._request({"action":"fail", "job_id":job_id, "worker_id":worker_id,
                                      "lease_generation":lease_generation, "retry_delay":retry_delay})
        return result["status"]

    async def recover_expired(self) -> int:
        return int((await self._request({"action":"recover_expired"}))["recovered"])

    async def pending_count(self) -> int:
        return int((await self._request({"action":"count", "kind":"pending"}))["count"])

    async def dead_letter_count(self) -> int:
        return int((await self._request({"action":"count", "kind":"dead"}))["count"])

    async def close(self) -> None:
        if self._owns_client: await self._client.aclose()

    async def _request(self, payload: dict, *, expected: str | None = None) -> dict:
        body = json.dumps(payload, separators=(",",":"), ensure_ascii=True, allow_nan=False).encode()
        timestamp = str(int(self._clock()))
        nonce_value = self._nonce_factory()
        nonce = nonce_value.hex if hasattr(nonce_value,"hex") else str(nonce_value)
        nonce = nonce.replace("-","")
        if not re.fullmatch(r"[A-Za-z0-9_]{16,128}", nonce): raise ValueError("nonce factory returned an invalid nonce")
        text = f"{timestamp}\n{nonce}\nPOST\n{self.PATH}\n{hashlib.sha256(body).hexdigest()}"
        signature = hmac.new(self._secret,text.encode(),hashlib.sha256).hexdigest()
        response = await self._client.post(self._base_url+self.PATH, content=body, headers={
            "content-type":"application/json", "X-KageCatch-Timestamp":timestamp,
            "X-KageCatch-Nonce":nonce, "X-KageCatch-Signature":signature})
        if response.status_code == 409 and response.json().get("error") == "idempotency_conflict":
            raise IdempotencyConflictError("idempotency_key already belongs to a different job")
        if response.status_code in (401,403,409):
            response.raise_for_status()
        response.raise_for_status()
        data = response.json()
        if not isinstance(data,dict) or (expected and not isinstance(data.get(expected),dict)):
            raise RuntimeError("D1 job queue returned an invalid response")
        return data

    @staticmethod
    def _job(row: dict) -> Job:
        try:
            return Job(job_id=row["job_id"], job_type=row["job_type"], payload=row["payload"],
                priority=int(row["priority"]), status=row["status"], attempts=int(row["attempts"]),
                max_attempts=int(row["max_attempts"]), worker_id=row.get("worker_id"),
                lease_until=row.get("lease_until"), lease_generation=int(row["lease_generation"]))
        except (KeyError,TypeError,ValueError) as exc:
            raise RuntimeError("D1 job queue returned an invalid job") from exc
