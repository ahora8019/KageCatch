"""Bounded, privacy-safe operational telemetry for the KageCatch Core process."""
from __future__ import annotations

from collections import deque
import logging
import re

RECENT_MONITOR_EVENTS = deque(maxlen=20)

_EVENT_MESSAGES = {
    "catch_success": "Catch completed and verified",
    "catch_failure": "Catch attempt failed or could not be verified",
    "flood_wait": "Telegram FloodWait encountered; request throttled",
    "session_reconnected": "Authorized Telegram session reconnected",
    "session_disconnected": "Telegram session disconnected",
}


class MonitorEventHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        try:
            event_type = getattr(record, "event_type", "log")
            if not isinstance(event_type, str) or not re.fullmatch(r"[a-z_]{1,40}", event_type):
                event_type = "log"
            message = record.getMessage()
            RECENT_MONITOR_EVENTS.append({
                "timestamp": int(record.created),
                "level": record.levelname if record.levelname in {"DEBUG", "INFO", "WARN", "WARNING", "ERROR", "CRITICAL"} else "INFO",
                "event_type": event_type,
                "message": str(message)[:240],
            })
        except Exception:
            self.handleError(record)


_handler = MonitorEventHandler()
_core_logger = logging.getLogger("kagecatch.core")
_core_logger.setLevel(logging.INFO)
_core_logger.addHandler(_handler)
_monitor_logger = logging.getLogger("kagecatch.monitor")
_monitor_logger.setLevel(logging.INFO)
_monitor_logger.propagate = False
_monitor_logger.addHandler(_handler)
_monitor_logger.info("Core monitoring initialized")


def emit_monitor_event(event_type: str, *, level: int = logging.INFO) -> bool:
    """Emit a bounded event using a fixed message; never include account/session identifiers."""
    message = _EVENT_MESSAGES.get(event_type)
    if message is None:
        return False
    _core_logger.log(level, message, extra={"event_type": event_type})
    return True
