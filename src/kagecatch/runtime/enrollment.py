"""Short-lived, per-user Telegram account enrollment.

OTP codes and 2FA passwords are passed directly to the client and are never
stored in challenge state, returned in results, or written to the session store.
The pending challenge itself is intentionally in-memory and expires quickly.
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from enum import Enum
from typing import Any, Callable, Protocol

from .session_store import SessionStore


class EnrollmentError(RuntimeError):
    """Base class for account enrollment failures."""


class EnrollmentPasswordRequired(EnrollmentError):
    """Telegram requires the account's 2FA password after the login code."""


class InvalidEnrollmentCode(EnrollmentError):
    """Telegram rejected the submitted login code."""


class InvalidEnrollmentPassword(EnrollmentError):
    """Telegram rejected the submitted 2FA password."""


class EnrollmentAttemptsExceeded(EnrollmentError):
    """The user exceeded the bounded number of credential attempts."""


class EnrollmentExpired(EnrollmentError):
    """The pending enrollment challenge expired."""


class EnrollmentInProgressError(EnrollmentError):
    """The user already has a pending enrollment challenge."""


class AccountOwnershipError(EnrollmentError):
    """The authorized Telegram account does not match the initiating user."""


class EnrollmentStatus(Enum):
    CODE_REQUIRED = "code_required"
    PASSWORD_REQUIRED = "password_required"
    ENROLLED = "enrolled"


@dataclass(frozen=True)
class EnrollmentResult:
    status: EnrollmentStatus
    message: str


class EnrollmentClient(Protocol):
    async def connect(self) -> None: ...

    async def request_code(self, phone_number: str) -> str: ...

    async def sign_in(
        self, phone_number: str, code: str, phone_code_hash: str
    ) -> int: ...

    async def check_password(self, password: str) -> int: ...

    def export_session(self) -> str: ...

    async def disconnect(self) -> None: ...


EnrollmentClientFactory = Callable[[int], EnrollmentClient]


@dataclass
class _Challenge:
    client: EnrollmentClient
    phone_number: str
    phone_code_hash: str
    expires_at: float
    attempts: int = 0
    password_required: bool = False


class EnrollmentService:
    """Coordinate a bounded enrollment flow, isolated by Telegram user ID."""

    _PHONE_PATTERN = re.compile(r"^\+[1-9][0-9]{7,14}$")

    def __init__(
        self,
        client_factory: EnrollmentClientFactory,
        session_store: SessionStore,
        *,
        ttl_seconds: float = 300,
        max_attempts: int = 3,
        clock: Callable[[], float] | None = None,
    ) -> None:
        if not callable(client_factory):
            raise TypeError("client_factory must be callable")
        if ttl_seconds <= 0:
            raise ValueError("ttl_seconds must be positive")
        if max_attempts <= 0:
            raise ValueError("max_attempts must be positive")
        import time

        self._client_factory = client_factory
        self._session_store = session_store
        self._ttl_seconds = ttl_seconds
        self._max_attempts = max_attempts
        self._clock = clock or time.monotonic
        self._challenges: dict[int, _Challenge] = {}
        self._locks: dict[int, asyncio.Lock] = {}

    @staticmethod
    def _validate_owner_id(owner_id: int) -> int:
        if isinstance(owner_id, bool) or not isinstance(owner_id, int) or owner_id <= 0:
            raise ValueError("owner_id must be a positive Telegram user ID")
        return owner_id

    def _lock_for(self, owner_id: int) -> asyncio.Lock:
        lock = self._locks.get(owner_id)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[owner_id] = lock
        return lock

    async def start(self, owner_id: int, phone_number: str) -> EnrollmentResult:
        owner_id = self._validate_owner_id(owner_id)
        if not isinstance(phone_number, str) or not self._PHONE_PATTERN.fullmatch(phone_number):
            raise ValueError("phone_number must use international E.164 format")

        async with self._lock_for(owner_id):
            existing = self._challenges.get(owner_id)
            if existing is not None and self._clock() >= existing.expires_at:
                await self._discard(owner_id)
                existing = None
            if existing is not None:
                raise EnrollmentInProgressError("an enrollment is already pending")

            client = self._client_factory(owner_id)
            try:
                await client.connect()
                phone_code_hash = await client.request_code(phone_number)
                if not isinstance(phone_code_hash, str) or not phone_code_hash:
                    raise EnrollmentError("Telegram did not return a valid code challenge")
                self._challenges[owner_id] = _Challenge(
                    client=client,
                    phone_number=phone_number,
                    phone_code_hash=phone_code_hash,
                    expires_at=self._clock() + self._ttl_seconds,
                )
            except BaseException:
                try:
                    await client.disconnect()
                except Exception:
                    pass
                raise

        return EnrollmentResult(
            EnrollmentStatus.CODE_REQUIRED,
            "کد ورود تلگرام را فقط در همین گفت‌وگوی خصوصی وارد کنید. این درخواست موقت است.",
        )

    async def submit_code(self, owner_id: int, code: str) -> EnrollmentResult:
        owner_id = self._validate_owner_id(owner_id)
        if not isinstance(code, str) or not re.fullmatch(r"[0-9]{3,10}", code):
            raise ValueError("code must contain only 3 to 10 digits")

        async with self._lock_for(owner_id):
            challenge = await self._get_live_challenge(owner_id)
            if challenge.password_required:
                raise EnrollmentError("the 2FA password is required for this challenge")
            try:
                account_id = await challenge.client.sign_in(
                    challenge.phone_number, code, challenge.phone_code_hash
                )
            except EnrollmentPasswordRequired:
                challenge.password_required = True
                return EnrollmentResult(
                    EnrollmentStatus.PASSWORD_REQUIRED,
                    "حساب رمز دومرحله‌ای دارد؛ رمز را فقط در همین گفت‌وگوی خصوصی وارد کنید.",
                )
            except InvalidEnrollmentCode:
                await self._record_failed_attempt(owner_id, challenge)
                raise

            await self._complete(owner_id, challenge, account_id)
            return EnrollmentResult(
                EnrollmentStatus.ENROLLED,
                "حساب تلگرام با موفقیت متصل شد.",
            )

    async def submit_password(self, owner_id: int, password: str) -> EnrollmentResult:
        owner_id = self._validate_owner_id(owner_id)
        if not isinstance(password, str) or not password:
            raise ValueError("password must not be empty")

        async with self._lock_for(owner_id):
            challenge = await self._get_live_challenge(owner_id)
            if not challenge.password_required:
                raise EnrollmentError("Telegram has not requested a 2FA password")
            try:
                account_id = await challenge.client.check_password(password)
            except InvalidEnrollmentPassword:
                await self._record_failed_attempt(owner_id, challenge)
                raise

            await self._complete(owner_id, challenge, account_id)
            return EnrollmentResult(
                EnrollmentStatus.ENROLLED,
                "حساب تلگرام با موفقیت متصل شد.",
            )

    async def cancel(self, owner_id: int) -> bool:
        owner_id = self._validate_owner_id(owner_id)
        async with self._lock_for(owner_id):
            if owner_id not in self._challenges:
                return False
            await self._discard(owner_id)
            return True

    async def _get_live_challenge(self, owner_id: int) -> _Challenge:
        challenge = self._challenges.get(owner_id)
        if challenge is None:
            raise EnrollmentExpired("there is no active enrollment challenge")
        if self._clock() >= challenge.expires_at:
            await self._discard(owner_id)
            raise EnrollmentExpired("the enrollment challenge has expired")
        return challenge

    async def _record_failed_attempt(
        self, owner_id: int, challenge: _Challenge
    ) -> None:
        challenge.attempts += 1
        if challenge.attempts >= self._max_attempts:
            await self._discard(owner_id)
            raise EnrollmentAttemptsExceeded("too many invalid enrollment attempts")

    async def _complete(
        self, owner_id: int, challenge: _Challenge, account_id: int
    ) -> None:
        if isinstance(account_id, bool) or account_id != owner_id:
            await self._discard(owner_id)
            raise AccountOwnershipError(
                "the connected Telegram account must match the initiating user"
            )
        session = challenge.client.export_session()
        if not isinstance(session, str) or not session:
            await self._discard(owner_id)
            raise EnrollmentError("Telegram returned an empty session")
        try:
            self._session_store.save(str(owner_id), session)
        except BaseException:
            await self._discard(owner_id)
            raise
        await self._discard(owner_id)

    async def _discard(self, owner_id: int) -> None:
        challenge = self._challenges.pop(owner_id, None)
        if challenge is not None:
            try:
                await challenge.client.disconnect()
            except Exception:
                # The challenge is already invalidated; never retain credentials
                # in memory merely because a transport close failed.
                pass


