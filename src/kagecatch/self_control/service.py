"""In-memory control service for isolated per-user command execution."""

from .commands import CommandAction, SelfControlCommand
from .state import BotName, ControlState


class ControlService:
    """Own one control state per Telegram account/user identifier."""

    def __init__(self) -> None:
        self._states: dict[str, ControlState] = {}

    @staticmethod
    def _validate_user_id(user_id: str) -> str:
        if not isinstance(user_id, str) or not user_id.strip():
            raise ValueError("user_id must not be empty")
        return user_id

    def has_user(self, user_id: str) -> bool:
        """Return whether a state already exists without creating one."""
        normalized = self._validate_user_id(user_id)
        return normalized in self._states

    def get_state(self, user_id: str) -> ControlState:
        """Get or create the state belonging only to this user."""
        normalized = self._validate_user_id(user_id)
        if normalized not in self._states:
            self._states[normalized] = ControlState(user_id=normalized)
        return self._states[normalized]

    def execute(
        self, user_id: str, command: SelfControlCommand
    ) -> ControlState:
        """Apply a parsed command; read-only commands leave state unchanged."""
        state = self.get_state(user_id)

        if command.action is CommandAction.ENABLE_ALL:
            state.enable_global()
        elif command.action is CommandAction.DISABLE_ALL:
            state.disable_global()
        elif command.action in (
            CommandAction.ENABLE_BOT,
            CommandAction.DISABLE_BOT,
        ):
            try:
                bot = BotName(command.bot) if command.bot is not None else None
            except ValueError as exc:
                raise ValueError(f"Unknown bot: {command.bot}") from exc
            if bot is None:
                raise ValueError("A bot is required for this command")
            if command.action is CommandAction.ENABLE_BOT:
                state.enable_bot(bot)
            else:
                state.disable_bot(bot)

        return state
