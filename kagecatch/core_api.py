"""Authenticated HTTP boundary between the Cloudflare Worker and Python Core.

The API never accepts Telegram login codes, 2FA passwords, or raw sessions.
All account identifiers are derived by the Worker from verified Telegram
Mini App initData and are sent over an HMAC-authenticated internal request.
"""
from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import logging
import hmac
import os
import re
import time
from typing import Protocol

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse


class NonceStore(Protocol):
    async def claim(self, nonce: str, expires_at: float) -> bool: ...


class InMemoryNonceStore:
    """Single-process replay guard; use a shared store before multi-instance deploy."""

    def __init__(self, *, clock=time.time) -> None:
        self._clock = clock
        self._values: dict[str, float] = {}
        self._lock = asyncio.Lock()

    async def claim(self, nonce: str, expires_at: float) -> bool:
        async with self._lock:
            now = self._clock()
            self._values = {key: expiry for key, expiry in self._values.items() if expiry > now}
            if nonce in self._values:
                return False
            self._values[nonce] = expires_at
            return True



def _configuration_presence(core_secret: str | None = None) -> dict[str, bool]:
    """Return safe configuration presence flags without exposing secret values."""
    secret = core_secret if core_secret is not None else os.getenv("KAGECATCH_CORE_SECRET", "")
    return {
        "core_auth_configured": bool(secret),
        "telegram_api_id_configured": bool(os.getenv("KAGECATCH_API_ID")),
        "telegram_api_hash_configured": bool(os.getenv("KAGECATCH_API_HASH")),
        "session_encryption_key_configured": bool(os.getenv("KAGECATCH_FERNET_KEY")),
        "telethon_available": importlib.util.find_spec("telethon") is not None,
    }


def _configured_runtime():
    api_id = os.getenv("KAGECATCH_API_ID")
    api_hash = os.getenv("KAGECATCH_API_HASH")
    fernet_key = os.getenv("KAGECATCH_FERNET_KEY")
    if not all((api_id, api_hash, fernet_key)):
        return None, None, None

    from .session_manager import SessionManager
    from .session_runtime import SessionRuntime, TelethonSessionClientFactory
    from .sqlite_session_store import SQLiteSessionStore

    store = SQLiteSessionStore(os.getenv("KAGECATCH_DB_PATH", "./data/kagecatch-sessions.sqlite3"))
    manager = SessionManager(fernet_key=fernet_key, store=store)
    factory = TelethonSessionClientFactory(api_id=int(api_id), api_hash=api_hash)
    runtime = SessionRuntime(session_manager=manager, client_factory=factory)
    from .telegram_auth_flow import TelegramAuthorizationFlow
    auth_flow = TelegramAuthorizationFlow(client_factory=lambda: factory(""), session_manager=manager)
    return manager, runtime, auth_flow