class TelethonEnrollmentClient:
    """Telethon implementation of the enrollment client contract."""

    def __init__(self, client: Any) -> None:
        self._client = client

    async def connect(self) -> None:
        await self._client.connect()

    async def request_code(self, phone_number: str) -> str:
        sent_code = await self._client.send_code_request(phone_number)
        return sent_code.phone_code_hash

    async def sign_in(
        self, phone_number: str, code: str, phone_code_hash: str
    ) -> int:
        from telethon.errors import (
            PhoneCodeExpiredError,
            PhoneCodeInvalidError,
            SessionPasswordNeededError,
        )

        try:
            await self._client.sign_in(
                phone=phone_number, code=code, phone_code_hash=phone_code_hash
            )
        except SessionPasswordNeededError as exc:
            raise EnrollmentPasswordRequired() from exc
        except (PhoneCodeInvalidError, PhoneCodeExpiredError) as exc:
            raise InvalidEnrollmentCode("Telegram rejected the login code") from exc
        user = await self._client.get_me()
        return int(user.id)

    async def check_password(self, password: str) -> int:
        from telethon.errors import PasswordHashInvalidError

        try:
            await self._client.sign_in(password=password)
        except PasswordHashInvalidError as exc:
            raise InvalidEnrollmentPassword("Telegram rejected the 2FA password") from exc
        user = await self._client.get_me()
        return int(user.id)

    def export_session(self) -> str:
        return self._client.session.save()

    async def disconnect(self) -> None:
        await self._client.disconnect()


class TelethonEnrollmentFactory:
    """Create a fresh, blank Telethon StringSession for each enrollment."""

    def __init__(
        self,
        *,
        api_id: int,
        api_hash: str,
        client_builder: Callable[[int, str], Any] | None = None,
    ) -> None:
        if not isinstance(api_id, int) or isinstance(api_id, bool) or api_id <= 0:
            raise ValueError("api_id must be a positive integer")
        if not isinstance(api_hash, str) or not api_hash.strip():
            raise ValueError("api_hash must not be empty")
        self._api_id = api_id
        self._api_hash = api_hash
        self._client_builder = client_builder or self._build_telethon_client

    @staticmethod
    def _build_telethon_client(api_id: int, api_hash: str) -> Any:
        try:
            from telethon import TelegramClient
            from telethon.sessions import StringSession
        except ImportError as exc:
            raise RuntimeError(
                "Telethon is required; install KageCatch with the telegram extra"
            ) from exc
        return TelegramClient(StringSession(), api_id, api_hash)

    def __call__(self, _owner_id: int) -> TelethonEnrollmentClient:
        client = self._client_builder(self._api_id, self._api_hash)
        return TelethonEnrollmentClient(client)
