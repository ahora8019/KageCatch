import asyncio

import pytest

from kagecatch.runtime.enrollment import (
    AccountOwnershipError,
    EnrollmentAttemptsExceeded,
    EnrollmentExpired,
    EnrollmentInProgressError,
    EnrollmentPasswordRequired,
    EnrollmentService,
    EnrollmentStatus,
    InvalidEnrollmentCode,
)


class FakeEnrollmentClient:
    def __init__(self, *, account_id=12345, password_required=False):
        self.account_id = account_id
        self.password_required = password_required
        self.connected = False
        self.disconnect_calls = 0
        self.code_hash = "opaque-code-hash"
        self.session = "private-session-value"
        self.accepted_code = "12345"
        self.accepted_password = "correct-password"

    async def connect(self):
        self.connected = True

    async def request_code(self, phone_number):
        self.phone_number = phone_number
        return self.code_hash

    async def sign_in(self, phone_number, code, phone_code_hash):
        if code != self.accepted_code:
            raise InvalidEnrollmentCode("invalid code")
        if self.password_required:
            raise EnrollmentPasswordRequired()
        return self.account_id

    async def check_password(self, password):
        if password != self.accepted_password:
            raise ValueError("invalid password")
        return self.account_id

    def export_session(self):
        return self.session

    async def disconnect(self):
        self.disconnect_calls += 1
        self.connected = False


class FakeSessionStore:
    def __init__(self):
        self.saved = {}

    def load(self, account_id):
        return self.saved.get(account_id)

    def save(self, account_id, session):
        self.saved[account_id] = session


@pytest.mark.asyncio
async def test_start_requests_code_without_returning_or_persisting_secrets():
    clients = []
    store = FakeSessionStore()

    def factory(_owner_id):
        client = FakeEnrollmentClient()
        clients.append(client)
        return client

    service = EnrollmentService(factory, store)
    result = await service.start(12345, "+989121234567")

    assert result.status is EnrollmentStatus.CODE_REQUIRED
    assert "12345" not in result.message
    assert store.saved == {}
    assert clients[0].connected is True


@pytest.mark.asyncio
async def test_valid_code_enrolls_only_the_requesting_telegram_account():
    client = FakeEnrollmentClient(account_id=12345)
    store = FakeSessionStore()
    service = EnrollmentService(lambda _owner_id: client, store)

    await service.start(12345, "+989121234567")
    result = await service.submit_code(12345, "12345")

    assert result.status is EnrollmentStatus.ENROLLED
    assert store.saved == {"12345": "private-session-value"}
    assert client.connected is False


@pytest.mark.asyncio
async def test_account_identity_mismatch_is_rejected_and_session_is_not_saved():
    client = FakeEnrollmentClient(account_id=99999)
    store = FakeSessionStore()
    service = EnrollmentService(lambda _owner_id: client, store)

    await service.start(12345, "+989121234567")

    with pytest.raises(AccountOwnershipError):
        await service.submit_code(12345, "12345")

    assert store.saved == {}
    assert client.connected is False


@pytest.mark.asyncio
async def test_two_factor_password_is_requested_only_after_telegram_requires_it():
    client = FakeEnrollmentClient(password_required=True)
    store = FakeSessionStore()
    service = EnrollmentService(lambda _owner_id: client, store)

    await service.start(12345, "+989121234567")
    result = await service.submit_code(12345, "12345")

    assert result.status is EnrollmentStatus.PASSWORD_REQUIRED
    assert store.saved == {}
    assert client.connected is True

    result = await service.submit_password(12345, "correct-password")

    assert result.status is EnrollmentStatus.ENROLLED
    assert store.saved == {"12345": "private-session-value"}
    assert client.connected is False


@pytest.mark.asyncio
async def test_wrong_code_is_bounded_and_disconnects_after_maximum_attempts():
    client = FakeEnrollmentClient()
    store = FakeSessionStore()
    service = EnrollmentService(
        lambda _owner_id: client, store, max_attempts=2
    )

    await service.start(12345, "+989121234567")

    with pytest.raises(InvalidEnrollmentCode):
        await service.submit_code(12345, "wrong")
    with pytest.raises(EnrollmentAttemptsExceeded):
        await service.submit_code(12345, "wrong")

    assert store.saved == {}
    assert client.connected is False


@pytest.mark.asyncio
async def test_expired_challenge_is_discarded_and_disconnected():
    now = [100.0]
    client = FakeEnrollmentClient()
    service = EnrollmentService(
        lambda _owner_id: client,
        FakeSessionStore(),
        ttl_seconds=30,
        clock=lambda: now[0],
    )

    await service.start(12345, "+989121234567")
    now[0] = 131.0

    with pytest.raises(EnrollmentExpired):
        await service.submit_code(12345, "12345")

    assert client.connected is False


@pytest.mark.asyncio
async def test_user_cannot_start_a_second_enrollment_while_one_is_pending():
    client = FakeEnrollmentClient()
    service = EnrollmentService(
        lambda _owner_id: client, FakeSessionStore()
    )

    await service.start(12345, "+989121234567")

    with pytest.raises(EnrollmentInProgressError):
        await service.start(12345, "+989121234567")


@pytest.mark.asyncio
async def test_cancel_disconnects_and_discards_pending_enrollment():
    client = FakeEnrollmentClient()
    service = EnrollmentService(
        lambda _owner_id: client, FakeSessionStore()
    )

    await service.start(12345, "+989121234567")
    assert await service.cancel(12345) is True
    assert client.connected is False
    assert await service.cancel(12345) is False


@pytest.mark.asyncio
async def test_non_e164_phone_number_is_rejected_before_creating_client():
    created = []
    service = EnrollmentService(
        lambda owner_id: created.append(owner_id) or FakeEnrollmentClient(),
        FakeSessionStore(),
    )

    with pytest.raises(ValueError):
        await service.start(12345, "09121234567")

    assert created == []
