"""Translate parsed self-control commands into user-facing responses."""

from dataclasses import dataclass

from .commands import CommandAction, SelfControlCommand, parse_command
from .service import ControlService
from .state import BotName, ControlState


_BOT_LABELS = {
    BotName.SENPAI: "سنپای",
    BotName.HENTA: "هنتا",
    BotName.CHARACTER: "کاراکتر",
}


@dataclass(frozen=True, slots=True)
class CommandResponse:
    """Result of handling one recognized command."""

    command: SelfControlCommand
    message: str
    state: ControlState


class CommandRouter:
    """Route parsed commands to the control service.

    The caller must perform Saved Messages/source authorization before invoking
    this router. Unknown text is ignored and does not allocate user state.
    """

    def __init__(self, service: ControlService | None = None) -> None:
        self.service = service or ControlService()

    def handle(self, user_id: str, text: str) -> CommandResponse | None:
        if not isinstance(user_id, str) or not user_id.strip():
            raise ValueError("user_id must not be empty")

        command = parse_command(text)
        if command is None:
            return None

        state = self.service.execute(user_id, command)
        return CommandResponse(
            command=command,
            message=self._message(command, state),
            state=state,
        )

    @staticmethod
    def _message(command: SelfControlCommand, state: ControlState) -> str:
        action = command.action
        if action is CommandAction.ENABLE_ALL:
            return "✅ Auto Catch عمومی روشن شد؛ بات‌ها باید جداگانه فعال شوند."
        if action is CommandAction.DISABLE_ALL:
            return "⏸️ Auto Catch متوقف شد. Listener برای دریافت دستورات روشن می‌ماند."
        if action in (CommandAction.ENABLE_BOT, CommandAction.DISABLE_BOT):
            bot = BotName(command.bot)
            label = _BOT_LABELS[bot]
            status = "روشن" if action is CommandAction.ENABLE_BOT else "خاموش"
            return f"{'✅' if status == 'روشن' else '⏸️'} بات {label} {status} شد."
        if action in (CommandAction.PANEL, CommandAction.STATUS):
            global_status = "روشن" if state.auto_catch_enabled else "خاموش"
            bots = "\n".join(
                f"• {_BOT_LABELS[bot]}: {'روشن' if enabled else 'خاموش'}"
                for bot, enabled in state.bot_enabled.items()
            )
            return f"پنل کنترل KageCatch\nAuto Catch: {global_status}\n{bots}"
        if action is CommandAction.BOTS:
            return "\n".join(
                f"• {_BOT_LABELS[bot]}: {'روشن' if enabled else 'خاموش'}"
                for bot, enabled in state.bot_enabled.items()
            )
        if action is CommandAction.HELP:
            return (
                "دستورات: .پنل، .روشن، .خاموش، .وضعیت، .آمار، .سهمیه، "
                ".بات‌ها، .راهنما و .روشن/خاموش سنپای|هنتا|کاراکتر"
            )
        if action is CommandAction.STATS:
            return "آمار Catch پس از پیاده‌سازی Catch Engine در دسترس خواهد بود."
        if action is CommandAction.QUOTA:
            return "مدیریت سهمیه در مرحلهٔ Quota پیاده‌سازی خواهد شد."
        return "دستور پشتیبانی نمی‌شود."
