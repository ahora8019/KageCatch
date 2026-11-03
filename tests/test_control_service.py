import pytest

from kagecatch.self_control import BotName, CommandAction, ControlService, CommandRouter


def test_control_service_creates_isolated_state_per_user():
    service = ControlService()

    first = service.get_state("user-1")
    second = service.get_state("user-2")

    service.execute("user-1", __import__("kagecatch.self_control", fromlist=["SelfControlCommand"]).SelfControlCommand(CommandAction.ENABLE_ALL))

    assert first.auto_catch_enabled is True
    assert second.auto_catch_enabled is False


def test_control_service_applies_global_and_per_bot_commands_without_implicit_enablement():
    service = ControlService()

    service.execute("user-1", __import__("kagecatch.self_control", fromlist=["SelfControlCommand"]).SelfControlCommand(CommandAction.ENABLE_ALL))
    state = service.get_state("user-1")

    assert state.auto_catch_enabled is True
    assert all(enabled is False for enabled in state.bot_enabled.values())

    service.execute("user-1", __import__("kagecatch.self_control", fromlist=["SelfControlCommand"]).SelfControlCommand(CommandAction.ENABLE_BOT, "senpai"))
    assert state.can_auto_catch(BotName.SENPAI) is True

    service.execute("user-1", __import__("kagecatch.self_control", fromlist=["SelfControlCommand"]).SelfControlCommand(CommandAction.DISABLE_ALL))
    assert state.auto_catch_enabled is False
    assert state.listener_connected is False


def test_control_service_rejects_unknown_bot_without_mutating_state():
    service = ControlService()
    state = service.get_state("user-1")

    with pytest.raises(ValueError, match="bot"):
        service.execute("user-1", __import__("kagecatch.self_control", fromlist=["SelfControlCommand"]).SelfControlCommand(CommandAction.ENABLE_BOT, "unknown"))

    assert state.auto_catch_enabled is False
    assert all(enabled is False for enabled in state.bot_enabled.values())


def test_router_executes_commands_and_returns_user_facing_feedback():
    router = CommandRouter()

    response = router.handle("user-1", ".روشن سنپای")

    assert response is not None
    assert response.command.action is CommandAction.ENABLE_BOT
    assert response.state.bot_enabled[BotName.SENPAI] is True
    assert "سنپای" in response.message


def test_router_global_off_keeps_listener_connected():
    router = CommandRouter()
    state = router.service.get_state("user-1")
    state.listener_connected = True
    router.handle("user-1", ".روشن")
    response = router.handle("user-1", ".خاموش")

    assert response is not None
    assert response.state.auto_catch_enabled is False
    assert response.state.listener_connected is True


def test_router_ignores_unknown_text_and_does_not_create_user_state():
    router = CommandRouter()

    assert router.handle("user-1", "سلام") is None
    assert router.service.has_user("user-1") is False


def test_router_reports_read_only_commands_without_enabling_catch():
    router = CommandRouter()

    response = router.handle("user-1", ".وضعیت")

    assert response is not None
    assert response.state.auto_catch_enabled is False
    assert "خاموش" in response.message


def test_router_rejects_blank_user_id():
    router = CommandRouter()

    with pytest.raises(ValueError, match="user_id"):
        router.handle("  ", ".روشن")