def create_app(
    *,
    core_secret: str | None = None,
    runtime=None,
    session_manager=None,
    auth_flow=None,
    nonce_store: NonceStore | None = None,
    clock=time.time,
) -> FastAPI:
    secret = core_secret if core_secret is not None else os.getenv("KAGECATCH_CORE_SECRET", "")
    logging.getLogger("kagecatch.core").info("Core configuration presence: %s", _configuration_presence(secret))
    if secret and len(secret.encode("utf-8")) < 32:
        raise ValueError("KAGECATCH_CORE_SECRET must contain at least 32 bytes")

    if runtime is None and session_manager is None:
        configured_manager, configured_runtime, configured_auth_flow = _configured_runtime()
        session_manager = configured_manager
        runtime = configured_runtime
        auth_flow = configured_auth_flow
    elif session_manager is None and runtime is not None:
        session_manager = getattr(runtime, "_session_manager", None)

    replay_guard = nonce_store or InMemoryNonceStore(clock=clock)
    app = FastAPI(title="KageCatch Core", docs_url=None, redoc_url=None, openapi_url=None)

    async def require_core_auth(request: Request) -> None:
        if not secret:
            raise HTTPException(status_code=503, detail="core_auth_not_configured")
        timestamp_raw = request.headers.get("X-KageCatch-Timestamp", "")
        nonce = request.headers.get("X-KageCatch-Nonce", "")
        supplied = request.headers.get("X-KageCatch-Signature", "")
        if not timestamp_raw.isdigit() or not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", nonce):
            raise HTTPException(status_code=401, detail="invalid_auth_headers")
        if not re.fullmatch(r"[a-f0-9]{64}", supplied):
            raise HTTPException(status_code=401, detail="invalid_signature")
        timestamp = int(timestamp_raw)
        now = clock()
        if abs(now - timestamp) > 60:
            raise HTTPException(status_code=401, detail="request_expired")

        body = await request.body()
        if len(body) > 64 * 1024:
            raise HTTPException(status_code=413, detail="request_too_large")
        body_hash = hashlib.sha256(body).hexdigest()
        signing_text = f"{timestamp}\n{nonce}\n{request.method.upper()}\n{request.url.path}\n{body_hash}"
        expected = hmac.new(secret.encode("utf-8"), signing_text.encode("utf-8"), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, supplied):
            raise HTTPException(status_code=401, detail="invalid_signature")
        if not await replay_guard.claim(nonce, now + 120):
            raise HTTPException(status_code=409, detail="request_replayed")

    @app.get("/healthz")
    async def liveness():
        return {"service": "KageCatch Core", "status": "alive"}

    @app.get("/v1/health", dependencies=[Depends(require_core_auth)])
    async def core_health():
        if runtime is None or session_manager is None:
            return JSONResponse(
                status_code=503,
                content={"service": "KageCatch Core", "status": "degraded", "execution_configured": False, "active_clients": 0},
            )
        return {
            "service": "KageCatch Core",
            "status": "ready",
            "execution_configured": True,
            "active_clients": int(getattr(runtime, "active_user_count", 0)),
        }

    @app.get("/v1/accounts/{telegram_user_id}", dependencies=[Depends(require_core_auth)])
    async def account_status(telegram_user_id: int):
        if telegram_user_id <= 0 or telegram_user_id > (2**52 - 1):
            raise HTTPException(status_code=400, detail="invalid_telegram_user_id")
        if session_manager is None:
            raise HTTPException(status_code=503, detail="session_store_not_configured")
        user_id = str(telegram_user_id)
        saved_session = await session_manager.load_session(user_id)
        client = await runtime.get_client(user_id) if runtime is not None else None
        connected = client is not None
        session_saved = bool(saved_session)
        status = "connected" if connected else "authorized" if session_saved else "not_connected"
        return {
            "telegram_user_id": telegram_user_id,
            "status": status,
            "session_saved": session_saved,
            "connected": connected,
        }

    @app.post("/v1/accounts/{telegram_user_id}/connect", dependencies=[Depends(require_core_auth)])
    async def connect_account(telegram_user_id: int, request: Request):
        if telegram_user_id <= 0 or telegram_user_id > (2**52 - 1):
            raise HTTPException(status_code=400, detail="invalid_telegram_user_id")
        if auth_flow is None:
            raise HTTPException(status_code=503, detail="telegram_auth_flow_not_configured")
        try:
            payload = await request.json()
        except Exception as exc:
            raise HTTPException(status_code=400, detail="invalid_request") from exc
        phone = payload.get("phone") if isinstance(payload, dict) else None
        if not isinstance(phone, str):
            raise HTTPException(status_code=400, detail="phone_required")
        try:
            result = await auth_flow.start(user_id=str(telegram_user_id), phone=phone)
            return {"status": result}
        except RuntimeError as exc:
            if "already_authorized" in str(exc):
                return {"status": "already_authorized"}
            raise HTTPException(status_code=409, detail="authorization_already_pending") from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="invalid_phone") from exc
        except Exception as exc:
            raise HTTPException(status_code=502, detail="telegram_code_request_failed") from exc

    @app.post("/v1/accounts/{telegram_user_id}/connect/code", dependencies=[Depends(require_core_auth)])
    async def submit_connect_code(telegram_user_id: int, request: Request):
        if telegram_user_id <= 0 or telegram_user_id > (2**52 - 1):
            raise HTTPException(status_code=400, detail="invalid_telegram_user_id")
        if auth_flow is None:
            raise HTTPException(status_code=503, detail="telegram_auth_flow_not_configured")
        try:
            payload = await request.json()
        except Exception as exc:
            raise HTTPException(status_code=400, detail="invalid_request") from exc
        code = payload.get("code") if isinstance(payload, dict) else None
        if not isinstance(code, str) or not code.strip():
            raise HTTPException(status_code=400, detail="code_required")
        try:
            result = await auth_flow.submit_code(user_id=str(telegram_user_id), code=code)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail="authorization_not_pending") from exc
        except TimeoutError as exc:
            raise HTTPException(status_code=410, detail="authorization_expired") from exc
        except Exception as exc:
            raise HTTPException(status_code=400, detail="invalid_telegram_code") from exc
        if result == "connected" and runtime is not None:
            try:
                await runtime.connect_user(str(telegram_user_id))
            except Exception:
                return {"status": "authorized"}
        return {"status": result}

    @app.post("/v1/accounts/{telegram_user_id}/connect/password", dependencies=[Depends(require_core_auth)])
    async def submit_connect_password(telegram_user_id: int, request: Request):
        if telegram_user_id <= 0 or telegram_user_id > (2**52 - 1):
            raise HTTPException(status_code=400, detail="invalid_telegram_user_id")
        if auth_flow is None:
            raise HTTPException(status_code=503, detail="telegram_auth_flow_not_configured")
        try:
            payload = await request.json()
        except Exception as exc:
            raise HTTPException(status_code=400, detail="invalid_request") from exc
        password = payload.get("password") if isinstance(payload, dict) else None
        if not isinstance(password, str) or not password:
            raise HTTPException(status_code=400, detail="password_required")
        try:
            result = await auth_flow.submit_password(user_id=str(telegram_user_id), password=password)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail="authorization_not_pending") from exc
        except TimeoutError as exc:
            raise HTTPException(status_code=410, detail="authorization_expired") from exc
        except Exception as exc:
            raise HTTPException(status_code=400, detail="invalid_2fa_password") from exc
        if result == "connected" and runtime is not None:
            try:
                await runtime.connect_user(str(telegram_user_id))
            except Exception:
                return {"status": "authorized"}
        return {"status": result}

    @app.get("/v1/accounts/{telegram_user_id}/connect/status", dependencies=[Depends(require_core_auth)])
    async def connect_status(telegram_user_id: int):
        if telegram_user_id <= 0 or telegram_user_id > (2**52 - 1):
            raise HTTPException(status_code=400, detail="invalid_telegram_user_id")
        if auth_flow is None:
            raise HTTPException(status_code=503, detail="telegram_auth_flow_not_configured")
        status = await auth_flow.get_status(user_id=str(telegram_user_id))
        if status.get("status") == "connected" and runtime is not None:
            try:
                await runtime.connect_user(str(telegram_user_id))
            except Exception:
                return {"status": "authorized"}
        if status.get("status") == "not_pending" and session_manager is not None:
            saved = await session_manager.load_session(str(telegram_user_id))
            return {"status": "authorized" if saved else "not_connected"}
        return status

    @app.post("/v1/accounts/{telegram_user_id}/connect/cancel", dependencies=[Depends(require_core_auth)])
    async def cancel_connect(telegram_user_id: int):
        if telegram_user_id <= 0 or telegram_user_id > (2**52 - 1):
            raise HTTPException(status_code=400, detail="invalid_telegram_user_id")
        if auth_flow is None:
            raise HTTPException(status_code=503, detail="telegram_auth_flow_not_configured")
        await auth_flow.cancel(user_id=str(telegram_user_id))
        return {"status": "cancelled"}

    @app.post("/v1/accounts/{telegram_user_id}/reconnect", dependencies=[Depends(require_core_auth)])
    async def reconnect_account(telegram_user_id: int):
        if telegram_user_id <= 0 or telegram_user_id > (2**52 - 1):
            raise HTTPException(status_code=400, detail="invalid_telegram_user_id")
        if session_manager is None or runtime is None:
            raise HTTPException(status_code=503, detail="execution_runtime_not_configured")
        if not await session_manager.load_session(str(telegram_user_id)):
            raise HTTPException(status_code=404, detail="authorized_session_not_found")
        try:
            await runtime.connect_user(str(telegram_user_id))
        except PermissionError as exc:
            raise HTTPException(status_code=409, detail="reauthorization_required") from exc
        except Exception as exc:
            raise HTTPException(status_code=502, detail="telegram_connection_failed") from exc
        return {"telegram_user_id": telegram_user_id, "status": "connected"}

    @app.post("/v1/accounts/{telegram_user_id}/disconnect", dependencies=[Depends(require_core_auth)])
    async def disconnect_account(telegram_user_id: int):
        if telegram_user_id <= 0 or telegram_user_id > (2**52 - 1):
            raise HTTPException(status_code=400, detail="invalid_telegram_user_id")
        if runtime is None:
            raise HTTPException(status_code=503, detail="execution_runtime_not_configured")
        await runtime.disconnect_user(str(telegram_user_id))
        return {"telegram_user_id": telegram_user_id, "status": "disconnected"}

    @app.delete("/v1/accounts/{telegram_user_id}", dependencies=[Depends(require_core_auth)])
    async def revoke_account(telegram_user_id: int):
        if telegram_user_id <= 0 or telegram_user_id > (2**52 - 1):
            raise HTTPException(status_code=400, detail="invalid_telegram_user_id")
        if runtime is None:
            raise HTTPException(status_code=503, detail="execution_runtime_not_configured")
        await runtime.revoke_user(str(telegram_user_id))
        return {"telegram_user_id": telegram_user_id, "status": "revoked"}

    return app


app = create_app()
