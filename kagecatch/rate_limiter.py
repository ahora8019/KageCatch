"""Conservative Telegram outbound guardrails; never intended to evade platform limits."""
from __future__ import annotations

import asyncio
import logging
import random
import time
from collections import deque
from collections.abc import Awaitable, Callable
from typing import Any

from telethon.errors import FloodWaitError

logger = logging.getLogger(__name__)


class OutboundCircuitOpen(RuntimeError):
    pass


class RateLimiter:
    def __init__(self, *, min_interval: float = 1.0, burst: int = 1,
                 flood_threshold: int = 3, flood_window: float = 3600,
                 cooldown: float = 21600, clock=time.monotonic,
                 sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
                 jitter: Callable[[], float] | None = None,
                 admin_alert: Callable[[str], Awaitable[None]] | None = None) -> None:
        if min_interval < 0 or burst < 1 or flood_threshold < 1 or flood_window <= 0 or cooldown <= 0:
            raise ValueError("invalid rate limiter configuration")
        self.min_interval = min_interval
        self.burst = burst
        self.flood_threshold = flood_threshold
        self.flood_window = flood_window
        self.cooldown = cooldown
        self._clock = clock
        self._sleep = sleep
        self._jitter = jitter or (lambda: random.uniform(0.5, 3.0))
        self._admin_alert = admin_alert
        self._lock = asyncio.Lock()
        self._last_sent = 0.0
        self._floods: deque[float] = deque()
        self._open_until = 0.0
        self._alerted = False

    @property
    def circuit_open(self) -> bool:
        return self._clock() < self._open_until

    async def before_send(self) -> None:
        async with self._lock:
            now = self._clock()
            while self._floods and now - self._floods[0] > self.flood_window:
                self._floods.popleft()
            if now < self._open_until:
                raise OutboundCircuitOpen("Telegram outbound circuit is paused")
            wait_for = max(0.0, self.min_interval - (now - self._last_sent))
            if wait_for:
                await self._sleep(wait_for)
            self._last_sent = self._clock()

    async def call(self, operation: Callable[..., Awaitable[Any]], *args: Any,
                   typing_action: Callable[[], Awaitable[Any]] | None = None,
                   **kwargs: Any) -> Any:
        await self.before_send()
        try:
            if typing_action is not None:
                await typing_action()
            delay = max(0.0, min(3.0, float(self._jitter())))
            if delay:
                await self._sleep(delay)
            return await operation(*args, **kwargs)
        except FloodWaitError as exc:
            await self._record_flood_wait(int(exc.seconds))
            raise

    async def _record_flood_wait(self, seconds: int) -> None:
        now = self._clock()
        async with self._lock:
            self._floods.append(now)
            while self._floods and now - self._floods[0] > self.flood_window:
                self._floods.popleft()
            wait_seconds = max(0, seconds) * 1.3
            if len(self._floods) >= self.flood_threshold:
                self._open_until = max(self._open_until, now + self.cooldown)
                if not self._alerted:
                    self._alerted = True
                    logger.critical("Telegram outbound circuit opened after repeated FloodWait responses")
                    if self._admin_alert is not None:
                        try:
                            await self._admin_alert("KageCatch: outbound Telegram actions paused for 6 hours after repeated FloodWait responses.")
                        except Exception as alert_error:
                            logger.error("admin alert failed (%s)", type(alert_error).__name__)
            else:
                logger.warning("Telegram FloodWait received; operation will not be retried automatically")
        if wait_seconds:
            await self._sleep(wait_seconds)

    async def ensure_available(self) -> None:
        if self.circuit_open:
            raise OutboundCircuitOpen("Telegram outbound circuit is paused")
