"""Authenticated HTTP boundary between the Cloudflare Worker and Python Core.

Account identifiers are derived by the Worker from verified Telegram Mini App
initData and sent over HMAC-authenticated internal requests. Login codes and
2FA passwords are accepted only on these signed, non-logged request paths;
raw session material is never accepted from or returned to the Worker.
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
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
        "session_store_url_configured": bool(os.getenv("KAGECATCH_SESSION_STORE_URL")),
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
    if os.getenv("KAGECATCH_SESSION_STORE_URL"):
        from .d1_session_store import D1SessionStore
        store = D1SessionStore(
            os.environ["KAGECATCH_SESSION_STORE_URL"],
            os.getenv("KAGECATCH_CORE_SECRET", ""),
        )
    else:
        from .sqlite_session_store import SQLiteSessionStore
        store = SQLiteSessionStore(os.getenv("KAGECATCH_DB_PATH", "./data/kagecatch-sessions.sqlite3"))
    manager = SessionManager(fernet_key=fernet_key, store=store)
    factory = TelethonSessionClientFactory(api_id=int(api_id), api_hash=api_hash)
    from .telegram_selfbot import TelegramSelfbotController
    panel_requester = None
    panel_queue_url = os.getenv("KAGECATCH_PANEL_QUEUE_URL") or os.getenv("KAGECATCH_SESSION_STORE_URL")
    if panel_queue_url:
        from .panel_queue_client import PanelQueueClient
        panel_queue = PanelQueueClient(panel_queue_url, os.getenv("KAGECATCH_CORE_SECRET", ""))
        panel_requester = panel_queue.enqueue
    selfbot = TelegramSelfbotController(
        panel_image_url=os.getenv("KAGECATCH_PANEL_IMAGE_URL") or None,
        panel_requester=panel_requester,
    )
    runtime = SessionRuntime(
        session_manager=manager,
        client_factory=factory,
        handler_registrar=selfbot.attach,
    )
    runtime._selfbot_controller = selfbot
    runtime._panel_queue_client = panel_queue if panel_requester is not None else None
    from .telegram_auth_flow import TelegramAuthorizationFlow
    auth_flow = TelegramAuthorizationFlow(client_factory=lambda session_string="": factory(session_string), session_manager=manager)
    return manager, runtime, auth_flow


def create_app(
    *,
    core_secret: str | None = None,
    runtime=None,
    session_manager=None,
    auth_flow=None,
    nonce_store: NonceStore | None = None,
    clock=time.time,
    review_store=None,
    review_queue=None,
    review_pipeline=None,
    spawn_detector=None,
    character_resolver=None,
) -> FastAPI:
    secret = core_secret if core_secret is not None else os.getenv("KAGECATCH_CORE_SECRET", "")
    started_at_monotonic = time.monotonic()
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
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        try:
            await initialize_review_runtime()
            await restore_authorized_sessions()
            yield
        finally:
            await close_review_runtime()

    app = FastAPI(
        title="KageCatch Core",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    # Review persistence is an independent resource from Telegram sessions.
    # Construct the network client during startup, never at module import time.
    app.state.review_store = review_store
    app.state.review_queue = review_queue
    app.state.review_pipeline = review_pipeline

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

    async def initialize_review_runtime() -> None:
        if app.state.review_store is None:
            store_url = os.getenv("KAGECATCH_SESSION_STORE_URL", "").strip()
            store_secret = secret
            if store_url and store_secret:
                from .d1_manual_review_store import D1ManualReviewStore
                app.state.review_store = D1ManualReviewStore(store_url, store_secret)
        if app.state.review_queue is None and app.state.review_store is not None:
            from .persistent_manual_review_queue import PersistentManualReviewQueue
            app.state.review_queue = PersistentManualReviewQueue(store=app.state.review_store)
        if (
            app.state.review_pipeline is None
            and app.state.review_queue is not None
            and spawn_detector is not None
            and character_resolver is not None
        ):
            from .review_pipeline import ReviewPipeline
            app.state.review_pipeline = ReviewPipeline(
                detector=spawn_detector,
                resolver=character_resolver,
                review_queue=app.state.review_queue,
            )

        # Bind only after the review pipeline exists. SessionRuntime attaches
        # the controller to each authorized account, and its incoming callback
        # reads this handler dynamically.
        controller = getattr(runtime, "_selfbot_controller", None) if runtime is not None else None
        set_handler = getattr(controller, "set_incoming_handler", None)
        if app.state.review_pipeline is not None and callable(set_handler):
            async def process_incoming(user_id: str, event) -> None:
                await app.state.review_pipeline.process(event=event, user_id=user_id)
            set_handler(process_incoming)

    async def close_review_runtime() -> None:
        store = app.state.review_store
        close = getattr(store, "close", None) if store is not None else None
        if close is not None:
            try:
                await close()
            except Exception:
                logging.getLogger("kagecatch.core").exception(
                    "Manual review store shutdown failed"
                )
        panel_client = getattr(runtime, "_panel_queue_client", None) if runtime is not None else None
        panel_close = getattr(panel_client, "close", None)
        if panel_close is not None:
            try:
                await panel_close()
            except Exception:
                logging.getLogger("kagecatch.core").exception(
                    "Panel queue client shutdown failed"
                )

    async def restore_authorized_sessions() -> None:
        restore = getattr(runtime, "restore_saved_sessions", None) if runtime is not None else None
        if restore is None:
            return
        try:
            result = await restore()
            logging.getLogger("kagecatch.core").info(
                "Startup session restoration completed: connected=%s failed=%s",
                result.get("connected", 0),
                result.get("failed", 0),
            )
        except Exception:
            logging.getLogger("kagecatch.core").exception(
                "Startup session restoration could not enumerate saved sessions"
            )

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

    @app.get("/v1/owner/stats", dependencies=[Depends(require_core_auth)])
    async def owner_stats():
        if session_manager is None:
            raise HTTPException(status_code=503, detail="session_store_not_configured")
        list_user_ids = getattr(session_manager, "list_user_ids", None)
        if not callable(list_user_ids):
            raise HTTPException(status_code=503, detail="owner_stats_unavailable")
        try:
            # Core can count accounts with encrypted sessions. The Worker overlays
            # the authoritative registered-user count from its Durable Object registry.
            total_users = len(set(await list_user_ids()))
        except Exception as exc:
            raise HTTPException(status_code=503, detail="owner_stats_unavailable") from exc

        # CatchEngine has no persisted verified-result ledger yet and is not wired
        # into the live runtime; zero is the only verified count at this stage.
        return {
            "total_users": total_users,
            "active_sessions": int(getattr(runtime, "active_user_count", 0)),
            "total_catches": 0,
            "system_uptime_seconds": max(0, int(time.monotonic() - started_at_monotonic)),
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

    @app.get("/v1/accounts/{telegram_user_id}/info", dependencies=[Depends(require_core_auth)])
    async def account_info(telegram_user_id: int):
        if telegram_user_id <= 0 or telegram_user_id > (2**52 - 1):
            raise HTTPException(status_code=400, detail="invalid_telegram_user_id")
        if session_manager is None:
            raise HTTPException(status_code=503, detail="session_store_not_configured")

        user_id = str(telegram_user_id)
        saved_session = await session_manager.load_session(user_id)
        client = await runtime.get_client(user_id) if runtime is not None else None
        session_health = "unknown" if saved_session else "not_connected"
        phone_masked = None
        last_active = None

        if client is not None:
            authorization_check = getattr(client, "is_user_authorized", None)
            if callable(authorization_check):
                try:
                    authorized = await authorization_check()
                except Exception:
                    authorized = None
                if authorized is False:
                    session_health = "expired"
                elif authorized is True:
                    session_health = "valid"
                    get_me = getattr(client, "get_me", None)
                    if callable(get_me):
                        try:
                            account_user = await get_me()
                        except Exception:
                            account_user = None
                        if account_user is not None:
                            phone = getattr(account_user, "phone", None)
                            if isinstance(phone, str) and phone:
                                phone_masked = phone[:5] + "*" * max(0, len(phone) - 7) + phone[-2:] if len(phone) > 7 else "*" * len(phone)
                            user_status = getattr(account_user, "status", None)
                            was_online = getattr(user_status, "was_online", None)
                            if hasattr(was_online, "isoformat"):
                                last_active = was_online.isoformat()

        return {
            "telegram_user_id": telegram_user_id,
            "session_health": session_health,
            "phone_masked": phone_masked,
            "last_active": last_active,
        }

    @app.get("/v1/accounts/{telegram_user_id}/catch", dependencies=[Depends(require_core_auth)])
    async def catch_status(telegram_user_id: int):
        if telegram_user_id <= 0 or telegram_user_id > (2**52 - 1):
            raise HTTPException(status_code=400, detail="invalid_telegram_user_id")
        if runtime is None or await runtime.get_client(str(telegram_user_id)) is None:
            raise HTTPException(status_code=409, detail="telegram_account_not_connected")
        controller = getattr(runtime, "_selfbot_controller", None)
        if controller is None or not callable(getattr(controller, "is_enabled", None)):
            raise HTTPException(status_code=503, detail="catch_controller_not_configured")
        return {
            "telegram_user_id": telegram_user_id,
            "enabled": bool(controller.is_enabled(str(telegram_user_id))),
            "execution_ready": app.state.review_pipeline is not None,
        }

    @app.put("/v1/accounts/{telegram_user_id}/catch", dependencies=[Depends(require_core_auth)])
    async def set_catch_status(telegram_user_id: int, request: Request):
        if telegram_user_id <= 0 or telegram_user_id > (2**52 - 1):
            raise HTTPException(status_code=400, detail="invalid_telegram_user_id")
        if runtime is None or await runtime.get_client(str(telegram_user_id)) is None:
            raise HTTPException(status_code=409, detail="telegram_account_not_connected")
        controller = getattr(runtime, "_selfbot_controller", None)
        setter = getattr(controller, "set_enabled", None) if controller is not None else None
        if not callable(setter):
            raise HTTPException(status_code=503, detail="catch_controller_not_configured")
        try:
            payload = await request.json()
        except Exception as exc:
            raise HTTPException(status_code=400, detail="invalid_request") from exc
        enabled = payload.get("enabled") if isinstance(payload, dict) else None
        if not isinstance(enabled, bool):
            raise HTTPException(status_code=400, detail="enabled_boolean_required")
        result = bool(setter(str(telegram_user_id), enabled))
        return {
            "telegram_user_id": telegram_user_id,
            "enabled": result,
            "execution_ready": app.state.review_pipeline is not None,
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
